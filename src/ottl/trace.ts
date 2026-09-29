/**
 * Per-statement execution trace ("what did each statement actually do?").
 *
 * The upstream engine runs a whole block of statements at once, so it cannot tell
 * you which individual statement mattered. We recover that by running growing
 * prefixes of the block — [0..0], [0..1], [0..2], … — against the *same* input
 * payload and diffing consecutive outputs. Statement i's effect is
 * `output(0..i) - output(0..i-1)`.
 *
 * This needs no changes to the WASM engine: it only calls the existing evaluator.
 *
 * The interesting verdict is `no-effect`: a statement that ran without error and
 * changed nothing. That is the most common way OTTL fails in production. Verified
 * against the real engine (contrib v0.146.0): `set(metric.type, …)` is accepted and
 * does nothing; assigning `span.trace_id` without the `.string` suffix does nothing;
 * `set(x, Int("abc"))` writes nothing because the converter returns nil.
 *
 * We further split `no-effect` into two causes by re-running the statement with
 * its `where` guard removed. If the unguarded form *does* change the payload, the
 * guard is what excluded everything (`not-matched`) rather than the operation
 * being inert (`no-effect`).
 */

import { stripOttlComments } from "./yaml";
import { presentDiff, type PresentedDiff } from "./present";
import { classifyError, explainEngineError, type ErrorClass } from "./explain";

export type StepVerdict = "changed" | "no-effect" | "not-matched" | "error";

/** Minimal shape of the engine result we depend on (mirrors DryRunResult). */
export interface EvalResult {
  ok: boolean;
  output?: string;
  error?: string;
  executionMs?: number;
}

/** Injected engine call, so this module is unit-testable without WASM. */
export type EvalFn = (statements: string, signal: string, payloadJSON: string) => EvalResult;

export type ErrorMode = "propagate" | "ignore" | "silent";

export interface DiffEntry {
  /** Human-readable location, e.g. `resourceLogs[0].…logRecords[0].attributes["env"]`. */
  path: string;
  kind: "added" | "removed" | "changed";
  before?: unknown;
  after?: unknown;
}

export interface StepResult {
  /** 0-based index within the runnable statement list. */
  index: number;
  statement: string;
  verdict: StepVerdict;
  /** Structural changes this statement introduced (verdict `changed`). */
  diff?: DiffEntry[];
  /** The same changes as OTTL paths and literals, for display. */
  display?: PresentedDiff[];
  /** Engine error text (verdict `error`). */
  error?: string;
  /** Plain-language consequence of the error (config errors vs runtime + error_mode). */
  consequence?: string;
  /** What kind of error: the config is rejected, the payload is bad, or it failed at runtime. */
  errorClass?: ErrorClass;
  /** A readable explanation of the engine's error message, when we have one. */
  explanation?: string;
  /** Why a no-op happened, in words the user can act on. */
  note?: string;
}

export interface TraceResult {
  ok: boolean;
  steps: StepResult[];
  /** Pretty-printed payload after all statements (when the whole block ran). */
  finalOutput?: string;
  /** Fatal error that prevented tracing at all. */
  error?: string;
  /** Count of statements that ran clean but did nothing — the headline number. */
  noEffectCount: number;
}

/* ------------------------------------------------------------------ *
 * Statement splitting
 * ------------------------------------------------------------------ */

/**
 * Split a block into individually runnable statements.
 * Comments and blank lines are removed first; one statement per line, which is
 * how OTTL blocks are written in both `.ottl` files and Collector YAML lists.
 */
