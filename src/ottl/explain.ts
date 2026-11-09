/**
 * Turn raw engine errors into something a person can act on.
 *
 * The transform processor's errors are accurate but hard to read. The worst one:
 * an unknown function surfaces as
 *   unable to infer a valid context (…) … inferred context "log" does not support the function "clear"
 * which reads like a context problem, not "this function doesn't exist here".
 *
 * Each explanation is grounded in the catalog generated from upstream docs and
 * verified against the bundled engine (see scripts/gen-catalog.mjs).
 */

import {
  CASEFOLD_INDEX,
  CONTEXT_PATHS,
  ENGINE_VERSION,
  EXPERIMENTAL_FUNCTIONS,
  FUNCTION_REMOVED_IN,
  FUNCTION_SINCE,
  HISTORY_VERSIONS,
  KNOWN_FUNCTIONS,
} from "./catalog";
import { REMOVED_REPLACEMENTS } from "./extras";
import { atLeast } from "./versions";

/**
 * Why a known function can't run on this engine version, or undefined when it can.
 * Based on the per-version function lists generated from upstream docs (FUNCTION_SINCE).
 */
export function unavailableReason(name: string, engineVersion: string = ENGINE_VERSION): string | undefined {
  const since = FUNCTION_SINCE[name];
  if (since && !atLeast(engineVersion, since)) {
    const i = HISTORY_VERSIONS.indexOf(since);
    const prev = i > 0 ? HISTORY_VERSIONS[i - 1] : undefined;
    return `\`${name}\` is a real OTTL function, but it was added after ${prev && atLeast(prev, engineVersion) ? prev : engineVersion}, so the ${engineVersion} engine doesn't have it. ` +
      `Pick collector version ${since} or newer to run it.`;
  }
  const removed = FUNCTION_REMOVED_IN[name];
  if (removed && atLeast(engineVersion, removed)) {
    const r = REMOVED_REPLACEMENTS[name];
    return `\`${name}\` was removed in ${removed}${r ? `; use \`${r}\` instead` : ""}.`;
  }
  return undefined;
}

/** Feature-gate advice for an experimental function the engine rejected. */
function gateAdvice(gate: string): string {
  return `Collectors need \`--feature-gates=${gate}\` to run it. To run it in the dry-run too, add \`${gate}\` to the \`ottl.dryRun.featureGates\` setting.`;
}

export type ErrorClass = "config" | "payload" | "runtime";

/** Parse errors mean the collector rejects the config; error_mode only governs runtime errors. */
export function classifyError(message: string): ErrorClass {
  if (/^OTTL parse error:/.test(message)) return "config";
  if (/^invalid OTLP (logs|traces|metrics) JSON/.test(message) || /^payload is empty/.test(message)) return "payload";
  return "runtime";
}

/**
 * Edit distance counting an adjacent swap as one edit (optimal string alignment),
 * since swapped letters ("nmae") are the most common typo. Early-exits above `max`.
 */
export function editDistance(a: string, b: string, max = 3): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length];
}

/** Valid path segments that can follow `prefix.` (e.g. "log" → attributes, body, …). */
export function segmentsAfter(prefix: string): string[] {
  const out = new Set<string>();
  const p = prefix + ".";
  for (const { path } of CONTEXT_PATHS) {
    if (!path.startsWith(p)) continue;
    const seg = /^[a-z_]+/.exec(path.slice(p.length));
    if (seg) out.add(seg[0]);
  }
  return [...out];
}

/** Closest known segment under `prefix`, if one is plausibly a typo. */
export function suggestSegment(prefix: string, segment: string): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  for (const s of segmentsAfter(prefix)) {
    const d = editDistance(segment, s, 3);
    if (d < bestD) { bestD = d; best = s; }
  }
  return best && bestD <= Math.max(1, Math.min(3, Math.floor(segment.length / 3))) ? best : undefined;
}

/** Function names called in a statement (string contents ignored). */
export function functionsIn(statement: string): string[] {
  const masked = statement.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  return [...masked.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)].map((m) => m[1]);
}

export const CONTEXT_NAMES = new Set(["log", "span", "spanevent", "metric", "datapoint", "resource", "instrumentation_scope", "scope", "profile"]);

/**
 * First unqualified path in a statement (e.g. `attributes` in `set(attributes["a"], 1)`),
 * ignoring string contents, function calls, and fully qualified paths.
 */
export function unqualifiedPath(statement: string): string | undefined {
  const masked = statement.replace(/"(?:[^"\\]|\\.)*"/g, (s) => '"' + "_".repeat(Math.max(0, s.length - 2)) + '"');
  const re = /(^|[^\w.])([a-z_][a-z0-9_]*)(?=\s*[[.])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    if (!CONTEXT_NAMES.has(m[2])) return m[2];
  }
  return undefined;
}

/**
 * A one-paragraph, human explanation of an engine error, or undefined when we
 * have nothing better to say than the raw message. Passing the failing statement
 * lets us tell apart errors whose messages are identical.
 */
