/**
 * Present raw OTLP-JSON diffs in the language the user wrote: OTTL paths.
 *
 *   resourceLogs[0].scopeLogs[0].logRecords[0].attributes["env"].value.stringValue
 *     →  log.attributes["env"]
 *
 * and values as OTTL literals ("production", 500, true) instead of AnyValue
 * wrappers. A value whose type changed (string "500" → int 500) is reported as
 * one change with the type transition, since silent type conversion is a common
 * source of OTTL bugs.
 *
 * When a payload holds several records, each label gets a locator such as
 * "(log #2)" so the user knows which record changed.
 */

import type { DiffEntry } from "./trace";

export interface PresentedDiff {
  kind: "added" | "removed" | "changed";
  /** OTTL-style path, e.g. log.attributes["env"] (plus a record locator if needed). */
  label: string;
  /** Value text: `"x"` for added/removed, `"a" → "b"` for changed. */
  text: string;
}

type Token = { t: "name"; v: string } | { t: "index"; v: number } | { t: "key"; v: string };

const ANY_KINDS = new Set([
  "stringValue", "intValue", "doubleValue", "boolValue", "bytesValue", "kvlistValue", "arrayValue",
]);
const KIND_LABEL: Record<string, string> = {
  stringValue: "string", intValue: "int", doubleValue: "double", boolValue: "bool",
  bytesValue: "bytes", kvlistValue: "map", arrayValue: "slice",
};

const ROOTS: Record<string, { scope: string; item: string; ctx: string }> = {
  resourceLogs: { scope: "scopeLogs", item: "logRecords", ctx: "log" },
  resourceSpans: { scope: "scopeSpans", item: "spans", ctx: "span" },
  resourceMetrics: { scope: "scopeMetrics", item: "metrics", ctx: "metric" },
};
const METRIC_TYPES = new Set(["gauge", "sum", "histogram", "exponentialHistogram", "summary"]);

export function tokenize(path: string): Token[] | undefined {
  const re = /\.?([A-Za-z_]\w*)|\[(\d+)\]|\[("(?:[^"\\]|\\.)*")\]/gy;
  const out: Token[] = [];
  let m: RegExpExecArray | null;
  let pos = 0;
  while (pos < path.length) {
    re.lastIndex = pos;
    m = re.exec(path);
    if (!m) return undefined;
    if (m[1] !== undefined) out.push({ t: "name", v: m[1] });
    else if (m[2] !== undefined) out.push({ t: "index", v: Number(m[2]) });
    else out.push({ t: "key", v: JSON.parse(m[3]) as string });
    pos = re.lastIndex;
  }
  return out;
}

const snake = (s: string) => s.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());

/** Record ordinals (1-based, in payload order) for locators. */
export interface Ordinals {
  resources: number;
  scopes: Map<string, number>;   // "i.j"
  items: Map<string, number>;    // "i.j.k"
  points: Map<string, number>;   // "i.j.k.d" (metrics datapoints)
}

export function computeOrdinals(payload: unknown): Ordinals {
  const ord: Ordinals = { resources: 0, scopes: new Map(), items: new Map(), points: new Map() };
  if (typeof payload !== "object" || payload === null) return ord;
  const p = payload as Record<string, unknown>;
  const rootKey = Object.keys(ROOTS).find((k) => Array.isArray(p[k]));
  if (!rootKey) return ord;
  const { scope, item } = ROOTS[rootKey];
  const arr = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? v : []);
  let s = 0, n = 0, d = 0;
  arr(p[rootKey]).forEach((r, i) => {
    ord.resources++;
    arr(r[scope]).forEach((sc, j) => {
      ord.scopes.set(`${i}.${j}`, ++s);
      arr(sc[item]).forEach((it, k) => {
        ord.items.set(`${i}.${j}.${k}`, ++n);
        for (const t of METRIC_TYPES) {
          const c = it[t] as Record<string, unknown> | undefined;
          if (c) arr(c.dataPoints).forEach((_dp, x) => ord.points.set(`${i}.${j}.${k}.${x}`, ++d));
        }
      });
    });
  });
  return ord;
}

