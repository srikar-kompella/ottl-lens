/**
 * Accept whatever the user pastes (or loads from a file) and turn it into a
 * single OTLP JSON payload plus the signal it belongs to.
 *
 * Accepted inputs, tried in order:
 *   1. OTLP JSON                    — used as-is (formatting preserved)
 *   2. JSON Lines                   — e.g. the file exporter's output; merged
 *   3. debug exporter text          — converted (see debugText.ts)
 *
 * The signal always comes from the content, never from the dropdown, so a
 * traces payload can't silently run through the logs engine.
 */

import type { Signal } from "./samples";
import { looksLikeDebugOutput, parseDebugText } from "./debugText";

export type PayloadSource = "json" | "jsonl" | "debug";

export interface PayloadInput {
  ok: boolean;
  /** OTLP JSON text ready for the engine. */
  json?: string;
  signal?: Signal;
  source?: PayloadSource;
  /** Log records, spans, or metric datapoints. */
  records?: number;
  warnings: string[];
  error?: string;
}

const ROOT_KEYS: Array<[Signal, string[]]> = [
  ["logs", ["resourceLogs", "resource_logs"]],
  ["traces", ["resourceSpans", "resource_spans"]],
  ["metrics", ["resourceMetrics", "resource_metrics"]],
];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Which OTLP signal a parsed payload is, from its top-level key. */
export function detectSignal(obj: unknown): Signal | undefined {
  if (!isObject(obj)) return undefined;
  for (const [signal, keys] of ROOT_KEYS) {
    if (keys.some((k) => Array.isArray(obj[k]))) return signal;
  }
  return undefined;
}

function rootArray(obj: Record<string, unknown>, signal: Signal): unknown[] {
  const keys = ROOT_KEYS.find(([s]) => s === signal)![1];
  for (const k of keys) if (Array.isArray(obj[k])) return obj[k] as unknown[];
  return [];
}

/** Count log records / spans / datapoints in an OTLP JSON payload. */
export function countRecords(obj: unknown, signal: Signal): number {
  if (!isObject(obj)) return 0;
  const arr = <T = Record<string, unknown>>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  let n = 0;
  for (const r of rootArray(obj, signal) as Array<Record<string, unknown>>) {
    const scopes =
      signal === "logs" ? arr(r.scopeLogs ?? r.scope_logs)
      : signal === "traces" ? arr(r.scopeSpans ?? r.scope_spans)
      : arr(r.scopeMetrics ?? r.scope_metrics);
    for (const s of scopes) {
      if (signal === "logs") n += arr(s.logRecords ?? s.log_records).length;
      else if (signal === "traces") n += arr(s.spans).length;
      else {
        for (const m of arr(s.metrics)) {
          const c = (m.gauge ?? m.sum ?? m.histogram ?? m.exponentialHistogram ?? m.summary) as
            Record<string, unknown> | undefined;
          n += arr(c?.dataPoints ?? c?.data_points).length;
        }
      }
    }
  }
  return n;
}

const SIGNAL_ROOT: Record<Signal, string> = {
  logs: "resourceLogs",
  traces: "resourceSpans",
  metrics: "resourceMetrics",
};

export function normalizePayloadInput(text: string): PayloadInput {
  const warnings: string[] = [];
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: false, warnings, error: "The payload is empty. Pick a sample, paste OTLP JSON, or paste debug exporter output." };
  }

  // 1. A single JSON document.
  let jsonError: string | undefined;
  try {
    const obj = JSON.parse(trimmed) as unknown;
    const signal = detectSignal(obj);
    if (!signal) {
      return {
        ok: false,
        warnings,
        error: "This JSON isn't an OTLP payload — expected resourceLogs, resourceSpans or resourceMetrics at the top level.",
      };
    }
    return { ok: true, json: text, signal, source: "json", records: countRecords(obj, signal), warnings };
  } catch (e) {
    jsonError = e instanceof Error ? e.message : String(e);
  }

  // 2. JSON Lines (one OTLP export request per line).
  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length > 1 && lines.every((l) => l.startsWith("{"))) {
    const parsed: unknown[] = [];
    let allParsed = true;
    for (const l of lines) {
      try { parsed.push(JSON.parse(l)); } catch { allParsed = false; break; }
    }
    if (allParsed) {
      const signals = parsed.map(detectSignal);
      const signal = signals.find((s): s is Signal => s !== undefined);
      if (signal) {
        const merged: unknown[] = [];
        let skipped = 0;
        parsed.forEach((p, idx) => {
          if (signals[idx] === signal) merged.push(...rootArray(p as Record<string, unknown>, signal));
          else skipped++;
        });
        if (skipped > 0) {
          warnings.push(`Skipped ${skipped} line${skipped === 1 ? "" : "s"} that weren't ${signal}.`);
        }
        const obj = { [SIGNAL_ROOT[signal]]: merged };
        return {
          ok: true,
          json: JSON.stringify(obj, null, 2),
          signal,
          source: "jsonl",
          records: countRecords(obj, signal),
          warnings,
        };
      }
    }
  }

  // 3. debug exporter output.
  if (looksLikeDebugOutput(trimmed)) {
    const r = parseDebugText(trimmed);
    if (!r.ok) return { ok: false, warnings: r.warnings, error: r.error };
    return {
      ok: true,
      json: JSON.stringify(r.payload, null, 2),
      signal: r.signal,
      source: "debug",
      records: r.records,
      warnings: r.warnings,
    };
  }

  // Nothing matched: give the most useful error for what it looks like.
  if (/^[[{]/.test(trimmed)) {
    return { ok: false, warnings, error: `The payload looks like JSON but doesn't parse: ${jsonError}` };
  }
  const debugHint = parseDebugText(trimmed); // reuses the verbosity hint for basic/normal output
  return {
    ok: false,
    warnings,
    error: debugHint.error?.includes("verbosity")
      ? debugHint.error
      : "Couldn't read the payload. Paste OTLP JSON, JSON Lines from the file exporter, or debug exporter output (verbosity: detailed).",
  };
}

/** Short human summary of a successful conversion, for the panel. */
export function describeConversion(input: PayloadInput): string | undefined {
  if (!input.ok || input.source === "json" || !input.signal) return undefined;
  const unit = input.signal === "logs" ? "log record" : input.signal === "traces" ? "span" : "datapoint";
  const n = input.records ?? 0;
  const from = input.source === "debug" ? "debug exporter output" : "JSON Lines";
  return `Converted ${from} → OTLP JSON (${n} ${unit}${n === 1 ? "" : "s"}).`;
}
