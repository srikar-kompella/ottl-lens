/**
 * Convert OpenTelemetry Collector `debug` exporter output (verbosity: detailed)
 * back into OTLP JSON, so users can paste what is already in their terminal.
 *
 * Why: the documented way to test OTTL today is to run a collector with a debug
 * exporter and read `docker logs -f`. That text is the payload people have on hand.
 * Hand-writing OTLP JSON instead is where most first-time dry-runs stall.
 *
 * Format source of truth (collector core, exporter/debugexporter/internal/otlptext):
 *   logs.go / traces.go / metrics.go / databuffer.go
 * Key shapes:
 *   ResourceLog #0 · ResourceSpans #0 · ResourceMetrics #0      (record roots)
 *   Resource attributes:  then  "     -> key: Str(value)"        (typed values)
 *   span fields use "    %-15s: %s"  e.g. "    Kind           : Server"
 *   timestamps print as Go time.String():  "2026-09-21 12:53:20.25 +0000 UTC"
 *   values print as Type(AsString()):  Str(x) Int(5) Double(1.5) Bool(true)
 *                                      Map({json}) Slice([json]) Bytes(b64) Empty()
 *
 * Tolerated wrappers: the zap console prefix on the first line of each batch
 * ("2026-…\tinfo\tResourceLog #0"), docker-compose prefixes ("svc-1  | "),
 * summary lines between batches, and multi-line string values (stack traces).
 *
 * Not converted (reported as warnings): exponential histograms, summaries,
 * span links, exemplars, and entity refs.
 */

import type { Signal } from "./samples";

export interface DebugParseResult {
  ok: boolean;
  signal?: Signal;
  /** OTLP JSON object (not yet stringified). */
  payload?: Record<string, unknown>;
  /** Log records, spans, or metric datapoints converted. */
  records?: number;
  warnings: string[];
  error?: string;
}

type Json = Record<string, unknown>;
type KV = { key: string; value: Json };

const ROOT = /Resource(Log|Spans|Metrics) #\d+/;

const KEYS: Record<Signal, { resource: string; scope: string; item: string }> = {
  logs: { resource: "resourceLogs", scope: "scopeLogs", item: "logRecords" },
  traces: { resource: "resourceSpans", scope: "scopeSpans", item: "spans" },
  metrics: { resource: "resourceMetrics", scope: "scopeMetrics", item: "metrics" },
};

const SPAN_KIND: Record<string, number> = {
  Unspecified: 0, Internal: 1, Server: 2, Client: 3, Producer: 4, Consumer: 5,
};
const STATUS_CODE: Record<string, number> = { Unset: 0, Ok: 1, Error: 2 };
const TEMPORALITY: Record<string, number> = { Unspecified: 0, Delta: 1, Cumulative: 2 };

/* ------------------------------------------------------------------ *
 * Scalars
 * ------------------------------------------------------------------ */

/**
 * Go `time.Time.String()` → unix nanoseconds as a decimal string.
 * BigInt because nanosecond timestamps exceed Number's safe-integer range.
 */
export function goTimeToUnixNano(s: string): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))? ([+-])(\d{2})(\d{2})(?: \S+)?$/.exec(s.trim());
  if (!m) return undefined;
  const [, y, mo, d, h, mi, se, frac, sign, oh, om] = m;
  const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
  let ns = BigInt(ms) * 1_000_000n + BigInt((frac ?? "").padEnd(9, "0"));
  const offset = BigInt((+oh * 60 + +om) * 60) * 1_000_000_000n;
  ns = sign === "+" ? ns - offset : ns + offset;
  return ns.toString();
}

