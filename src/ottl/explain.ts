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
  KNOWN_FUNCTIONS,
  NOT_IN_ENGINE,
} from "./catalog";

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

const CONTEXT_NAMES = new Set(["log", "span", "spanevent", "metric", "datapoint", "resource", "instrumentation_scope", "scope", "profile"]);

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
export function explainEngineError(message: string, statement = ""): string | undefined {
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
    if (NOT_IN_ENGINE.has(name)) {
      return `\`${name}\` is a real OTTL function, but it was added after ${ENGINE_VERSION}, the version the bundled dry-run engine is built from, so it can't be executed here yet. Collectors on newer versions support it.`;
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
