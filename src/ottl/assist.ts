/**
 * Hover docs and autocomplete for OTTL — pure logic, no VS Code dependency.
 *
 * Everything shown comes from the catalog generated from the upstream reference
 * (scripts/gen-catalog.mjs): function signatures/descriptions/examples, the path
 * tables of each context, and enum symbols. Version notes (newer than the bundled
 * engine, removed upstream) were verified against the real engine.
 *
 * Works on a single line of text so it keeps working while a Collector YAML file
 * is half-typed and doesn't parse.
 */

import {
  CONTEXT_PATHS,
  EDITORS,
  ENGINE_VERSION,
  ENUMS,
  FUNCTION_DOCS,
  FUNCTIONS_DOC_URL,
  NOT_IN_ENGINE,
  REMOVED_UPSTREAM,
  type FunctionDoc,
} from "./catalog";
import { EXTRA_KNOWN, REMOVED_REPLACEMENTS } from "./extras";
import { segmentsAfter } from "./explain";

export const CONTEXT_ROOTS = [
  "log", "span", "spanevent", "metric", "datapoint", "resource", "instrumentation_scope",
] as const;

const KEYWORDS = ["where", "and", "or", "not", "nil", "true", "false"];

const PATHS = new Map(CONTEXT_PATHS.map((p) => [p.path, p]));
const ENUM_MAP = new Map(ENUMS.map((e) => [e.name, e]));

const EXTRA_DOCS: Record<string, string> = {
  route: "Component-scoped function of the **routing connector**: marks the signal for the route's pipelines. Valid only in `routing` connector statements.",
  ProfileID: "Profiles converter, documented in the [`xprofile` context](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/pkg/ottl/contexts/xprofile).",
};

/* ------------------------------------------------------------------ *
 * Where OTTL starts on a line, and string / comment state
 * ------------------------------------------------------------------ */

export interface LineOptions {
  /** The line comes from Collector YAML (list item or `statement:` / `condition:` value). */
  yaml?: boolean;
}

interface Scan {
  /** Column where the OTTL text begins (after "- " and an opening YAML quote). */
  start: number;
  /** The YAML scalar is double-quoted, so OTTL quotes appear as \" . */
  yamlDoubleQuoted: boolean;
}

