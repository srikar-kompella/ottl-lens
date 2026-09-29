/**
 * Generate src/ottl/catalog.ts from the upstream OTTL reference, so the linter,
 * hover docs and autocomplete never drift from the real language.
 *
 * Sources of truth (opentelemetry-collector-contrib/pkg/ottl):
 *   ottlfuncs/README.md          ## Editors / ## Converters, one `### <name>` per function:
 *                                  signature line, description, "Examples:" list
 *   contexts/<ctx>/README.md     "| path | field accessed | type |" tables and enum tables
 *
 * Usage:
 *   node scripts/gen-catalog.mjs <contrib>/pkg/ottl [--engine <README.md> --engine-version vX.Y.Z]
 *
 * --engine points at ottlfuncs/README.md from the SAME contrib version the bundled
 * WASM engine is built with (see wasm/go.mod). The catalog is the union of both, so
 * the linter accepts functions valid on older and newer collectors, and records which
 * functions the bundled dry-run engine cannot execute.
 *
 * A sparse checkout is enough:
 *   git clone --depth 1 --filter=blob:none --sparse https://github.com/open-telemetry/opentelemetry-collector-contrib.git
 *   cd opentelemetry-collector-contrib && git sparse-checkout set pkg/ottl
 *   git fetch --depth 1 --filter=blob:none origin tag v0.146.0
 *   git show v0.146.0:pkg/ottl/ottlfuncs/README.md > /tmp/ottlfuncs-v0.146.0.md
 */

import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
if (!positional) {
  console.error("usage: node scripts/gen-catalog.mjs <contrib>/pkg/ottl [--engine <README.md> --engine-version vX.Y.Z]");
  process.exit(2);
}
const pkgDir = statSync(positional).isDirectory() ? resolve(positional) : resolve(dirname(positional), "..");
const funcsReadme = join(pkgDir, "ottlfuncs", "README.md");
if (!existsSync(funcsReadme)) {
  console.error(`not found: ${funcsReadme}`);
  process.exit(2);
}
const engineReadme = flag("--engine");
const engineVersion = flag("--engine-version") ?? "unknown";

const REPO = "https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/pkg/ottl";
const FUNCS_URL = `${REPO}/ottlfuncs/README.md`;
const problems = [];

/* ------------------------------------------------------------------ *
 * Markdown helpers
 * ------------------------------------------------------------------ */

function absolutizeLinks(text, baseUrl) {
  return text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, url) => {
    if (/^https?:/.test(url)) return `[${label}](${url})`;
    if (url.startsWith("#")) return `[${label}](${baseUrl}${url})`;
    return `[${label}](${new URL(url, baseUrl).toString()})`;
  });
}
const unlink = (s) => s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
const anchor = (heading) => heading.trim().toLowerCase().replace(/[^\w\- ]/g, "").replace(/ /g, "-");
const EXAMPLES_MARKER = /^(\*\*)?Examples?:?(\*\*)?:?\s*$/i;
const FENCE = /^```[\w-]*\s*$/; // a fence line on its own (not an inline ```code```)

/* ------------------------------------------------------------------ *
 * Functions
 * ------------------------------------------------------------------ */

function parseFunctions(text, label) {
  const lines = text.split(/\r?\n/);
  const editors = new Set();
  const converters = new Set();
  const docs = {};
  let section = null;
  let current = null;

  const finish = () => {
    if (!current) return;
    const { name, kind, body } = current;
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Signature on its own line, in 1–3 backticks: `f(a)` or ```f(a)```
    const sigRe = new RegExp("^`{1,3}(" + esc + "\\(.*?\\))`{1,3}\\s*$");
    let sigIdx = body.findIndex((l) => sigRe.test(l.trim()));
    let signature;
    if (sigIdx >= 0) {
      signature = sigRe.exec(body[sigIdx].trim())[1];
    } else {
      // Fallback: first inline `f(args)` anywhere in the prose (e.g. "`Values(target)` converts …").
      const inl = new RegExp("`(" + esc + "\\([^`]*\\))`");
      const hit = body.map((l) => inl.exec(l)).find(Boolean);
      signature = hit ? hit[1] : `${name}(…)`;
      if (!hit) problems.push(`[${label}] no signature for ${name}`);
      sigIdx = -1;
    }

    const paras = [];
    let buf = [];
    let inFence = false;
    const flush = () => { if (buf.length) { paras.push(buf.join(" ")); buf = []; } };
    for (let i = sigIdx + 1; i < body.length; i++) {
      const t = body[i].trim();
      if (FENCE.test(t)) { inFence = !inFence; flush(); continue; }
      if (inFence) continue;
      if (EXAMPLES_MARKER.test(t)) { flush(); break; }
      if (t.startsWith("#") || t.startsWith("|") || /^[-*]\s/.test(t)) { flush(); continue; }
      if (!t) { flush(); continue; }
      if (sigRe.test(t)) continue;
      buf.push(t);
    }
    flush();

    const summary = absolutizeLinks(paras[0] ?? "", FUNCS_URL);
    let details = "";
    for (const p of paras.slice(1)) {
      if ((details + p).length > 700) break;
      details += (details ? "\n\n" : "") + absolutizeLinks(p, FUNCS_URL);
    }
    if (!summary) problems.push(`[${label}] no description for ${name}`);

    const exStart = body.findIndex((l) => EXAMPLES_MARKER.test(l.trim()));
    const examples = [];
    if (exStart >= 0) {
      for (const l of body.slice(exStart + 1)) {
        const m = /^\s*[-*]\s+`(.+?)`(\s.*)?$/.exec(l); // tolerate trailing "# comment"
        if (m) examples.push(m[1]);
        if (examples.length === 3) break;
      }
    }
    docs[name] = { name, kind, signature, summary, details, examples, anchor: anchor(name) };
    current = null;
  };

  for (const line of lines) {
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    if (h2) {
      finish();
      const title = h2[1].toLowerCase();
      section = title === "editors" ? "editor" : title === "converters" ? "converter" : null;
      continue;
    }
    const h3 = /^###\s+(.+?)\s*$/.exec(line);
    if (h3) {
      finish();
      if (!section) continue;
      const name = (/^([A-Za-z_][A-Za-z0-9_]*)/.exec(h3[1]) || [])[1];
      if (!name) continue;
      (section === "editor" ? editors : converters).add(name);
      current = { name, kind: section, body: [] };
      continue;
    }
    if (current) current.body.push(line);
  }
  finish();
  if (editors.size === 0 || converters.size === 0) {
    console.error(`[${label}] parse error: editors=${editors.size} converters=${converters.size}.`);
    process.exit(1);
  }
  return { editors, converters, docs };
}

