/**
 * Static linter for OTTL — heuristic, catalog-based, false-positive-averse.
 *
 * This is deliberately NOT a real parser: it catches the cheap, common authoring
 * mistakes (unknown/mis-cased functions, unbalanced delimiters, single `=`,
 * unterminated strings, empty `where`) locally so they don't surface only at
 * collector runtime. For accurate, engine-level validation the extension ships a
 * separate WASM dry-run (see wasm/ and src/ottl/engineHost.ts) that executes
 * statements with the real Go OTTL engine; this linter stays lightweight and
 * never invokes it.
 *
 * Pure module (no vscode import) so it is unit-testable.
 */

import { KNOWN_FUNCTIONS, CASEFOLD_INDEX } from "./catalog";
import { EXTRA_KNOWN, REMOVED_REPLACEMENTS } from "./extras";
import { REMOVED_UPSTREAM, EXPERIMENTAL_FUNCTIONS, FEATURE_GATES, FUNCTION_DOCS } from "./catalog";
import { checkTypes, type Fix } from "./typecheck";
import { CONTEXT_NAMES, segmentsAfter, suggestSegment } from "./explain";

export type { Fix };

/** "requires the ottl.functions.enableLambda feature gate (alpha since v0.155.0, off by default)". */
export function describeGate(gate: string): string {
  const g = FEATURE_GATES[gate];
  if (!g) return `the \`${gate}\` feature gate`;
  const off = g.stage === "alpha" ? ", off by default" : "";
  return `the \`${gate}\` feature gate (${g.stage} since ${g.since}${off})`;
}

export type Severity = "error" | "warning" | "info";

export interface Diagnostic {
  line: number; // 0-based
  startCol: number; // 0-based
  endCol: number; // exclusive
  message: string;
  severity: Severity;
  code: string;
  /** A safe, mechanical fix for this diagnostic (offered as a quick fix). Columns on the same line. */
  fix?: Fix;
  alternativeFixes?: Fix[];
}

/** Index of a `#` comment outside string literals, or the line length. */
function commentStart(line: string): number {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "#") return i;
  }
  return line.length;
}

/** Index of the ")" that closes the "(" at `open`, in masked text; -1 if unclosed. */
function closingParen(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === "(") depth++;
    else if (masked[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

const LANG_WORDS = new Set(["where", "and", "or", "not", "true", "false", "nil"]);

/**
 * Replace string contents and comments with spaces (preserving column positions),
 * so structural checks don't trip over `(` etc. inside strings/comments.
 */
function maskLine(line: string): { masked: string; unterminatedStringAt: number | null } {
  const out = line.split("");
  let inString = false;
  let stringStart = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inString) {
      if (ch === "\\") {
        out[i] = " ";
        if (i + 1 < line.length) out[i + 1] = " ";
        i++;
        continue;
      }
      if (ch === '"') {
        inString = false;
        out[i] = " ";
        continue;
      }
      out[i] = " ";
      continue;
    }
    if (ch === "#") {
      for (let j = i; j < line.length; j++) out[j] = " ";
      break;
    }
    if (ch === '"') {
      inString = true;
      stringStart = i;
      out[i] = " ";
      continue;
    }
  }
  return { masked: out.join(""), unterminatedStringAt: inString ? stringStart : null };
}

function checkDelimiters(masked: string, line: number, diags: Diagnostic[]): void {
  const stack: Array<{ ch: string; col: number }> = [];
  const pairs: Record<string, string> = { ")": "(", "]": "[" };
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === "(" || ch === "[") {
      stack.push({ ch, col: i });
    } else if (ch === ")" || ch === "]") {
      const top = stack.pop();
      if (!top || top.ch !== pairs[ch]) {
        diags.push({
          line,
          startCol: i,
          endCol: i + 1,
          message: `Unbalanced '${ch}'.`,
          severity: "error",
          code: "ottl.delimiters"
        });
      }
    }
  }
  for (const left of stack) {
    diags.push({
      line,
      startCol: left.col,
      endCol: left.col + 1,
      message: `Unclosed '${left.ch}'.`,
      severity: "error",
      code: "ottl.delimiters"
    });
  }
}