function scanStart(line: string, opts: LineOptions): Scan {
  if (!opts.yaml) return { start: 0, yamlDoubleQuoted: false };
  const m = /^(\s*(?:-\s+)?(?:(?:statement|condition)\s*:\s*)?)(["']?)/.exec(line);
  const prefix = m ? m[1].length : 0;
  const quote = m ? m[2] : "";
  return { start: prefix + quote.length, yamlDoubleQuoted: quote === '"' };
}

/** Is `col` inside an OTTL string literal or a trailing `#` comment? */
export function inStringOrComment(line: string, col: number, opts: LineOptions = {}): boolean {
  const { start, yamlDoubleQuoted } = scanStart(line, opts);
  let inStr = false;
  for (let i = start; i < col && i < line.length; i++) {
    const ch = line[i];
    if (yamlDoubleQuoted) {
      if (ch === "\\" && line[i + 1] === '"') { inStr = !inStr; i++; continue; }
      if (ch === '"') return false; // end of the YAML scalar
    } else {
      if (inStr && ch === "\\") { i++; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
    }
    if (!inStr && ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) return true;
  }
  return inStr;
}

/* ------------------------------------------------------------------ *
 * YAML gate: is this line an OTTL statement/condition?
 * ------------------------------------------------------------------ */

const OTTL_LIST_KEY = /(^|_)(statements|conditions)$/;
const LEGACY_FILTER_KEYS = new Set(["span", "spanevent", "log_record", "metric", "datapoint"]);
const SIGNAL_KEYS = new Set(["traces", "logs", "metrics"]);

function indentOf(l: string): number {
  return /^\s*/.exec(l)![0].length;
}
function keyOf(l: string): string | undefined {
  const m = /^\s*(?:-\s+)?([\w./-]+)\s*:(\s|$)/.exec(l);
  return m?.[1];
}

/**
 * Decide from indentation alone (no YAML parser, so it works on invalid YAML)
 * whether `lineNo` holds OTTL: an item under a *_statements / *_conditions /
 * statements / conditions key, a routing `statement:` / `condition:` value, or a
 * legacy filter list (traces: span: [...]).
 */
export function isOttlLine(lines: readonly string[], lineNo: number): boolean {
  const line = lines[lineNo] ?? "";
  if (/^\s*(-\s+)?(statement|condition)\s*:\s*\S/.test(line)) return true;
  if (!/^\s*-\s/.test(line)) return false;
  // "- context: log" / "- error_mode: ignore" are YAML mappings, not OTTL (OTTL never starts with "word:").
  if (/^\s*-\s+[A-Za-z_][\w.-]*\s*:(\s|$)/.test(line)) return false;

  const ancestors: string[] = [];
  let indent = indentOf(line);
  for (let i = lineNo - 1; i >= 0 && ancestors.length < 3; i--) {
    const l = lines[i];
    if (!l.trim() || /^\s*#/.test(l)) continue;
    const ind = indentOf(l);
    if (ind < indent || (ind === indent && !/^\s*-\s/.test(l) && keyOf(l))) {
      const k = keyOf(l);
      if (k) ancestors.push(k);
      indent = ind;
      if (ind === 0) break;
    }
  }
  const [parent, grandparent] = ancestors;
  if (!parent) return false;
  if (OTTL_LIST_KEY.test(parent)) return true;
  return LEGACY_FILTER_KEYS.has(parent) && !!grandparent && SIGNAL_KEYS.has(grandparent);
}

/* ------------------------------------------------------------------ *
 * Markdown builders
 * ------------------------------------------------------------------ */

function versionNotes(name: string): string[] {
  const notes: string[] = [];
  if (NOT_IN_ENGINE.has(name)) {
    notes.push(`⚠️ Added after ${ENGINE_VERSION}, the version the bundled dry-run engine is built from — it lints fine, but the dry-run can't execute it yet.`);
  }
  if (REMOVED_UPSTREAM.has(name) && !EXTRA_KNOWN.has(name)) {
    const r = REMOVED_REPLACEMENTS[name];
    notes.push(`⚠️ Removed from the latest OTTL${r ? ` — use \`${r}\` instead` : ""}. Still works on older collectors.`);
  }
  return notes;
}

export function functionMarkdown(name: string): string | undefined {
  const doc: FunctionDoc | undefined = FUNCTION_DOCS[name];
  if (!doc) {
    return EXTRA_DOCS[name] ? "```ottl\n" + name + "(…)\n```\n\n" + EXTRA_DOCS[name] : undefined;
  }
  const parts = [
    "```ottl\n" + doc.signature + "\n```",
    doc.kind === "editor" ? "*Editor* — modifies telemetry." : "*Converter* — returns a value.",
    doc.summary,
  ];
  if (doc.details) parts.push(doc.details);
  if (doc.examples.length) parts.push("**Examples**\n\n" + doc.examples.map((e) => "- `" + e + "`").join("\n"));
  parts.push(...versionNotes(name));
  parts.push(`[OTTL function reference](${FUNCTIONS_DOC_URL}#${doc.anchor})`);
  return parts.filter(Boolean).join("\n\n");
}

export function pathMarkdown(path: string): string | undefined {
  const p = PATHS.get(path);
  if (!p) return undefined;
  return "```ottl\n" + p.path + "\n```\n\n**" + p.type + "** — " + p.description;
}

export function enumMarkdown(name: string): string | undefined {
  const e = ENUM_MAP.get(name);
  if (!e) return undefined;
  return "```ottl\n" + e.name + " = " + e.value + "\n```\n\nEnum, valid in the " +
    e.contexts.map((c) => "`" + c + "`").join(", ") + " context" + (e.contexts.length > 1 ? "s" : "") + ".";
}

/* ------------------------------------------------------------------ *
 * Hover
 * ------------------------------------------------------------------ */

export interface HoverResult {
  markdown: string;
  start: number;
  end: number;
}

export function hoverAt(line: string, col: number, opts: LineOptions = {}): HoverResult | undefined {
  if (inStringOrComment(line, col, opts)) return undefined;
  const isWord = (c: string | undefined) => !!c && /[A-Za-z0-9_.]/.test(c);
  let start = col;
  let end = col;
  while (start > 0 && isWord(line[start - 1])) start--;
  while (end < line.length && isWord(line[end])) end++;
  if (start === end) return undefined;
  const word = line.slice(start, end);

  if (!word.includes(".")) {
    const after = line.slice(end).trimStart();
    if (after.startsWith("(")) {
      const md = functionMarkdown(word);
      return md ? { markdown: md, start, end } : undefined;
    }
    const md = enumMarkdown(word) ?? pathMarkdown(word);
    return md ? { markdown: md, start, end } : undefined;
  }

  // Dotted path: describe the path up to the hovered segment.
  const segEnd = line.indexOf(".", col) === -1 || line.indexOf(".", col) > end ? end : line.indexOf(".", col);
  const path = line.slice(start, segEnd);
  const md = pathMarkdown(path);
  return md ? { markdown: md, start, end: segEnd } : undefined;
}

/* ------------------------------------------------------------------ *
 * Completion
 * ------------------------------------------------------------------ */

export type SuggestionKind = "function" | "field" | "context" | "enum" | "keyword";

export interface Suggestion {
  label: string;
  kind: SuggestionKind;
  detail: string;
  documentation?: string;
  /** Plain text, or a VS Code snippet when `snippet` is true. */
  insertText: string;
  snippet: boolean;
  sortText: string;
  deprecated?: boolean;
  /** Re-open suggestions after inserting (e.g. after "log."). */
  retrigger?: boolean;
}

export interface CompletionResult {
  items: Suggestion[];
  /** Column where the replaced word starts. */
  replaceStart: number;
}

/** `set(target, value)` → `set(${1:target}, ${2:value})`; optional arguments are left out. */
export function signatureSnippet(signature: string): string {
  const open = signature.indexOf("(");
  const close = signature.lastIndexOf(")");
  const name = signature.slice(0, open);
  if (open < 0 || close < open) return `${signature}($1)`;
  const inner = signature.slice(open + 1, close);
  const args: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of inner) {
    if (ch === "[" || ch === "(") depth++;
    if (ch === "]" || ch === ")") depth--;
    if (ch === "," && depth === 0) { args.push(cur); cur = ""; continue; }
    cur += ch;
  }
  args.push(cur);
  const required = args
    .map((a) => a.trim())
    .filter((a) => a && !/^Optional\[/.test(a) && a !== "…" && a !== "...")
    .map((a) => a.replace(/\[\]/g, "").replace(/\.\.\./g, "").replace(/[^\w]/g, "") || "arg");
  if (required.length === 0) return `${name}($1)`;
  return `${name}(${required.map((a, i) => `\${${i + 1}:${a}}`).join(", ")})`;
}

function functionSuggestion(doc: FunctionDoc, sortPrefix: string): Suggestion {
  const newer = NOT_IN_ENGINE.has(doc.name);
  const removed = REMOVED_UPSTREAM.has(doc.name) && !EXTRA_KNOWN.has(doc.name);
  const tag = newer ? ` · newer than ${ENGINE_VERSION} engine` : removed ? " · removed upstream" : "";
  return {
    label: doc.name,
    kind: "function",
    detail: doc.signature + tag,
    documentation: functionMarkdown(doc.name),
    insertText: signatureSnippet(doc.signature),
    snippet: true,
    sortText: (removed ? "9" : sortPrefix) + doc.name.toLowerCase(),
    deprecated: removed,
  };
}

export function completionsAt(line: string, col: number, opts: LineOptions = {}): CompletionResult {
  if (inStringOrComment(line, col, opts)) return { items: [], replaceStart: col };
  const before = line.slice(0, col);

  // 1. Path member completion: "log." / "log.sev" / "log.trace_id."
  const pathM = /([a-z_]+(?:\.[a-z_]+)*)\.([a-z_]*)$/.exec(before);
  if (pathM && (CONTEXT_ROOTS as readonly string[]).includes(pathM[1].split(".")[0])) {
    const base = pathM[1];
    const partial = pathM[2];
    const items = segmentsAfter(base).map((seg): Suggestion => {
      const full = `${base}.${seg}`;
      const doc = PATHS.get(full) ?? PATHS.get(`${full}[""]`) ?? PATHS.get(`${full}[]`);
      // Reopen suggestions only for pure containers (e.g. "resource" → "resource.attributes"),
      // not for fields that are complete paths on their own (e.g. "trace_id", which also has ".string").
      const retrigger = segmentsAfter(full).length > 0 && !PATHS.has(full);
      return {
        label: seg,
        kind: "field",
        detail: doc ? `${full} · ${doc.type}` : full,
        documentation: doc ? pathMarkdown(doc.path) : undefined,
        insertText: retrigger ? seg + "." : seg,
        snippet: false,
        sortText: "0" + seg,
        retrigger,
      };
    });
    return { items, replaceStart: col - partial.length };
  }

  // 2. Identifier completion: functions, context roots, enums, keywords.
  const idM = /([A-Za-z_][A-Za-z0-9_]*)$/.exec(before);
  const partial = idM ? idM[1] : "";
  const replaceStart = col - partial.length;
  const lead = before.slice(0, replaceStart);
  const { start } = scanStart(line, opts);
  const atStatementStart = lead.slice(start).trim() === "";

  const items: Suggestion[] = [];
  for (const doc of Object.values(FUNCTION_DOCS)) {
    const isEditor = EDITORS.has(doc.name);
    if (isEditor && !atStatementStart) continue; // editors only begin a statement
    items.push(functionSuggestion(doc, atStatementStart ? (isEditor ? "0" : "1") : "1"));
  }
  if (!atStatementStart) {
    for (const root of CONTEXT_ROOTS) {
      items.push({
        label: root,
        kind: "context",
        detail: `${root}.… — ${root} context paths`,
        insertText: root + ".",
        snippet: false,
        sortText: "0" + root,
        retrigger: true,
      });
    }
    for (const e of ENUMS) {
      items.push({
        label: e.name,
        kind: "enum",
        detail: `${e.value} · ${e.contexts.join(", ")}`,
        documentation: enumMarkdown(e.name),
        insertText: e.name,
        snippet: false,
        sortText: "2" + e.name.toLowerCase(),
      });
    }
    for (const k of KEYWORDS) {
      items.push({ label: k, kind: "keyword", detail: "OTTL keyword", insertText: k, snippet: false, sortText: "3" + k });
    }
  }
  return { items, replaceStart };
}