export function splitStatements(text: string): string[] {
  return stripOttlComments(text)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * Mask string literals so keyword scanning never matches inside them.
 * Preserves length so indices stay aligned with the original.
 */
function maskStrings(line: string): string {
  let out = "";
  let inStr = false;
  let escaped = false;
  for (const ch of line) {
    if (escaped) { out += inStr ? "_" : ch; escaped = false; continue; }
    if (ch === "\\") { out += inStr ? "_" : ch; escaped = true; continue; }
    if (ch === '"') { inStr = !inStr; out += '"'; continue; }
    out += inStr ? "_" : ch;
  }
  return out;
}

/**
 * Remove a trailing `where <condition>` guard.
 * Returns null when the statement has no guard.
 */
export function stripWhereClause(statement: string): string | null {
  const masked = maskStrings(statement);
  const m = /\bwhere\b/i.exec(masked);
  if (!m) return null;
  const head = statement.slice(0, m.index).trim();
  return head.length > 0 ? head : null;
}

/* ------------------------------------------------------------------ *
 * Structural diff
 * ------------------------------------------------------------------ */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * OTLP represents attributes as `[{key, value}, …]`. Diffing those positionally
 * produces noise the moment a key is added or dropped, so treat any array whose
 * elements all carry a string `key` as a keyed map instead.
 */
function isKeyedArray(v: unknown): v is Array<Record<string, unknown> & { key: string }> {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((el) => isRecord(el) && typeof el.key === "string")
  );
}

/** Keyed, or empty (an empty attribute list is still an attribute list). */
function isKeyedOrEmpty(v: unknown): v is Array<Record<string, unknown> & { key: string }> {
  return Array.isArray(v) && v.every((el) => isRecord(el) && typeof el.key === "string");
}

function joinPath(base: string, seg: string): string {
  return base ? `${base}${seg}` : seg.replace(/^\./, "");
}

/** Recursively diff two JSON values, returning a flat list of changes. */
export function diffJSON(before: unknown, after: unknown, path = ""): DiffEntry[] {
  if (before === after) return [];

  if (isKeyedOrEmpty(before) && isKeyedOrEmpty(after) && (before.length > 0 || after.length > 0)) {
    const out: DiffEntry[] = [];
    const bMap = new Map(before.map((e) => [e.key, e]));
    const aMap = new Map(after.map((e) => [e.key, e]));
    for (const [k, bv] of bMap) {
      const av = aMap.get(k);
      if (av === undefined) {
        out.push({ path: `${path}[${JSON.stringify(k)}]`, kind: "removed", before: bv });
      } else {
        out.push(...diffJSON(bv, av, `${path}[${JSON.stringify(k)}]`));
      }
    }
    for (const [k, av] of aMap) {
      if (!bMap.has(k)) {
        out.push({ path: `${path}[${JSON.stringify(k)}]`, kind: "added", after: av });
      }
    }
    return out;
  }

  if (Array.isArray(before) && Array.isArray(after)) {
    const out: DiffEntry[] = [];
    const max = Math.max(before.length, after.length);
    for (let i = 0; i < max; i++) {
      if (i >= before.length) out.push({ path: `${path}[${i}]`, kind: "added", after: after[i] });
      else if (i >= after.length) out.push({ path: `${path}[${i}]`, kind: "removed", before: before[i] });
      else out.push(...diffJSON(before[i], after[i], `${path}[${i}]`));
    }
    return out;
  }

  if (isRecord(before) && isRecord(after)) {
    const out: DiffEntry[] = [];
    // The engine omits empty repeated fields, so a record with no attributes has no
    // `attributes` key at all. Expand an appearing/disappearing attribute list into
    // per-key entries rather than one opaque array.
    for (const k of Object.keys(before)) {
      const p = joinPath(path, `.${k}`);
      if (!(k in after)) {
        if (isKeyedArray(before[k])) out.push(...diffJSON(before[k], [], p));
        else out.push({ path: p, kind: "removed", before: before[k] });
      } else out.push(...diffJSON(before[k], after[k], p));
    }
    for (const k of Object.keys(after)) {
      const p = joinPath(path, `.${k}`);
      if (!(k in before)) {
        if (isKeyedArray(after[k])) out.push(...diffJSON([], after[k], p));
        else out.push({ path: p, kind: "added", after: after[k] });
      }
    }
    return out;
  }

  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  return [{ path: path || "(root)", kind: "changed", before, after }];
}

/* ------------------------------------------------------------------ *
 * error_mode consequences
 * ------------------------------------------------------------------ */

