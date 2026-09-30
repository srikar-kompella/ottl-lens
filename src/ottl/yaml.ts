/**
 * Extract OTTL strings (with source positions + context) from OpenTelemetry
 * Collector YAML. This is what lets the linter work on the files users actually
 * edit (otelcol.yaml), not just standalone .ottl files.
 *
 * Pure module (uses the `yaml` CST for line/col); unit-testable.
 */

import { parseDocument, isMap, isSeq, isScalar, Scalar, LineCounter } from "yaml";

export type Dialect = "statement" | "condition";

export interface ExtractedOTTL {
  text: string;
  /** 0-based line of the string's first char in the YAML document. */
  line: number;
  /** 0-based column of the string's first char. */
  col: number;
  /** Component instance id, e.g. "transform/logs". */
  component: string;
  /** Explicit `context:` if present, else null (inferred). */
  context: string | null;
  /** Which pipeline signal this block targets: traces|metrics|logs|profiles. */
  signal: string | null;
  dialect: Dialect;
  /** YAML key path that located this string (for debugging / diagnostics). */
  keyPath: string;
  /**
   * The error_mode that applies: the statement group's own `error_mode` if set,
   * else the component's top-level `error_mode`, else null (version-dependent default).
   */
  errorMode: string | null;
}

function scalarAt(map: unknown, key: string): string | null {
  if (!isMap(map)) return null;
  const n = map.get(key, true);
  return isScalar(n) && n.value !== null && n.value !== undefined ? String(n.value) : null;
}

const SIGNAL_KEYS: Record<string, string> = {
  trace_statements: "traces",
  metric_statements: "metrics",
  log_statements: "logs",
  profile_statements: "profiles",
  trace_conditions: "traces",
  metric_conditions: "metrics",
  log_conditions: "logs",
  profile_conditions: "profiles",
};

/** Legacy filter shape: `<processor>.traces.span[]` etc. */
const LEGACY_FILTER_SIGNALS = new Set(["traces", "metrics", "logs", "profiles"]);

interface Pos {
  line: number;
  col: number;
}

function posOf(node: Scalar, lineCounter: { linePos: (off: number) => { line: number; col: number } }): Pos {
  const range = node.range;
  if (!range) return { line: 0, col: 0 };
  const lp = lineCounter.linePos(range[0]);
  return { line: lp.line - 1, col: lp.col - 1 }; // yaml is 1-based; we use 0-based
}

/**
 * Walk a collector YAML string and return every OTTL string with position + context.
 * Best-effort: unknown shapes are skipped, never throw.
 */
export function extractOTTL(yamlText: string): ExtractedOTTL[] {
  const out: ExtractedOTTL[] = [];
  const lineCounter = new LineCounter();
  let doc;
  try {
    doc = parseDocument(yamlText, { lineCounter, keepSourceTokens: true });
  } catch {
    return out;
  }
  if (!doc.contents || !isMap(doc.contents)) return out;

  // Find processors:/connectors: sections (also tolerate a bare top-level component map,
  // as in the repo's testdata where the file *is* the processors block).
  const roots: Array<{ node: unknown }> = [];
  for (const key of ["processors", "connectors"]) {
    const n = doc.getIn([key], true);
    if (n) roots.push({ node: n });
  }
  // testdata style: top-level keys are component ids directly.
  roots.push({ node: doc.contents });

  for (const { node } of roots) {
    if (!isMap(node)) continue;
    for (const item of node.items) {
      if (!isScalar(item.key)) continue;
      const compId = String(item.key.value);
      const type = compId.split("/")[0];
      if (type === "transform" || type === "filter") {
        walkTransformFilter(compId, type, item.value, out, lineCounter);
      } else if (type === "routing") {
        walkRouting(compId, item.value, out, lineCounter);
      }
    }
  }
  return out;
}