const TYPED = /^(Str|Int|Double|Bool|Map|Slice|Bytes|Empty)\(([\s\S]*)\)$/;
const TYPED_START = /^(?:Str|Int|Double|Bool|Map|Slice|Bytes|Empty)\(/;

/** Plain JSON (from a Map/Slice value) → OTLP AnyValue. */
export function rawToAnyValue(v: unknown): Json {
  if (v === null || v === undefined) return {};
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { boolValue: v };
  // Note: a double that happens to be integral (1.0) round-trips as an int here;
  // the debug exporter's JSON rendering does not preserve the distinction.
  if (typeof v === "number") return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(rawToAnyValue) } };
  return {
    kvlistValue: {
      values: Object.entries(v as Json).map(([key, x]) => ({ key, value: rawToAnyValue(x) })),
    },
  };
}

/** `Str(x)` / `Int(5)` / `Map({...})` … → OTLP AnyValue. */
export function typedToAnyValue(text: string, warnings: string[]): Json {
  const m = TYPED.exec(text);
  if (!m) return { stringValue: text };
  const [, type, inner] = m;
  switch (type) {
    case "Str":
      return { stringValue: inner };
    case "Int":
      return { intValue: inner.trim() };
    case "Double": {
      const n = Number(inner);
      if (Number.isFinite(n)) return { doubleValue: n };
      warnings.push(`Kept non-finite double "${inner}" as a string.`);
      return { stringValue: inner };
    }
    case "Bool":
      return { boolValue: inner.trim() === "true" };
    case "Bytes":
      return { bytesValue: inner };
    case "Empty":
      return {};
    default: // Map | Slice
      try {
        return rawToAnyValue(JSON.parse(inner));
      } catch {
        warnings.push(`Could not read a ${type} value as JSON; kept it as a string.`);
        return { stringValue: inner };
      }
  }
}

/* ------------------------------------------------------------------ *
 * Line handling
 * ------------------------------------------------------------------ */

/** zap appends the logger's fields after the message: {"otelcol.component.id": …} (newer) or {"kind": …} (older). */
const ZAP_FIELDS = /\t\{"(?:otelcol\.|kind"|data_type"|name").*\}$/;
const ZAP_FIELDS_LINE = /^\{"(?:otelcol\.|kind"|data_type"|name")/;

