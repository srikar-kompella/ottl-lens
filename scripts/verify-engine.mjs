/**
 * Release gate: run the extension's core logic against the REAL bundled OTTL engine
 * (media/ottl.wasm), not a simulation. Unit tests use a fake engine; this catches the
 * cases where the fake and the real thing disagree (it has caught several).
 *
 * Usage:  npm run verify:engine      (requires media/ottl.wasm — npm run build:wasm)
 * Exit code is non-zero if any check fails.
 */

import { build } from "esbuild";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const wasmPath = join(root, "media", "ottl.wasm");
if (!existsSync(wasmPath)) {
  console.error("media/ottl.wasm not found — run `npm run build:wasm` first.");
  process.exit(2);
}

// Bundle the pure modules (no vscode dependency) into a temp CommonJS file.
const out = join(mkdtempSync(join(tmpdir(), "ottl-verify-")), "lib.cjs");
await build({
  stdin: {
    contents: `
      export { traceStatements, summarize } from "./src/ottl/trace";
      export { SAMPLES, samplePayloadText } from "./src/ottl/samples";
      export { normalizePayloadInput } from "./src/ottl/payload";
    `,
    resolveDir: root,
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: out,
  logLevel: "error",
});
const L = require(out);

// Load the engine the same way src/ottl/wasmRunner.ts does in the extension host.
require(join(root, "media", "wasm_exec.js"));
const go = new globalThis.Go();
const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), go.importObject);
void go.run(instance);
for (let t = Date.now(); typeof globalThis.ottlEval !== "function"; ) {
  if (Date.now() - t > 10000) throw new Error("engine did not register ottlEval");
  await new Promise((r) => setTimeout(r, 20));
}
const engine = (s, sig, p) => JSON.parse(globalThis.ottlEval(s, sig, p));

let failed = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : `\n      got: ${detail}`}`);
  if (!ok) failed++;
};
const sample = (id) => L.samplePayloadText(L.SAMPLES.find((s) => s.id === id));
const trace = (stmts, sig, payload, mode) => L.traceStatements(stmts, sig, payload, engine, mode);

// 1. The README demo: all four verdicts.
const demo = [
  'set(log.attributes["env"], "production")',
  'set(log.attributes["env.upper"], ConvertCase(log.attributes["env"], "upper"))',
  'set(log.attributes["env"], "production")',
  'set(log.attributes["tier"], "gold") where log.attributes["plan"] == "enterprise"',
  'keep_keys(log.attributes, ["env", "env.upper", "http.method"])',
].join("\n");
const d = trace(demo, "logs", sample("logs-simple"));
check("demo block: 3 changed · 1 had no effect · 1 matched nothing", L.summarize(d) === "3 changed · 1 had no effect · 1 matched nothing", L.summarize(d));
check("demo #1 blames only its own change (baseline works)", d.steps[0].display?.length === 1, JSON.stringify(d.steps[0].display));

// 2. Engine normalization on traces must not be blamed on statement #1.
const t = trace('set(span.attributes["team"], "payments")', "traces", sample("traces-simple"));
check("traces: statement #1 shows only its own change", t.steps[0].display?.length === 1, JSON.stringify(t.steps[0].display));

// 3. Documented silent failures are caught.
check("trace_id without .string → no effect", trace('set(span.trace_id, "4bf92f3577b34da6a3ce929d0e0e4736")', "traces", sample("traces-http-error")).steps[0].verdict === "no-effect");
check("set(metric.type, …) → no effect", trace("set(metric.type, METRIC_DATA_TYPE_SUM)", "metrics", sample("metrics-gauge")).steps[0].verdict === "no-effect");

// 4. Error handling and explanations.
const rt = 'set(log.attributes["a"], "1")\nset(log.attributes["j"], ParseJSON(log.body))\nset(log.attributes["b"], "2")';
check("runtime error under ignore continues", L.summarize(trace(rt, "logs", sample("logs-simple"), "ignore")) === "2 changed · 1 errored");
check("runtime error under propagate stops", L.summarize(trace(rt, "logs", sample("logs-simple"), "propagate")) === "1 changed · 1 errored");
const typo = trace('set(log.atributes["a"], "1")', "logs", sample("logs-simple")).steps[0];
check("path typo → did you mean log.attributes", /Did you mean `log\.attributes`/.test(typo.explanation ?? ""), typo.explanation);
const lam = trace('set(log.attributes["t"], Filter(log.attributes, (k, _) => k == "x"))', "logs", sample("logs-simple")).steps[0];
check("lambda → explained as newer than the engine", /can't parse yet/.test(lam.explanation ?? ""), lam.explanation);

// 5. Every sample and every debug-exporter conversion is accepted by the real engine.
for (const s of L.SAMPLES) {
  const probe = { logs: 'set(log.attributes["x"], "y")', traces: 'set(span.attributes["x"], "y")', metrics: 'set(metric.description, "y")' }[s.signal];
  const r = engine(probe, s.signal, L.samplePayloadText(s));
  check(`sample ${s.id} accepted`, r.ok, r.error);
}
const debugLog = ["ResourceLog #0", "ScopeLogs #0", "LogRecord #0", "Timestamp: 2026-09-21 12:53:20 +0000 UTC",
  "SeverityNumber: Info(9)", "Body: Str(hello)", "Attributes:", "     -> k: Int(5)"].join("\n");
const conv = L.normalizePayloadInput(debugLog);
const cr = engine('set(log.attributes["x"], "y")', "logs", conv.json);
check("debug-exporter text converts and the engine accepts it", conv.ok && cr.ok, cr.error);

console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll real-engine checks passed.");
process.exit(failed ? 1 : 0);