function walkTransformFilter(compId: string, type: string, value: unknown, out: ExtractedOTTL[], lc: any): void {
  if (!isMap(value)) return;
  const procMode = scalarAt(value, "error_mode");
  for (const grp of value.items) {
    if (!isScalar(grp.key)) continue;
    const key = String(grp.key.value);
    const signal = SIGNAL_KEYS[key] ?? null;

    // New style: *_statements / *_conditions
    if (signal && isSeq(grp.value)) {
      const dialect: Dialect = key.endsWith("_conditions") ? "condition" : "statement";
      for (const el of grp.value.items) {
        if (isScalar(el)) {
          // flat string form
          pushScalar(el, out, lc, { component: compId, context: null, signal, dialect, keyPath: `${compId}.${key}[]`, errorMode: procMode });
        } else if (isMap(el)) {
          // advanced form: { context, error_mode, conditions[], statements[] }
          const ctxNode = el.get("context", true);
          const ctx = isScalar(ctxNode) ? String(ctxNode.value) : null;
          const groupMode = scalarAt(el, "error_mode") ?? procMode;
          for (const sub of ["statements", "conditions"]) {
            const arr = el.get(sub, true);
            if (isSeq(arr)) {
              const d: Dialect = sub === "conditions" ? "condition" : "statement";
              for (const s of arr.items) {
                if (isScalar(s)) pushScalar(s, out, lc, { component: compId, context: ctx, signal, dialect: d, keyPath: `${compId}.${key}[].${sub}[]`, errorMode: groupMode });
              }
            }
          }
        }
      }
    }

    // Legacy filter: traces.span[], logs.log_record[], ...
    if (type === "filter" && LEGACY_FILTER_SIGNALS.has(key) && isMap(grp.value)) {
      for (const ctxGrp of grp.value.items) {
        if (!isScalar(ctxGrp.key) || !isSeq(ctxGrp.value)) continue;
        const ctx = String(ctxGrp.key.value); // e.g. span, log_record, resource
        for (const s of ctxGrp.value.items) {
          if (isScalar(s)) pushScalar(s, out, lc, { component: compId, context: ctx, signal: key, dialect: "condition", keyPath: `${compId}.${key}.${ctx}[]`, errorMode: procMode });
        }
      }
    }
  }
}

function walkRouting(compId: string, value: unknown, out: ExtractedOTTL[], lc: any): void {
  if (!isMap(value)) return;
  const procMode = scalarAt(value, "error_mode");
  const table = value.get("table", true);
  if (!isSeq(table)) return;
  for (const row of table.items) {
    if (!isMap(row)) continue;
    const ctxNode = row.get("context", true);
    const ctx = isScalar(ctxNode) ? String(ctxNode.value) : null;
    for (const field of ["statement", "condition"]) {
      const n = row.get(field, true);
      if (isScalar(n)) {
        pushScalar(n, out, lc, { component: compId, context: ctx, signal: null, dialect: field === "condition" ? "condition" : "statement", keyPath: `${compId}.table[].${field}`, errorMode: procMode });
      }
    }
  }
}

function pushScalar(node: Scalar, out: ExtractedOTTL[], lc: any, meta: Omit<ExtractedOTTL, "text" | "line" | "col">): void {
  const v = node.value;
  if (typeof v !== "string" || v.trim() === "") return;
  const { line, col } = posOf(node, lc);
  out.push({ text: v, line, col, ...meta });
}

/**
 * Given a Collector YAML doc and a cursor line (0-based), pick the transform block
 * to dry-run: the statement-dialect OTTL at/above the cursor, grouped by its
 * component + signal, joined by newlines. Returns the block's signal so the dry-run
 * panel can preselect it. Conditions (filter) are not executable statements and are
 * excluded. Empty result means "no runnable statements here".
 */
/**
 * Strip OTTL `#` comments (full-line and inline) and blank lines, respecting
 * double-quoted string literals. The real OTTL engine's lexer rejects `#`, so
 * `.ottl` files (which use `#` comments by convention) must be cleaned before a
 * dry-run. YAML-extracted statements are already comment-free, so this is a no-op
 * for them.
 */
export function stripOttlComments(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => {
      let inString = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inString) {
          if (ch === "\\") { i++; continue; }
          if (ch === '"') inString = false;
        } else if (ch === '"') {
          inString = true;
        } else if (ch === "#") {
          return line.slice(0, i);
        }
      }
      return line;
    })
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join("\n");
}

export function collectStatementsForDryRun(
  yamlText: string,
  cursorLine: number
): { statements: string; signal: string | null; errorMode: string | null } {
  const stmts = extractOTTL(yamlText).filter((x) => x.dialect === "statement");
  if (stmts.length === 0) return { statements: "", signal: null, errorMode: null };
  const atOrAbove = stmts.filter((s) => s.line <= cursorLine);
  const chosen = atOrAbove.length > 0 ? atOrAbove[atOrAbove.length - 1] : stmts[0];
  const group = stmts.filter((s) => s.component === chosen.component && s.signal === chosen.signal);
  // The error_mode of the statement group under the cursor (groups may override the processor's).
  return { statements: group.map((s) => s.text).join("\n"), signal: chosen.signal, errorMode: chosen.errorMode };
}