export interface Label {
  label: string;
  /** The AnyValue kind at the leaf, if the path ended inside one (e.g. "intValue"). */
  leafKind?: string;
}

/** OTLP JSON diff path → OTTL-style label. Falls back to the raw path if unrecognised. */
export function ottlLabel(path: string, ord?: Ordinals): Label {
  const tokens = tokenize(path);
  if (!tokens || tokens.length < 2 || tokens[0].t !== "name" || !ROOTS[tokens[0].v] || tokens[1].t !== "index") {
    return { label: path };
  }
  const root = ROOTS[tokens[0].v];
  const i = tokens[1].v;
  let pos = 2;
  let ctx: string;
  let locator: string | undefined;
  const name = (k: number) => (tokens[k]?.t === "name" ? (tokens[k] as { v: string }).v : undefined);
  const index = (k: number) => (tokens[k]?.t === "index" ? (tokens[k] as { v: number }).v : undefined);

  if (name(pos) === "resource") {
    ctx = "resource";
    pos++;
    if (ord && ord.resources > 1) locator = `resource #${i + 1}`;
  } else if (name(pos) === "schemaUrl") {
    return { label: "resource.schema_url" + (ord && ord.resources > 1 ? ` (resource #${i + 1})` : "") };
  } else if (name(pos) === root.scope && index(pos + 1) !== undefined) {
    const j = index(pos + 1)!;
    pos += 2;
    if (name(pos) === "scope" || name(pos) === "schemaUrl") {
      ctx = "instrumentation_scope";
      if (name(pos) === "scope") pos++;
      if (ord && ord.scopes.size > 1) locator = `scope #${ord.scopes.get(`${i}.${j}`) ?? "?"}`;
    } else if (name(pos) === root.item && index(pos + 1) !== undefined) {
      const k = index(pos + 1)!;
      pos += 2;
      ctx = root.ctx;
      const itemOrd = ord?.items.get(`${i}.${j}.${k}`);
      if (ord && ord.items.size > 1) locator = `${root.ctx} #${itemOrd ?? "?"}`;

      if (root.ctx === "span" && name(pos) === "events" && index(pos + 1) !== undefined) {
        const e = index(pos + 1)!;
        pos += 2;
        ctx = "spanevent";
        locator = (ord && ord.items.size > 1 ? `span #${itemOrd ?? "?"}, ` : "") + `event #${e + 1}`;
      } else if (root.ctx === "metric" && METRIC_TYPES.has(name(pos) ?? "") && name(pos + 1) === "dataPoints" && index(pos + 2) !== undefined) {
        const x = index(pos + 2)!;
        pos += 3;
        ctx = "datapoint";
        locator = ord && ord.points.size > 1 ? `datapoint #${ord.points.get(`${i}.${j}.${k}.${x}`) ?? "?"}` : undefined;
      }
    } else {
      return { label: path };
    }
  } else {
    return { label: path };
  }

  // Render the remainder as an OTTL path, unwrapping OTLP's AnyValue containers.
  let out = ctx;
  let leafKind: string | undefined;
  for (let k = pos; k < tokens.length; k++) {
    const tok = tokens[k];
    if (tok.t === "key") { out += `[${JSON.stringify(tok.v)}]`; continue; }
    if (tok.t === "index") { out += `[${tok.v}]`; continue; }
    const v = tok.v;
    if (v === "value" && tokens[k - 1]?.t === "key") continue;           // attributes["k"].value
    if (ANY_KINDS.has(v)) {
      leafKind = v;
      if ((v === "kvlistValue" || v === "arrayValue") && name(k + 1) === "values") k++; // …values[…]
      continue;
    }
    if (ctx === "datapoint" && v === "asDouble") { out += ".value_double"; continue; }
    if (ctx === "datapoint" && v === "asInt") { out += ".value_int"; continue; }
    out += "." + snake(v);
  }
  return { label: locator ? `${out}  (${locator})` : out, leafKind };
}

/* ------------------------------------------------------------------ *
 * Values
 * ------------------------------------------------------------------ */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** AnyValue → plain JS, for compact display of maps and slices. */