export function explainEngineError(message: string, statement = "", engineVersion: string = ENGINE_VERSION): string | undefined {
  // Experimental function without its feature gate (v0.155+ wording).
  const gated = /function "(\w+)" is experimental and requires the `([\w.]+)` feature gate/.exec(message);
  if (gated) {
    return `\`${gated[1]}\` is experimental. ${gateAdvice(gated[2])}`;
  }

  // A plain value where a list is required: keep_keys(x, "a"), Concat("a", "-").
  if (/must be a list of type/.test(message)) {
    const fn = /error while parsing arguments for call to "(\w+)"[^"]*$/.exec(message.split("invalid argument")[0])?.[1];
    return `${fn ? `\`${fn}\`` : "This function"} expects a list here — wrap the value in brackets, for example \`["http.method"]\`. ` +
      "From v0.163 a path or converter that returns a list also works.";
  }

  // Mis-cased converter: its own message.
  const lower = /converter names must start with an uppercase letter but got '(\w+)'/.exec(message);
  if (lower) {
    const fix = CASEFOLD_INDEX.get(lower[1].toLowerCase());
    return fix
      ? `Converter names start with an uppercase letter. Did you mean \`${fix}\`?`
      : `Converter names start with an uppercase letter, and there is no converter called \`${lower[1]}\`.`;
  }

  // Unknown function (reported as a context-inference failure).
  let m = /does not support the function "(\w+)"|undefined function "(\w+)"/.exec(message);
  if (m) {
    const name = m[1] ?? m[2];
    const why = unavailableReason(name, engineVersion);
    if (why) {
      const gate = EXPERIMENTAL_FUNCTIONS[name];
      return why + (gate ? ` It's experimental: ${gateAdvice(gate)}` : "");
    }
    if (!KNOWN_FUNCTIONS.has(name)) {
      const fix = CASEFOLD_INDEX.get(name.toLowerCase());
      return fix
        ? `There is no OTTL function \`${name}\` — function names are case-sensitive. Did you mean \`${fix}\`?`
        : `There is no OTTL function \`${name}\`.`;
    }
    return `\`${name}\` can't be used in this context.`;
  }

  // Invalid path segment, e.g. log.atributes.
  m = /segment "(\w+)" from path "([\w.]+)/.exec(message);
  if (m) {
    const [, segment, rawPath] = m;
    const before = rawPath.slice(0, rawPath.indexOf(segment)).replace(/\.$/, "");
    const fix = before ? suggestSegment(before, segment) : undefined;
    const shown = `${before ? before + "." : ""}${segment}`;
    return fix
      ? `\`${shown}\` isn't a valid path. Did you mean \`${before}.${fix}\`?`
      : `\`${shown}\` isn't a valid path${before ? ` — valid fields after \`${before}.\` include ${segmentsAfter(before).slice(0, 6).map((s) => "`" + s + "`").join(", ")}` : ""}.`;
  }

  // Syntax errors. Two formats: up to v0.162 "statement has invalid syntax: 1:25: …", from
  // v0.163 "1:25: statement has invalid syntax near `…`: …". An engine can't lex syntax added
  // after it (lambdas: `(k, v) => …`), so blame the newer feature when the statement uses one.
  const oldSyntax = /statement has invalid syntax: (\d+):(\d+): (?:lexer: )?([\s\S]*)$/.exec(message);
  const newSyntax = /(\d+):(\d+): statement has invalid syntax near `([^`]*)`/.exec(message);
  if (oldSyntax || newSyntax) {
    const col = Number((oldSyntax ?? newSyntax)![2]);
    const newer = functionsIn(statement).find((n) => unavailableReason(n, engineVersion));
    if (newer) {
      const gate = EXPERIMENTAL_FUNCTIONS[newer];
      return unavailableReason(newer, engineVersion)! + (gate ? ` It's experimental: ${gateAdvice(gate)}` : "");
    }
    if (/=>/.test(statement)) {
      return /\(\s*\w+\s*,\s*\w+\s*\)\s*=>/.test(statement)
        ? `The ${engineVersion} engine can't parse lambda syntax (\`=>\`) here.`
        : "OTTL lambdas take exactly two parameters, `(key_or_index, value) => …` — use `_` for one you don't need.";
    }
    const near = newSyntax
      ? newSyntax[3]
      : /invalid input text "([^"]{0,24})/.exec(oldSyntax![3])?.[1] ?? statement.slice(Math.max(0, col - 1), col + 15);
    return `Syntax error at column ${col}: the engine couldn't read \`${near.replace(/\\"/g, '"').trim()}\`.`;
  }

  // The engine reports an unqualified path and a statement with no path identically;
  // the statement text tells them apart.
  if (/path's first segment must be a valid context name|unable to infer a valid context/.test(message)) {
    const bare = unqualifiedPath(statement);
    if (bare) {
      return `\`${bare}\` needs its context prefix — write \`log.${bare}\`, \`span.${bare}\`, \`resource.${bare}\` and so on. The engine infers each statement's context from fully qualified paths.`;
    }
    if (/path's first segment must be a valid context name/.test(message)) {
      return "The engine couldn't tell which context this statement runs in, because it doesn't reference any path (for example `convert_gauge_to_sum(...)`). In a collector config you'd set `context:` on the block; the dry-run infers context from paths, so it can't run these statements yet.";
    }
    return "The engine couldn't infer which context these statements run in. Use fully qualified paths such as `log.attributes[\"x\"]` or `span.name`.";
  }

  if (/^invalid OTLP (logs|traces|metrics) JSON/.test(message)) {
    return "The sample payload isn't valid OTLP JSON for this signal. Fix the payload, not the statement.";
  }
  return undefined;
}