const main = parseFunctions(readFileSync(funcsReadme, "utf8"), "main");
const engine = engineReadme ? parseFunctions(readFileSync(engineReadme, "utf8"), engineVersion) : null;

const mainNames = new Set([...main.editors, ...main.converters]);
const engineNames = engine ? new Set([...engine.editors, ...engine.converters]) : mainNames;

const editors = new Set([...main.editors, ...(engine?.editors ?? [])]);
const converters = new Set([...main.converters, ...(engine?.converters ?? [])]);
const docs = { ...(engine?.docs ?? {}), ...main.docs }; // latest wording wins
const notInEngine = [...mainNames].filter((n) => !engineNames.has(n));
const removedUpstream = [...engineNames].filter((n) => !mainNames.has(n));

/* ------------------------------------------------------------------ *
 * Context paths and enums
 * ------------------------------------------------------------------ */

const CONTEXTS = [
  ["ottllog", "log"],
  ["ottlspan", "span"],
  ["ottlspanevent", "spanevent"],
  ["ottlmetric", "metric"],
  ["ottldatapoint", "datapoint"],
  ["ottlresource", "resource"],
  ["ottlscope", "instrumentation_scope"],
];
const paths = new Map();
const enums = new Map();
const cells = (row) => row.split("|").slice(1, -1).map((c) => c.trim());

for (const [dir, prefix] of CONTEXTS) {
  const file = join(pkgDir, "contexts", dir, "README.md");
  if (!existsSync(file)) { problems.push(`missing context README: ${dir}`); continue; }
  const rows = readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim().startsWith("|"));
  const own = [];
  const others = [];
  for (const row of rows) {
    const c = cells(row);
    if (c.length < 2 || /^-+$/.test(c[0]) || /^path$/i.test(c[0]) || /^enum symbol$/i.test(c[0])) continue;
    const first = c[0].replace(/\\([[\]])/g, "$1").replace(/`/g, "");
    if (/^[A-Z][A-Z0-9_]+$/.test(first) && /^-?\d+$/.test(c[1] ?? "")) {
      const e = enums.get(first) ?? { value: Number(c[1]), contexts: new Set() };
      e.contexts.add(prefix);
      enums.set(first, e);
      continue;
    }
    if (!/^[a-z_]+(\.|\[|$)/.test(first) || first.includes("*") || c.length < 3) continue;
    const entry = {
      path: first,
      description: unlink(c[1]).replace(/\s+/g, " "),
      type: unlink(c[2]).replace(/`/g, "").replace(/\s+/g, " "),
    };
    (first === prefix || first.startsWith(prefix + ".") || first.startsWith(prefix + "[") ? own : others).push(entry);
  }
  for (const e of [...own, ...others]) if (!paths.has(e.path)) paths.set(e.path, e);
}
if (paths.size === 0) problems.push("no context paths parsed");