function anyToRaw(v: unknown): unknown {
  if (!isRecord(v)) return v;
  if ("stringValue" in v) return v.stringValue;
  if ("intValue" in v) return Number(v.intValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("boolValue" in v) return v.boolValue;
  if ("bytesValue" in v) return `bytes(${String(v.bytesValue)})`;
  if (isRecord(v.kvlistValue)) {
    const vals = Array.isArray(v.kvlistValue.values) ? v.kvlistValue.values : [];
    return Object.fromEntries(
      (vals as Array<Record<string, unknown>>).map((kv) => [String(kv.key), anyToRaw(kv.value)])
    );
  }
  if (isRecord(v.arrayValue)) {
    const vals = Array.isArray(v.arrayValue.values) ? v.arrayValue.values : [];
    return (vals as unknown[]).map(anyToRaw);
  }
  return v;
}

function truncate(s: string, n = 100): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** Which AnyValue kind a value is, if any (unwrapping a {key, value} pair). */
export function kindOf(v: unknown): string | undefined {
  const inner = isRecord(v) && "key" in v && "value" in v ? v.value : v;
  if (!isRecord(inner)) return undefined;
  const keys = Object.keys(inner);
  if (keys.length === 0) return "empty";
  return keys.find((k) => ANY_KINDS.has(k));
}

/** Render a diff value as an OTTL-ish literal. */
export function displayValue(v: unknown, leafKind?: string): string {
  if (v === undefined) return "nil";
  // A whole attribute ({key, value}) or a bare AnyValue.
  const inner = isRecord(v) && "key" in v && "value" in v ? v.value : v;
  if (isRecord(inner)) {
    const kind = kindOf(inner);
    if (kind === "empty") return "nil";
    if (kind === "stringValue") return JSON.stringify(inner.stringValue);
    if (kind) return truncate(JSON.stringify(anyToRaw(inner)));
    return truncate(JSON.stringify(inner));
  }
  if (leafKind === "stringValue") return JSON.stringify(inner);
  if (leafKind === "intValue") return String(inner);
  if (typeof inner === "string") return JSON.stringify(inner);
  return truncate(JSON.stringify(inner));
}

/* ------------------------------------------------------------------ *
 * Presentation
 * ------------------------------------------------------------------ */

/**
 * Turn raw diff entries into OTTL-language lines. A removed+added pair on the
 * same path (which is how a type change looks in OTLP JSON) is merged into one
 * "changed" line that names the type transition.
 */
export function presentDiff(diff: DiffEntry[], before: unknown): PresentedDiff[] {
  const ord = computeOrdinals(before);
  const rows = diff.map((d) => {
    const { label, leafKind } = ottlLabel(d.path, ord);
    return { d, label, leafKind };
  });

  const out: PresentedDiff[] = [];
  for (let n = 0; n < rows.length; n++) {
    const { d, label, leafKind } = rows[n];
    const next = rows[n + 1];
    if (
      next && next.label === label &&
      ((d.kind === "removed" && next.d.kind === "added") || (d.kind === "added" && next.d.kind === "removed"))
    ) {
      const removed = d.kind === "removed" ? rows[n] : next;
      const added = d.kind === "removed" ? next : rows[n];
      const bKind = removed.leafKind ?? kindOf(removed.d.before);
      const aKind = added.leafKind ?? kindOf(added.d.after);
      const from = displayValue(removed.d.before, removed.leafKind);
      const to = displayValue(added.d.after, added.leafKind);
      const typeNote = bKind && aKind && bKind !== aKind && KIND_LABEL[bKind] && KIND_LABEL[aKind]
        ? `  (${KIND_LABEL[bKind]} → ${KIND_LABEL[aKind]})`
        : "";
      out.push({ kind: "changed", label, text: `${from} → ${to}${typeNote}` });
      n++;
      continue;
    }
    if (d.kind === "added") out.push({ kind: "added", label, text: displayValue(d.after, leafKind) });
    else if (d.kind === "removed") out.push({ kind: "removed", label, text: displayValue(d.before, leafKind) });
    else out.push({ kind: "changed", label, text: `${displayValue(d.before, leafKind)} → ${displayValue(d.after, leafKind)}` });
  }
  return out;
}