const STRUCTURAL: RegExp[] = [
  /^(ResourceLog|ResourceSpans|ResourceMetrics|ScopeLogs|ScopeSpans|ScopeMetrics|LogRecord|Span|Metric|SpanEvent|SpanLink|Exemplar|NumberDataPoints|HistogramDataPoints|ExponentialHistogramDataPoints|SummaryDataPoints) #\d+/,
  /^(Resource SchemaURL|Scope(Logs|Spans|Metrics) SchemaURL|Resource attributes|Resource entity refs|InstrumentationScope attributes|Attributes|Data point attributes|Events|Links|Exemplars|Descriptor|ObservedTimestamp|Timestamp|StartTimestamp|SeverityText|SeverityNumber|EventName|Body|Trace ID|Parent ID|Span ID|ID|Name|Kind|TraceState|Start time|End time|Status code|Status message|DroppedAttributesCount|DroppedEventsCount|DroppedLinksCount|Flags|Value|Count|Sum|Min|Max)\s*:/,
  /^(InstrumentationScope\b|ExplicitBounds #|Buckets #|Bucket [[(]|QuantileValue #)/,
  /^->/,
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, // the next zap log entry
  ZAP_FIELDS_LINE,                   // zap fields printed after the dump
];

function isStructural(line: string): boolean {
  const t = line.trimStart();
  return STRUCTURAL.some((r) => r.test(t));
}

/**
 * Normalize line endings and strip wrappers:
 *  - docker-compose prefixes ("checkout-1  | ")
 *  - collectors logging as JSON (service.telemetry.logs.encoding: json), where the
 *    whole dump is one JSON line with the text in "msg"
 *  - the zap console prefix before the first line of each dump
 */
function preprocess(text: string): string[] {
  const raw = text.replace(/\r\n?/g, "\n").split("\n");
  let compose: string | undefined;
  for (const l of raw) {
    if (ROOT.test(l)) {
      const m = /^([\w.-]+\s*\|\s?)/.exec(l);
      if (m) compose = m[1];
      break;
    }
  }
  return raw.flatMap((l) => {
    let line = compose && l.startsWith(compose) ? l.slice(compose.length) : l;
    const trimmed = line.trimStart();
    if (trimmed.startsWith("{") && ROOT.test(trimmed)) {
      try {
        const obj = JSON.parse(trimmed) as { msg?: unknown };
        if (typeof obj.msg === "string") {
          return obj.msg.replace(/\r\n?/g, "\n").split("\n").map((x) => x.replace(/\s+$/, ""));
        }
      } catch { /* not JSON — fall through */ }
    }
    const root = ROOT.exec(line);
    if (root && root.index > 0) line = line.slice(root.index);
    line = line.replace(ZAP_FIELDS, "");
    return [line.replace(/\s+$/, "")];
  });
}

/**
 * Read a typed value that may continue over several lines (e.g. a Str body
 * holding a stack trace). Continues until the next structural line.
 */
function readTypedValue(first: string, lines: string[], i: number): { text: string; next: number } {
  if (TYPED.test(first) || !TYPED_START.test(first)) return { text: first, next: i + 1 };
  let text = first;
  let j = i + 1;
  while (j < lines.length && !isStructural(lines[j])) {
    text += "\n" + lines[j];
    j++;
  }
  return { text: text.replace(/\s+$/, ""), next: j };
}

/* ------------------------------------------------------------------ *
 * Parser
 * ------------------------------------------------------------------ */

type Mode = "none" | "attrs" | "descriptor" | "event" | "skip";

export function looksLikeDebugOutput(text: string): boolean {
  return ROOT.test(text);
}

export function parseDebugText(text: string): DebugParseResult {
  const warnings: string[] = [];
  const lines = preprocess(text);

  let signal: Signal | undefined;
  let ignoring = false;
  let otherSignal: Signal | undefined;
  const resources: Json[] = [];

  let res: Json | undefined;
  let scope: Json | undefined;
  let rec: Json | undefined; // log record or span
  let metric: Json | undefined;
  let dp: Json | undefined;
  let event: Json | undefined;
  let mode: Mode = "none";
  let target: KV[] | undefined;
  let badTimestamps = 0;

  const ts = (s: string): string | undefined => {
    const v = goTimeToUnixNano(s);
    if (v === undefined && s.trim() !== "") badTimestamps++;
    return v === "0" ? undefined : v;
  };
  const ensureScope = (): Json => {
    if (!scope) {
      const k = KEYS[signal as Signal];
      scope = { scope: {}, [k.item]: [] };
      (res![k.scope] as Json[]).push(scope);
    }
    return scope;
  };
  const attrsOf = (o: Json): KV[] => {
    if (!Array.isArray(o.attributes)) o.attributes = [];
    return o.attributes as KV[];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();
    if (!t) { i++; continue; }
    let m: RegExpExecArray | null;

    // ---- resource root -------------------------------------------------
    if ((m = /^Resource(Log|Spans|Metrics) #\d+/.exec(t))) {
      const sig: Signal = m[1] === "Log" ? "logs" : m[1] === "Spans" ? "traces" : "metrics";
      if (!signal) signal = sig;
      if (sig !== signal) {
        otherSignal = sig;
        ignoring = true;
        i++;
        continue;
      }
      ignoring = false;
      res = { resource: { attributes: [] }, [KEYS[sig].scope]: [] };
      resources.push(res);
      scope = rec = metric = dp = event = undefined;
      mode = "none";
      i++;
      continue;
    }
    if (ignoring || !res || !signal) { i++; continue; }
    const k = KEYS[signal];

    // ---- resource / scope headers -------------------------------------
    if ((m = /^Resource SchemaURL:\s?(.*)$/.exec(t))) {
      if (m[1]) res.schemaUrl = m[1];
      mode = "none"; i++; continue;
    }
    if (t === "Resource attributes:") {
      mode = "attrs"; target = attrsOf(res.resource as Json); i++; continue;
    }
    if (t === "Resource entity refs:") { mode = "skip"; i++; continue; }
    if (/^Scope(Logs|Spans|Metrics) #\d+/.test(t)) {
      scope = { scope: {}, [k.item]: [] };
      (res[k.scope] as Json[]).push(scope);
      rec = metric = dp = event = undefined;
      mode = "none"; i++; continue;
    }
    if ((m = /^Scope(?:Logs|Spans|Metrics) SchemaURL:\s?(.*)$/.exec(t))) {
      if (m[1]) ensureScope().schemaUrl = m[1];
      mode = "none"; i++; continue;
    }
    if (t === "InstrumentationScope attributes:") {
      mode = "attrs"; target = attrsOf(ensureScope().scope as Json); i++; continue;
    }
    if (/^InstrumentationScope\b/.test(t)) {
      // "InstrumentationScope <name> <version>" — either part may be empty.
      let rest = line.trimStart().slice("InstrumentationScope".length);
      if (rest.startsWith(" ")) rest = rest.slice(1);
      const sp = rest.indexOf(" ");
      const name = sp === -1 ? rest : rest.slice(0, sp);
      const version = sp === -1 ? "" : rest.slice(sp + 1).trim();
      const sc = ensureScope().scope as Json;
      if (name) sc.name = name;
      if (version) sc.version = version;
      mode = "none"; i++; continue;
    }

    // ---- record starts --------------------------------------------------
    if (/^LogRecord #\d+/.test(t) || /^Span #\d+/.test(t)) {
      rec = {};
      (ensureScope()[k.item] as Json[]).push(rec);
      event = undefined;
      mode = "none"; i++; continue;
    }
    if (/^Metric #\d+/.test(t)) {
      metric = { name: "" };
      (ensureScope()[k.item] as Json[]).push(metric);
      dp = undefined;
      mode = "none"; i++; continue;
    }
    if (t === "Descriptor:") { mode = "descriptor"; i++; continue; }
    if ((m = /^(Number|Histogram|ExponentialHistogram|Summary)DataPoints #\d+/.exec(t))) {
      const container = metric && ((metric.gauge ?? metric.sum ?? metric.histogram) as Json | undefined);
      if (!metric || !container || m[1] === "ExponentialHistogram" || m[1] === "Summary") {
        dp = undefined;
        mode = "skip";
      } else {
        dp = {};
        (container.dataPoints as Json[]).push(dp);
        mode = "none";
      }
      i++; continue;
    }
    if (t === "Data point attributes:") {
      if (dp) { mode = "attrs"; target = attrsOf(dp); } else mode = "skip";
      i++; continue;
    }
    if (t === "Attributes:") {
      if (rec) { mode = "attrs"; target = attrsOf(rec); } else mode = "skip";
      i++; continue;
    }
    if (t === "Events:") { mode = "none"; i++; continue; }
    if (/^SpanEvent #\d+/.test(t)) {
      if (rec) {
        event = {};
        if (!Array.isArray(rec.events)) rec.events = [];
        (rec.events as Json[]).push(event);
        mode = "event";
      } else mode = "skip";
      i++; continue;
    }
    if (t === "Links:" || t === "Exemplars:" || /^SpanLink #\d+/.test(t) || /^Exemplar #\d+/.test(t)) {
      if (t === "Links:") warnings.push("Span links are not converted.");
      mode = "skip"; i++; continue;
    }

    // ---- arrow lines: typed attributes, descriptor fields, event fields --
    if ((m = /^->\s?(.*)$/.exec(t))) {
      const body = m[1];
      const typed = /^(.*?): ((?:Str|Int|Double|Bool|Map|Slice|Bytes|Empty)\([\s\S]*)$/.exec(body);
      if (typed && mode === "attrs" && target) {
        const { text: valueText, next } = readTypedValue(typed[2], lines, i);
        target.push({ key: typed[1], value: typedToAnyValue(valueText, warnings) });
        i = next; continue;
      }
      const field = /^(\w+):\s?(.*)$/.exec(body);
      if (metric && !dp && field && /^(Name|Description|Unit|DataType|IsMonotonic|AggregationTemporality)$/.test(field[1])) {
        const [, key, v] = field;
        if (key === "Name") metric.name = v;
        else if (key === "Description") { if (v) metric.description = v; }
        else if (key === "Unit") { if (v) metric.unit = v; }
        else if (key === "DataType") {
          if (v === "Gauge") metric.gauge = { dataPoints: [] };
          else if (v === "Sum") metric.sum = { dataPoints: [] };
          else if (v === "Histogram") metric.histogram = { dataPoints: [] };
          else metric.__unsupported = v;
        } else if (key === "IsMonotonic") {
          if (metric.sum) (metric.sum as Json).isMonotonic = v === "true";
        } else if (key === "AggregationTemporality") {
          const c = (metric.sum ?? metric.histogram) as Json | undefined;
          if (c) c.aggregationTemporality = TEMPORALITY[v] ?? 0;
        }
        mode = "descriptor"; i++; continue;
      }
      if (metric && !dp && body === "Metadata:") {
        metric.metadata = [];
        mode = "attrs"; target = metric.metadata as KV[]; i++; continue;
      }
      if (mode === "event" && event) {
        if (body === "Attributes::" || body === "Attributes:") {
          mode = "attrs"; target = attrsOf(event); i++; continue;
        }
        if (field?.[1] === "Name") event.name = field[2];
        else if (field?.[1] === "Timestamp") { const v = ts(field[2]); if (v) event.timeUnixNano = v; }
        else if (field?.[1] === "DroppedAttributesCount" && +field[2] > 0) event.droppedAttributesCount = +field[2];
      }
      i++; continue;
    }

    // ---- histogram series ----------------------------------------------
    if ((m = /^ExplicitBounds #\d+:\s?(.*)$/.exec(t))) {
      if (dp) {
        if (!Array.isArray(dp.explicitBounds)) dp.explicitBounds = [];
        (dp.explicitBounds as number[]).push(Number(m[1]));
      }
      i++; continue;
    }
    if ((m = /^Buckets #\d+, Count:\s?(\d+)$/.exec(t))) {
      if (dp) {
        if (!Array.isArray(dp.bucketCounts)) dp.bucketCounts = [];
        (dp.bucketCounts as string[]).push(m[1]);
      }
      i++; continue;
    }

    // ---- "Key: value" fields --------------------------------------------
    if ((m = /^([A-Za-z][A-Za-z ]*?)\s*:\s?(.*)$/.exec(t))) {
      const key = m[1];
      const v = m[2];
      mode = "none";

      if (signal === "logs" && rec) {
        switch (key) {
          case "ObservedTimestamp": { const x = ts(v); if (x) rec.observedTimeUnixNano = x; break; }
          case "Timestamp": { const x = ts(v); if (x) rec.timeUnixNano = x; break; }
          case "SeverityText": if (v) rec.severityText = v; break;
          case "SeverityNumber": { const n = /\((\d+)\)\s*$/.exec(v); if (n && +n[1] > 0) rec.severityNumber = +n[1]; break; }
          case "EventName": if (v) rec.eventName = v; break;
          case "Body": {
            const { text: bodyText, next } = readTypedValue(v, lines, i);
            rec.body = typedToAnyValue(bodyText, warnings);
            i = next; continue;
          }
          case "Trace ID": if (v) rec.traceId = v; break;
          case "Span ID": if (v) rec.spanId = v; break;
          case "Flags": if (+v > 0) rec.flags = +v; break;
        }
      } else if (signal === "traces" && rec) {
        switch (key) {
          case "Trace ID": if (v) rec.traceId = v; break;
          case "Parent ID": if (v) rec.parentSpanId = v; break;
          case "ID": if (v) rec.spanId = v; break;
          case "Name": rec.name = v; break;
          case "Kind": rec.kind = SPAN_KIND[v] ?? 0; break;
          case "TraceState": if (v) rec.traceState = v; break;
          case "Start time": { const x = ts(v); if (x) rec.startTimeUnixNano = x; break; }
          case "End time": { const x = ts(v); if (x) rec.endTimeUnixNano = x; break; }
          case "Status code": {
            const code = STATUS_CODE[v] ?? 0;
            if (code) rec.status = { ...(rec.status as Json | undefined), code };
            break;
          }
          case "Status message": if (v) rec.status = { ...(rec.status as Json | undefined), message: v }; break;
          case "DroppedAttributesCount": if (+v > 0) rec.droppedAttributesCount = +v; break;
          case "DroppedEventsCount": if (+v > 0) rec.droppedEventsCount = +v; break;
          case "DroppedLinksCount": if (+v > 0) rec.droppedLinksCount = +v; break;
        }
      } else if (signal === "metrics" && dp) {
        switch (key) {
          case "StartTimestamp": { const x = ts(v); if (x) dp.startTimeUnixNano = x; break; }
          case "Timestamp": { const x = ts(v); if (x) dp.timeUnixNano = x; break; }
          case "Value":
            // Ints print with %d, doubles with %f (always a decimal point).
            if (/^-?\d+$/.test(v)) dp.asInt = v;
            else if (Number.isFinite(Number(v))) dp.asDouble = Number(v);
            break;
          case "Count": dp.count = v; break;
          case "Sum": dp.sum = Number(v); break;
          case "Min": dp.min = Number(v); break;
          case "Max": dp.max = Number(v); break;
        }
      }
      i++; continue;
    }

    // Anything else (summary lines, bucket lines of unsupported types) is ignored.
    i++;
  }

  if (!signal) {
    const exporterSummary = /(Logs|Traces|Metrics)Exporter|"kind":\s*"exporter"|"resource (logs|spans|metrics)"/.test(text);
    return {
      ok: false,
      warnings,
      error: exporterSummary
        ? 'This looks like debug exporter output at basic/normal verbosity. Set `verbosity: detailed` on the debug exporter and paste again.'
        : "Couldn't find debug exporter output (expected lines like `ResourceLog #0`, `ResourceSpans #0` or `ResourceMetrics #0`).",
    };
  }

  // ---- finalize: drop unsupported metrics, prune empty attribute arrays ----
  const k = KEYS[signal];
  let records = 0;
  const skipped = new Map<string, number>();
  const prune = (o: Json) => {
    if (Array.isArray(o.attributes) && o.attributes.length === 0) delete o.attributes;
  };
  for (const r of resources) {
    prune(r.resource as Json);
    for (const s of r[k.scope] as Json[]) {
      prune(s.scope as Json);
      const items = s[k.item] as Json[];
      if (signal === "metrics") {
        s[k.item] = items.filter((mt) => {
          const bad = (mt.__unsupported as string | undefined) ?? (mt.gauge || mt.sum || mt.histogram ? undefined : "Empty");
          if (bad) { skipped.set(bad, (skipped.get(bad) ?? 0) + 1); return false; }
          return true;
        });
        for (const mt of s[k.item] as Json[]) {
          const c = (mt.gauge ?? mt.sum ?? mt.histogram) as Json;
          for (const p of c.dataPoints as Json[]) { prune(p); records++; }
        }
      } else {
        for (const it of items) {
          prune(it);
          for (const ev of (it.events as Json[] | undefined) ?? []) prune(ev);
          records++;
        }
      }
    }
  }

  for (const [type, n] of skipped) {
    warnings.push(`Skipped ${n} ${type} metric${n === 1 ? "" : "s"} — only gauge, sum and histogram are converted.`);
  }
  if (otherSignal) {
    warnings.push(`The paste also contained ${otherSignal} output; only the first signal (${signal}) was converted.`);
  }
  if (badTimestamps > 0) {
    warnings.push(`${badTimestamps} timestamp${badTimestamps === 1 ? "" : "s"} could not be read and were left out.`);
  }
  if (records === 0) {
    return { ok: false, signal, warnings, error: `Found ${signal} headers but no complete records to convert.` };
  }

  return { ok: true, signal, payload: { [k.resource]: resources }, records, warnings: dedupe(warnings) };
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}