/* ------------------------------------------------------------------ *
 * Emit
 * ------------------------------------------------------------------ */

let source = "unknown revision";
try {
  source = execSync(`git -C "${pkgDir}" log -1 --format="%h %cs"`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
} catch { /* not a git checkout */ }

const sort = (s) => [...s].sort((a, b) => a.localeCompare(b));
const lit = (arr) => arr.map((n) => `  ${JSON.stringify(n)}`).join(",\n");
const docsSorted = Object.fromEntries(sort(Object.keys(docs)).map((k) => [k, docs[k]]));
const enumsSorted = sort(enums.keys()).map((k) => ({ name: k, value: enums.get(k).value, contexts: sort(enums.get(k).contexts) }));

const out = `// AUTO-GENERATED by scripts/gen-catalog.mjs — do not edit by hand.
// Source: opentelemetry-collector-contrib pkg/ottl @ ${source}
//   ottlfuncs/README.md (functions) · contexts/*/README.md (paths, enums)
//   bundled engine reference: ${engineVersion}
// editors=${editors.size} converters=${converters.size} paths=${paths.size} enums=${enums.size}
//
// Editors  = functions that MUTATE telemetry (statement position).
// Converters = functions that RETURN a value. Names are case-sensitive.
// Both lists are the union of the latest reference and the bundled engine's version,
// so the linter accepts functions valid on older and newer collectors.

export const CATALOG_SOURCE = ${JSON.stringify(source)};
export const FUNCTIONS_DOC_URL = ${JSON.stringify(FUNCS_URL)};
/** contrib version the bundled WASM dry-run engine is built from (wasm/go.mod). */
export const ENGINE_VERSION = ${JSON.stringify(engineVersion)};

export const EDITORS: ReadonlySet<string> = new Set([
${lit(sort(editors))}
]);

export const CONVERTERS: ReadonlySet<string> = new Set([
${lit(sort(converters))}
]);

export const KNOWN_FUNCTIONS: ReadonlySet<string> = new Set<string>([
  ...EDITORS,
  ...CONVERTERS
]);

export const CASEFOLD_INDEX: ReadonlyMap<string, string> = new Map(
  [...KNOWN_FUNCTIONS].map((name) => [name.toLowerCase(), name])
);

/** In the latest reference but not in the bundled engine: lint-valid, but the dry-run can't execute them. */
export const NOT_IN_ENGINE: ReadonlySet<string> = new Set([
${lit(sort(notInEngine))}
]);

/** In the bundled engine's version but gone from the latest reference. */
export const REMOVED_UPSTREAM: ReadonlySet<string> = new Set([
${lit(sort(removedUpstream))}
]);

export interface FunctionDoc {
  name: string;
  kind: "editor" | "converter";
  signature: string;
  summary: string;
  details: string;
  examples: string[];
  /** Heading anchor in FUNCTIONS_DOC_URL. */
  anchor: string;
}

export const FUNCTION_DOCS: Readonly<Record<string, FunctionDoc>> = ${JSON.stringify(docsSorted, null, 2)};

export interface PathDoc {
  /** e.g. log.attributes[""] — [""] marks a map key, [] a slice index. */
  path: string;
  description: string;
  type: string;
}

export const CONTEXT_PATHS: readonly PathDoc[] = ${JSON.stringify([...paths.values()], null, 2)};

export interface EnumDoc {
  name: string;
  value: number;
  contexts: string[];
}

export const ENUMS: readonly EnumDoc[] = ${JSON.stringify(enumsSorted, null, 2)};
`;

const target = resolve(__dirname, "..", "src", "ottl", "catalog.ts");
writeFileSync(target, out, "utf8");
console.log(
  `wrote ${target}\n  source=${source} engine=${engineVersion}\n  editors=${editors.size} converters=${converters.size} ` +
  `paths=${paths.size} enums=${enums.size}\n  not-in-engine: ${sort(notInEngine).join(", ") || "-"}\n` +
  `  removed-upstream: ${sort(removedUpstream).join(", ") || "-"}`
);
if (problems.length) console.warn("warnings:\n  " + problems.join("\n  "));
