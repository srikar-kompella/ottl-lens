/**
 * Static linter for OTTL — heuristic, catalog-based, false-positive-averse.
 *
 * This is deliberately NOT a real parser: it catches the cheap, common authoring
 * mistakes (unknown/mis-cased functions, unbalanced delimiters, single `=`,
 * unterminated strings, empty `where`) locally so they don't surface only at
 * collector runtime. For accurate, engine-level validation the extension ships a
 * separate WASM dry-run (see wasm/ and src/ottl/wasmRunner.ts) that executes
 * statements with the real Go OTTL engine; this linter stays lightweight and
 * never invokes it.
 *
 * Pure module (no vscode import) so it is unit-testable.
 */

import { KNOWN_FUNCTIONS, CASEFOLD_INDEX } from "./catalog";
import { EXTRA_KNOWN, REMOVED_REPLACEMENTS } from "./extras";
import { REMOVED_UPSTREAM, EXPERIMENTAL_FUNCTIONS, FEATURE_GATES } from "./catalog";

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

function checkFunctions(masked: string, line: number, diags: Diagnostic[]): void {
  const re = /([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    const name = m[1];
    if (LANG_WORDS.has(name)) continue;
    if (REMOVED_UPSTREAM.has(name) && !EXTRA_KNOWN.has(name)) {
      // Still works on older collectors (and in the bundled engine), so not a warning.
      const replacement = REMOVED_REPLACEMENTS[name];
      diags.push({
        line,
        startCol: m.index,
        endCol: m.index + name.length,
        message: `"${name}" has been removed from the latest OTTL.` +
          (replacement ? ` Use ${replacement} instead.` : " It only works on older collector versions."),
        severity: "info",
        code: "ottl.removedFunction"
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
      code: "ottl.unknownFunction"
    });
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

export interface LintOptions {
  /** Warn on functions not in the known OTTL catalog. Default true. */
  unknownFunctions?: boolean;
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
    if (checkUnknownFns) checkFunctions(masked, idx, diags);
    checkSingleEquals(masked, idx, diags);
    checkEmptyWhere(masked, idx, diags);
  });
  return diags;
}