function checkFunctions(masked: string, raw: string, line: number, diags: Diagnostic[]): void {
  const re = /([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    const name = m[1];
    if (LANG_WORDS.has(name)) continue;
    if (REMOVED_UPSTREAM.has(name) && !EXTRA_KNOWN.has(name)) {
      // Still works on older collectors (and in the bundled engine), so not a warning.
      const replacement = REMOVED_REPLACEMENTS[name];
      let fix: Fix | undefined;
      if (name === "Base64Decode") {
        const open = m.index + m[0].length - 1;
        const close = closingParen(masked, open);
        const arg = close > open ? raw.slice(open + 1, close).trim() : "";
        if (close > open && arg && !arg.includes(",")) {
          fix = { title: `Replace with Decode(${arg}, "base64")`, start: m.index, end: close + 1, replacement: `Decode(${arg}, "base64")` };
        }
      }
      diags.push({
        line,
        startCol: m.index,
        endCol: m.index + name.length,
        message: `"${name}" has been removed from the latest OTTL.` +
          (replacement ? ` Use ${replacement} instead.` : " It only works on older collector versions."),
        severity: "info",
        code: "ottl.removedFunction",
        fix,
      });
      continue;
    }
    const gate = EXPERIMENTAL_FUNCTIONS[name];
    if (gate) {
      // Valid, but the collector rejects it unless the gate is enabled.
      const stage = FEATURE_GATES[gate]?.stage;
      diags.push({
        line,
        startCol: m.index,
        endCol: m.index + name.length,
        message: `"${name}" is experimental and needs ${describeGate(gate)}.` +
          (stage === "alpha" ? ` Start the collector with --feature-gates=${gate}, or it will reject this config.` : ""),
        severity: "info",
        code: "ottl.experimentalFunction"
      });
      continue;
    }
    if (KNOWN_FUNCTIONS.has(name) || EXTRA_KNOWN.has(name)) continue;
    const suggestion = CASEFOLD_INDEX.get(name.toLowerCase());
    const hint = suggestion ? ` Did you mean "${suggestion}"?` : "";
    diags.push({
      line,
      startCol: m.index,
      endCol: m.index + name.length,
      message: `Unknown OTTL function "${name}".${hint}`,
      severity: "warning",
      code: "ottl.unknownFunction",
      fix: suggestion ? { title: `Change to ${suggestion}`, start: m.index, end: m.index + name.length, replacement: suggestion } : undefined,
    });
  }
}

const PATH_ROOTS = "log|span|spanevent|metric|datapoint|resource|instrumentation_scope";

/**
 * Flag a path segment that isn't in the catalog but is one typo away from one that is
 * (log.atributes → log.attributes). Unknown segments with no close match are left
 * alone: the catalog documents paths, it doesn't prove others are invalid.
 */
function checkPaths(masked: string, line: number, diags: Diagnostic[]): void {
  const re = new RegExp(`(?<![\\w.])(${PATH_ROOTS})((?:\\.[a-z_]+)+)`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    let prefix = m[1];
    let col = m.index + prefix.length;
    for (const seg of m[2].slice(1).split(".")) {
      col += 1; // the dot
      const known = segmentsAfter(prefix);
      if (known.length === 0 || known.includes(seg)) {
        if (known.length === 0) break;
        prefix = `${prefix}.${seg}`;
        col += seg.length;
        continue;
      }
      const fixSeg = suggestSegment(prefix, seg);
      if (fixSeg) {
        diags.push({
          line,
          startCol: col,
          endCol: col + seg.length,
          message: `"${prefix}.${seg}" isn't a known path. Did you mean "${prefix}.${fixSeg}"?`,
          severity: "warning",
          code: "ottl.unknownPath",
          fix: { title: `Change to ${prefix}.${fixSeg}`, start: col, end: col + seg.length, replacement: fixSeg },
        });
      }
      break;
    }
  }
}

function checkSingleEquals(masked: string, line: number, diags: Diagnostic[]): void {
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] !== "=") continue;
    const prev = masked[i - 1];
    const next = masked[i + 1];
    // part of ==, !=, <=, >= → fine; "=>" is a lambda arrow: (_, v) => v == "x"
    if (next === "=" || next === ">" || prev === "=" || prev === "!" || prev === "<" || prev === ">") continue;
    diags.push({
      line,
      startCol: i,
      endCol: i + 1,
      message: `Single '=' is not valid in OTTL. Use '==' for comparison, or set(...) to assign.`,
      severity: "error",
      code: "ottl.singleEquals"
    });
  }
}

function checkEmptyWhere(masked: string, line: number, diags: Diagnostic[]): void {
  const m = /\bwhere\b\s*$/.exec(masked);
  if (m) {
    diags.push({
      line,
      startCol: m.index,
      endCol: m.index + 5,
      message: `Empty 'where' clause — expected a condition after 'where'.`,
      severity: "warning",
      code: "ottl.emptyWhere"
    });
  }
}

/** Positions of list (slice) parameters in a signature, e.g. keep_keys(target, keys[]) → [1]. */
export function sliceParams(signature: string): { index: number; name: string }[] {
  const inner = /^\w+\((.*)\)$/.exec(signature)?.[1];
  if (!inner) return [];
  return inner.split(",").map((p) => p.trim()).flatMap((p, index) => {
    const m = /^(?:\[\](\w+)|(\w+)\[\])$/.exec(p);
    return m ? [{ index, name: m[1] ?? m[2] }] : [];
  });
}