/**
 * What actually happens to this telemetry record when a statement fails at RUNTIME.
 * `propagate` is the default and the dangerous one: it discards the record.
 * (error_mode does not apply to config/parse errors — see describeError.)
 */
export function describeErrorMode(mode: ErrorMode): string {
  switch (mode) {
    case "propagate":
      return "With error_mode: propagate (the default), this record would be DROPPED from the pipeline.";
    case "ignore":
      return "With error_mode: ignore, the error is logged and the remaining statements still run — the trace continues without this statement.";
    case "silent":
      return "With error_mode: silent, the error is swallowed with no log line — you would never see this in production. The trace continues without this statement.";
  }
}

/** The consequence of an error, which depends on what kind of error it is. */
export function describeError(errorClass: ErrorClass, mode: ErrorMode): string {
  switch (errorClass) {
    case "config":
      return "This is a configuration error: the collector would reject this config and fail to start. error_mode does not apply to it.";
    case "payload":
      return "The sample payload was rejected before any statement ran.";
    case "runtime":
      return describeErrorMode(mode);
  }
}

/* ------------------------------------------------------------------ *
 * Baseline
 * ------------------------------------------------------------------ */

/**
 * A statement that parses, lets the engine infer the right context, and can
 * never match (`where 1 == 2`). Running it returns the engine's *normalized*
 * form of the input without changing any data.
 *
 * Why this matters: the engine re-marshals OTLP through pdata, which canonicalizes
 * the payload (verified on the real engine: spans without a status come back with
 * an empty `status`). Diffing statement #1 against the raw input would blame it for
 * the engine's own normalization — and could report a genuine no-op as "changed".
 */
const BASELINE_SENTINEL = "__ottl_lens_baseline";

export function baselineStatement(signal: string): string | undefined {
  switch (signal) {
    case "logs":
      return `set(log.attributes["${BASELINE_SENTINEL}"], "x") where 1 == 2`;
    case "traces":
      return `set(span.attributes["${BASELINE_SENTINEL}"], "x") where 1 == 2`;
    case "metrics":
      return `set(metric.name, "${BASELINE_SENTINEL}") where 1 == 2`;
    default:
      return undefined;
  }
}

/* ------------------------------------------------------------------ *
 * The trace
 * ------------------------------------------------------------------ */

function parse(json: string | undefined): unknown {
  if (json === undefined) return undefined;
  try { return JSON.parse(json); } catch { return undefined; }
}

/**
 * Statements whose no-op behaviour is a known trap, with a usable hint.
 * Each case below was reproduced on the real engine (contrib v0.146.0).
 */