/** Top-level arguments of the call whose "(" is at `open`: [start, end) column pairs. */
function callArguments(masked: string, open: number): [number, number][] {
  const out: [number, number][] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === "(" || ch === "[" || ch === "{") { if (depth++ === 0) start = i + 1; continue; }
    if (ch === ")" || ch === "]" || ch === "}") {
      if (--depth === 0) { out.push([start, i]); return out; }
      continue;
    }
    if (ch === "," && depth === 1) { out.push([start, i]); start = i + 1; }
  }
  return [];
}

/**
 * A plain value where a function takes a list — keep_keys(log.attributes, "a"). The
 * parser rejects it, so the collector won't start (verified on v0.146.0 and v0.164.1).
 */
function checkSliceArguments(masked: string, raw: string, line: number, diags: Diagnostic[]): void {
  const re = /([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    const doc = FUNCTION_DOCS[m[1]];
    if (!doc) continue;
    const slots = sliceParams(doc.signature);
    if (slots.length === 0) continue;
    const args = callArguments(masked, m.index + m[0].length - 1);
    for (const { index, name } of slots) {
      const span = args[index];
      if (!span) continue;
      const text = raw.slice(span[0], span[1]);
      const lead = text.length - text.trimStart().length;
      const value = text.trim();
      if (!/^(".*"|-?\d+(\.\d+)?|true|false)$/.test(value)) continue;
      const start = span[0] + lead;
      diags.push({
        line,
        startCol: start,
        endCol: start + value.length,
        message: `"${m[1]}" expects a list for ${name} — write [${value}]. A plain value is rejected when the collector loads the config.`,
        severity: "error",
        code: "ottl.sliceArgument",
        fix: { title: `Wrap in a list: [${value}]`, start, end: start + value.length, replacement: `[${value}]` },
      });
    }
  }
}

const SIGNAL_CONTEXTS = new Map([
  ["logs", ["log", "resource", "scope"]],
  ["traces", ["span", "spanevent", "resource", "scope"]],
  ["metrics", ["datapoint", "metric", "resource", "scope"]],
  ["profiles", ["profile", "resource", "scope"]],
]);

function checkContextPrefixes(masked: string, line: number, signal: string, diags: Diagnostic[]): void {
  const contexts = SIGNAL_CONTEXTS.get(signal);
  if (!contexts) return;

  for (const match of masked.matchAll(/(?<![\w.])([a-z_][a-z0-9_]*)(?=\s*[[.])/g)) {
    const [field] = match;
    if (CONTEXT_NAMES.has(field)) continue;
    const start = match.index;
    const end = start + field.length;
    const [fix, ...alternativeFixes] = contexts
      .filter((context) => segmentsAfter(context).includes(field))
      .map((context) => {
        const replacement = context + "." + field;
        return { title: "Use " + replacement, start, end, replacement };
      });
    if (!fix) continue;

    diags.push({
      line,
      startCol: start,
      endCol: end,
      message: '"' + field + '" needs a context prefix in this transform block.',
      severity: "warning",
      code: "ottl.missingContext",
      fix,
      alternativeFixes,
    });
  }
}

export interface LintOptions {
  /** Warn on functions not in the known OTTL catalog. Default true. */
  unknownFunctions?: boolean;
  /** Signal of a transform YAML block that uses inferred context. */
  inferredSignal?: string;
}

export function lint(text: string, opts: LintOptions = {}): Diagnostic[] {
  const checkUnknownFns = opts.unknownFunctions !== false;
  const diags: Diagnostic[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, idx) => {
    const { masked, unterminatedStringAt } = maskLine(raw);
    if (unterminatedStringAt !== null) {
      diags.push({
        line: idx,
        startCol: unterminatedStringAt,
        endCol: raw.length,
        message: `Unterminated string literal.`,
        severity: "error",
        code: "ottl.unterminatedString"
      });
    }
    checkDelimiters(masked, idx, diags);
    if (checkUnknownFns) checkFunctions(masked, raw, idx, diags);
    checkSliceArguments(masked, raw, idx, diags);
    checkSingleEquals(masked, idx, diags);
    checkEmptyWhere(masked, idx, diags);
    checkPaths(masked, idx, diags);
    if (opts.inferredSignal) checkContextPrefixes(masked, idx, opts.inferredSignal, diags);
    // Type checks need the literal values, so they run on the raw line (comments stripped).
    const code = raw.slice(0, commentStart(raw));
    for (const t of checkTypes(code)) {
      diags.push({ line: idx, startCol: t.start, endCol: t.end, message: t.message, severity: "warning", code: t.code, fix: t.fix });
    }
  });
  return diags;
}