export function knownNoOpHint(statement: string): string | undefined {
  if (/\bmetric\.type\b/.test(statement) && /^\s*set\s*\(\s*metric\.type\b/.test(statement)) {
    return "set() on metric.type is accepted but does nothing in the transform processor. To change a metric's type, use a conversion function such as convert_gauge_to_sum() or convert_sum_to_gauge().";
  }
  if (/\b(trace_id|span_id|parent_span_id)\b/.test(statement) && !/\.string\b/.test(statement)) {
    return "trace_id/span_id are bytes internally. Assigning a hex string without the .string suffix silently does nothing — use span.trace_id.string (or span_id.string).";
  }
  const body = stripWhereClause(statement) ?? statement; // ignore converters inside the guard
  if (/^\s*set\s*\(/.test(body) && /,\s*.*\b[A-Z][A-Za-z0-9]*\s*\(/.test(body)) {
    return "If the converter on the right returned nil for this input (for example Int(\"abc\")), set() has nothing to write. Otherwise the field already had this value.";
  }
  return undefined;
}

/**
 * Run each statement in sequence and report what it actually did.
 *
 * @param statementsText the whole block (comments allowed)
 * @param signal         logs | traces | metrics
 * @param payloadJSON    input OTLP JSON
 * @param evalFn         engine call (injected for testability)
 * @param errorMode      the block's error_mode; defaults to OTTL's own default
 */
export function traceStatements(
  statementsText: string,
  signal: string,
  payloadJSON: string,
  evalFn: EvalFn,
  errorMode: ErrorMode = "propagate"
): TraceResult {
  const statements = splitStatements(statementsText);
  if (statements.length === 0) {
    return { ok: false, steps: [], noEffectCount: 0, error: "No runnable OTTL statements (only comments or blank lines)." };
  }

  const original = parse(payloadJSON);
  if (original === undefined) {
    return { ok: false, steps: [], noEffectCount: 0, error: "Sample payload is not valid JSON." };
  }

  const steps: StepResult[] = [];
  let previous: unknown = original;
  let lastGoodOutput: string | undefined;
  let noEffectCount = 0;

  // Diff against the engine's normalized input, not the raw text (see baselineStatement).
  // If the baseline run fails for any reason, fall back to the raw input.
  const base = baselineStatement(signal);
  if (base) {
    const b = evalFn(base, signal, payloadJSON);
    // Defense in depth: if the sentinel leaked into the output, the guard was not
    // honoured and this "baseline" is contaminated — discard it.
    const leaked = b.output?.includes(BASELINE_SENTINEL) ?? false;
    const normalized = b.ok && !leaked ? parse(b.output) : undefined;
    if (normalized !== undefined) previous = normalized;
  }

  // Statements that ran successfully so far; a statement that fails at runtime under
  // error_mode ignore/silent is left out, exactly as a collector would skip it.
  const active: string[] = [];

  for (let i = 0; i < statements.length; i++) {
    const statement = statements[i];
    const prefix = [...active, statement].join("\n");
    const res = evalFn(prefix, signal, payloadJSON);

    if (!res.ok) {
      const message = res.error ?? "Unknown engine error.";
      const errorClass = classifyError(message);
      steps.push({
        index: i,
        statement,
        verdict: "error",
        error: message,
        errorClass,
        explanation: explainEngineError(message, statement),
        consequence: describeError(errorClass, errorMode),
      });
      // Under ignore/silent a runtime error skips only this statement; everything
      // else (config errors, bad payloads, propagate) stops the block.
      if (errorClass === "runtime" && errorMode !== "propagate") continue;
      break;
    }

    const current = parse(res.output);
    if (current === undefined) {
      steps.push({ index: i, statement, verdict: "error", error: "Engine returned output that is not valid JSON." });
      break;
    }
    active.push(statement);
    lastGoodOutput = res.output;

    const diff = diffJSON(previous, current);
    if (diff.length > 0) {
      steps.push({ index: i, statement, verdict: "changed", diff, display: presentDiff(diff, previous) });
      previous = current;
      continue;
    }

    // No change. Distinguish an inert operation from a guard that matched nothing
    // by re-running this statement alone without its `where` clause.
    const unguarded = stripWhereClause(statement);
    if (unguarded) {
      const probe = evalFn(unguarded, signal, JSON.stringify(previous));
      const probed = probe.ok ? parse(probe.output) : undefined;
      if (probed !== undefined && diffJSON(previous, probed).length > 0) {
        steps.push({
          index: i,
          statement,
          verdict: "not-matched",
          note: "The statement is fine, but its where clause matched no records in this payload.",
        });
        continue;
      }
    }

    noEffectCount++;
    steps.push({
      index: i,
      statement,
      verdict: "no-effect",
      note: knownNoOpHint(statement) ?? "This statement ran without error but changed nothing in this payload.",
    });
  }

  return {
    ok: steps.every((s) => s.verdict !== "error"),
    steps,
    noEffectCount,
    finalOutput: lastGoodOutput,
  };
}

/** One-line summary for the panel header. */
export function summarize(result: TraceResult): string {
  if (result.error) return result.error;
  const changed = result.steps.filter((s) => s.verdict === "changed").length;
  const errored = result.steps.filter((s) => s.verdict === "error").length;
  const unmatched = result.steps.filter((s) => s.verdict === "not-matched").length;
  const parts = [`${changed} changed`];
  if (result.noEffectCount > 0) parts.push(`${result.noEffectCount} had no effect`);
  if (unmatched > 0) parts.push(`${unmatched} matched nothing`);
  if (errored > 0) parts.push(`${errored} errored`);
  return parts.join(" · ");
}
