/**
 * Release gate: run the extension's core logic against the REAL OTTL engines, not a
 * simulation. Unit tests use a fake engine; this catches the cases where the fake and the
 * real thing disagree (it has caught several).
 *
 *   1. the bundled engine (media/ottl.wasm, latest);
 *   2. every downloadable engine (OTTL_ENGINES_DIR, default .engines/ from `npm run fetch:engines`; the files
 *      published in the `engines-1` GitHub release), each verified against the sha256
 *      pinned in src/ottl/engines.ts, then checked at the behaviour boundary it exists for.
 *
 * Usage:  npm run verify:engine                 (all engines)
 *         node scripts/verify-engine.mjs --bundled-only
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
      export { checkTypes } from "./src/ottl/typecheck";
      export { lint } from "./src/ottl/linter";
      export { scanForPii } from "./src/ottl/redact";
      export { loadEngine, verifyAndUnpack } from "./src/ottl/engineHost";
      export { ENGINES, BUNDLED_ENGINE } from "./src/ottl/engines";
      export { compareTraces } from "./src/ottl/compare";
      export { atLeast } from "./src/ottl/versions";
      export { collectStatementsForDryRun } from "./src/ottl/yaml";
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

// Load engines exactly as the extension does (src/ottl/engineHost.ts).
const shim = join(root, "media", "wasm_exec.js");
const bundled = await L.loadEngine(L.BUNDLED_ENGINE, readFileSync(wasmPath), shim);
const engine = (s, sig, p) => bundled.eval(s, sig, p);

let failed = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : `\n      got: ${detail}`}`);
  if (!ok) failed++;
};
const sample = (id) => L.samplePayloadText(L.SAMPLES.find((s) => s.id === id));
const trace = (stmts, sig, payload, mode) => L.traceStatements(stmts, sig, payload, engine, mode, { engineVersion: L.BUNDLED_ENGINE });
console.log(`— bundled engine ${L.BUNDLED_ENGINE} —`);

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
const tid = trace('set(span.trace_id, "4bf92f3577b34da6a3ce929d0e0e4736")', "traces", sample("traces-http-error")).steps[0];
check("trace_id hex string → run-time error on the latest engine (silent only up to v0.149)", tid.verdict === "error" && tid.errorClass === "runtime", tid.verdict);
check("set(metric.type, …) → no effect", trace("set(metric.type, METRIC_DATA_TYPE_SUM)", "metrics", sample("metrics-gauge")).steps[0].verdict === "no-effect");

// 4. Error handling and explanations.
const rt = 'set(log.attributes["a"], "1")\nset(log.attributes["j"], ParseJSON(log.body))\nset(log.attributes["b"], "2")';
check("runtime error under ignore continues", L.summarize(trace(rt, "logs", sample("logs-simple"), "ignore")) === "2 changed · 1 errored");
check("runtime error under propagate stops", L.summarize(trace(rt, "logs", sample("logs-simple"), "propagate")) === "1 changed · 1 errored");
const typo = trace('set(log.atributes["a"], "1")', "logs", sample("logs-simple")).steps[0];
check("path typo → did you mean log.attributes", /Did you mean `log\.attributes`/.test(typo.explanation ?? ""), typo.explanation);
const lambdaStmt = 'set(log.attributes["t"], Filter(log.attributes, (k, _) => k == "x"))';
const lam = trace(lambdaStmt, "logs", sample("logs-simple")).steps[0];
check("lambda without its gate → explained, with how to enable it in the dry-run", /ottl\.dryRun\.featureGates/.test(lam.explanation ?? ""), lam.explanation);
check("feature gate on → the lambda runs", bundled.setFeatureGate("ottl.functions.enableLambda", true) === "" &&
  trace(lambdaStmt, "logs", sample("logs-simple")).steps[0].verdict === "changed");
bundled.setFeatureGate("ottl.functions.enableLambda", false);
const nilSet = trace('set(log.attributes["service"], log.attributes["missing"])', "logs", sample("logs-simple")).steps[0];
check("set() from a missing attribute → 'wrote an empty value' with a guard suggestion (v0.161+)",
  nilSet.verdict === "changed" && nilSet.caution === true && /!= nil/.test(nilSet.note ?? ""), JSON.stringify(nilSet));

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

// 6. Type checks agree with the engine, and every quick fix actually works.
//    Fixtures follow the trade harness (ottl-silence-matrix/fixtures/README.md).
const SPAN = JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [{ traceId: "0102030405060708090a0b0c0d0e0f10", spanId: "0102030405060708", name: "orig", kind: 1, startTimeUnixNano: "1", endTimeUnixNano: "2" }] }] }] });
const METRIC = JSON.stringify({ resourceMetrics: [{ scopeMetrics: [{ metrics: [{ name: "orig_sum", sum: { aggregationTemporality: 2, isMonotonic: true, dataPoints: [{ timeUnixNano: "1", asInt: "1" }] } }] }] }] });
const LOG = JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: [{ timeUnixNano: "1", severityNumber: 9, body: { stringValue: "orig" } }] }] }] });
const fixed = (s, i) => s.slice(0, i.fix.start) + i.fix.replacement + s.slice(i.fix.end);
for (const [label, stmt, sig, payload] of [
  ["A2 metric.type == \"Sum\"", 'set(metric.description, "x") where metric.type == "Sum"', "metrics", METRIC],
  ["A4 span.trace_id == hex", 'set(span.name, "x") where span.trace_id == "0102030405060708090a0b0c0d0e0f10"', "traces", SPAN],
  ["A6 severity_number == \"9\"", 'set(log.body, "x") where log.severity_number == "9"', "logs", LOG],
]) {
  const before = trace(stmt, sig, payload).steps[0];
  check(`${label}: flagged statically and the trace says it can never match`,
    L.checkTypes(stmt).length === 1 && before.verdict === "not-matched" && /can never match/.test(before.note ?? ""), before.note);
  const after = trace(fixed(stmt, L.checkTypes(stmt)[0]), sig, payload).steps[0];
  check(`${label}: after the quick fix the statement changes the payload`, after.verdict === "changed", after.verdict);
}
const c1 = 'set(span.trace_id, "11111111111111111111111111111111")';
check("C1 set(span.trace_id, hex): flagged, and the .string fix works",
  L.checkTypes(c1).length === 1 && trace(fixed(c1, L.checkTypes(c1)[0]), "traces", SPAN).steps[0].verdict === "changed");
const c2 = 'set(log.severity_number, "WARN")';
check("C2 set(log.severity_number, \"WARN\"): flagged, and the enum fix works",
  L.checkTypes(c2).length === 1 && trace(fixed(c2, L.checkTypes(c2)[0]), "logs", LOG).steps[0].verdict === "changed");
const typoStmt = 'set(log.atributes["a"], "1")';
const typoDiag = L.lint(typoStmt).find((d) => d.code === "ottl.unknownPath");
check("path typo quick fix produces a working statement", !!typoDiag && trace(fixed(typoStmt, typoDiag), "logs", LOG).steps[0].verdict === "changed");

const bareStmt = 'set(attributes["env"], "prod")';
const bareDiag = L.lint(bareStmt, { inferredSignal: "logs" }).find((d) => d.code === "ottl.missingContext");
check("context prefix quick fix produces a working statement",
  !!bareDiag && trace(fixed(bareStmt, bareDiag), "logs", LOG).steps[0].verdict === "changed");

// 7. propagate wording and the redaction check, on real output.
const rt2 = trace('set(log.attributes["j"], ParseJSON(log.body))', "logs", sample("logs-simple"), "propagate").steps[0];
check("propagate consequence says the whole batch is dropped", /whole batch/.test(rt2.consequence ?? ""), rt2.consequence);
const redact = trace([
  'merge_maps(log.attributes, ParseJSON(log.body), "upsert")',
  'delete_key(log.attributes, "user_email")',
].join("\n"), "logs", sample("logs-json-body-pii"));
const pii = L.scanForPii(JSON.parse(redact.finalOutput)).map((f) => f.label);
check("redaction check: deleting the attribute still leaves the email in log.body",
  !pii.includes('log.attributes["user_email"]') && pii.includes("log.body"), JSON.stringify(pii));

// 8. Lint rules that claim "the collector rejects this" — confirm on the real engine.
const SLICE_CASES = [
  ['keep_keys(log.attributes, "http.method")', "logs"],
  ['set(log.body, Concat("a", "-"))', "logs"],
  ['set(log.body, Format("%d", 5))', "logs"],
  ['limit(log.attributes, 1, "a")', "logs"],
  ['set(log.attributes["c"], IsInCIDR("10.0.0.1", "10.0.0.0/8"))', "logs"],
];
for (const [stmt, sig] of SLICE_CASES) {
  const diag = L.lint(stmt).find((x) => x.code === "ottl.sliceArgument");
  const before = engine(stmt, sig, LOG);
  const after = diag ? engine(fixed(stmt, diag), sig, LOG) : { ok: false };
  check(`list argument: \`${stmt}\` is flagged, the engine rejects it, and the fix is accepted`,
    !!diag && !before.ok && /^OTTL parse error/.test(before.error) && after.ok, diag ? (before.error ?? after.error) : "not flagged");
}
// Transform/filter-processor functions: lint-clean and runnable.
for (const [stmt, sig, payload] of [
  ['convert_sum_to_gauge() where metric.name == "orig_sum"', "metrics", METRIC],
  ['scale_metric(10.0) where metric.name == "orig_sum"', "metrics", METRIC],
  ['set(log.attributes["cef"], ParseCEF("CEF:0|Security|threatmanager|1.0|100|worm stopped|10|src=10.0.0.1"))', "logs", LOG],
]) {
  const unknown = L.lint(stmt).filter((x) => x.code === "ottl.unknownFunction");
  const r = engine(stmt, sig, payload);
  check(`component function \`${stmt.split("(")[0] === "set" ? "ParseCEF" : stmt.split("(")[0]}\`: no unknown-function warning, engine accepts it`, unknown.length === 0 && r.ok, r.error ?? JSON.stringify(unknown));
}

// 9. Every downloadable engine: integrity, samples, and the boundary it exists for.
if (!process.argv.includes("--bundled-only")) {
  const dir = resolve(process.env.OTTL_ENGINES_DIR ?? (existsSync(join(root, ".engines")) ? join(root, ".engines") : join(root, "..", "ottl-engines")));
  const engines = {};
  for (const info of L.ENGINES) {
    const file = join(dir, `ottl-${info.version}.wasm.gz`);
    if (!existsSync(file)) { check(`engine ${info.version}: file present in ${dir}`, false, "missing"); continue; }
    let bytes;
    try { bytes = L.verifyAndUnpack(readFileSync(file), info); } catch (e) { check(`engine ${info.version}: checksum matches engines.ts`, false, e.message); continue; }
    engines[info.version] = info.version === L.BUNDLED_ENGINE ? bundled : await L.loadEngine(info.version, bytes, shim);
    check(`engine ${info.version}: checksum matches and it starts`, true);
  }
  const on = (v) => (s, sig, p) => engines[v].eval(s, sig, p);
  const tr = (v, stmts, sig, payload, mode = "ignore") => L.traceStatements(stmts, sig, payload, on(v), mode, { engineVersion: v });
  console.log("\n— every engine —");
  for (const v of Object.keys(engines)) {
    const bad = L.SAMPLES.filter((s) => !engines[v].eval({ logs: 'set(log.attributes["x"], "y")', traces: 'set(span.attributes["x"], "y")', metrics: 'set(metric.description, "y")' }[s.signal], s.signal, L.samplePayloadText(s)).ok);
    const dv = tr(v, demo, "logs", sample("logs-simple"));
    check(`${v}: all ${L.SAMPLES.length} samples accepted; demo block traces the same`, bad.length === 0 && L.summarize(dv) === "3 changed · 1 had no effect · 1 matched nothing", bad.map((s) => s.id).join(",") || L.summarize(dv));
  }
  console.log("\n— behaviour boundaries (each engine on both sides) —");
  const has = (v) => !!engines[v];
  const stepOn = (v, stmt, sig, payload) => tr(v, stmt, sig, payload).steps[0];
  const USER = JSON.stringify({ resourceLogs: [{ resource: {}, scopeLogs: [{ scope: {}, logRecords: [{ body: { stringValue: "hi" }, attributes: [{ key: "user", value: { stringValue: "alice" } }, { key: "s", value: { stringValue: "abc" } }, { key: "keys", value: { stringValue: "user,s" } }] }] }] }] });
  for (const v of Object.keys(engines)) {
    // trace_id hex: silent ≤ v0.149, run-time error from v0.150.
    const s1 = stepOn(v, 'set(span.trace_id, "11111111111111111111111111111111")', "traces", SPAN);
    const want1 = L.atLeast(v, "v0.150.0") ? "error" : "no-effect";
    check(`${v}: trace_id hex string → ${want1}${want1 === "no-effect" ? " with the version hint" : ""}`, s1.verdict === want1 && (want1 === "error" || /From v0\.150 it is a run-time error/.test(s1.note ?? "")), s1.verdict + " " + (s1.note ?? ""));
    // severity_number string: silent ≤ v0.140, error from v0.141.
    const s2 = stepOn(v, 'set(log.severity_number, "INFO")', "logs", LOG);
    const want2 = L.atLeast(v, "v0.141.0") ? "error" : "no-effect";
    check(`${v}: severity_number = "INFO" → ${want2}`, s2.verdict === want2, s2.verdict);
    // set() from a missing value: skipped ≤ v0.160, writes an empty value from v0.161.
    const s3 = stepOn(v, 'set(log.attributes["user"], log.attributes["missing"])', "logs", USER);
    const empty = L.atLeast(v, "v0.161.0");
    check(`${v}: set(user, <missing>) → ${empty ? "overwrites user with an empty value (cautioned)" : "no effect, hint names the v0.161 change"}`,
      empty ? s3.verdict === "changed" && s3.caution === true && s3.display?.[0]?.text === '"alice" → (empty)'
            : s3.verdict === "no-effect" && /From v0\.161 set\(\) writes nil as an EMPTY value/.test(s3.note ?? ""), JSON.stringify([s3.verdict, s3.display, s3.note]));
    // A failed conversion: nil up to v0.159, an error from v0.160 (#50564).
    const s4 = stepOn(v, 'set(log.attributes["n"], Int(log.attributes["s"]))', "logs", USER);
    const want4 = L.atLeast(v, "v0.160.0") ? "error" : "no-effect";
    check(`${v}: Int("abc" from a path) → ${want4}`, s4.verdict === want4, s4.verdict);
    // A list argument from a converter: from v0.163 (beta gate, on by default).
    const s5 = stepOn(v, 'keep_keys(log.attributes, Split(log.attributes["keys"], ","))', "logs", USER);
    const dyn = L.atLeast(v, "v0.163.0");
    check(`${v}: keep_keys(…, Split(…)) → ${dyn ? "changed" : "config error explained"}`, dyn ? s5.verdict === "changed" : s5.verdict === "error" && s5.errorClass === "config" && /expects a list/.test(s5.explanation ?? ""), s5.verdict + " " + (s5.explanation ?? s5.error ?? ""));
    // A function newer than the engine is named as such.
    if (!L.atLeast(v, "v0.160.0")) {
      const s6 = stepOn(v, "clear(log.attributes)", "logs", USER);
      check(`${v}: clear() → "added after …, pick v0.160.0 or newer"`, /Pick collector version v0\.160\.0 or newer/.test(s6.explanation ?? ""), s6.explanation ?? s6.error);
    } else {
      const s6 = stepOn(v, "clear(log.attributes)", "logs", USER);
      check(`${v}: clear() runs`, s6.verdict === "changed", s6.verdict + " " + (s6.error ?? ""));
    }
  }
  if (has("v0.157.0")) {
    console.log("\n— version compare —");
    const block = ['set(log.attributes["user"], log.attributes["missing"])', 'set(log.attributes["ok"], "yes")'].join("\n");
    const c = L.compareTraces(tr("v0.157.0", block, "logs", USER), tr(L.BUNDLED_ENGINE, block, "logs", USER), "v0.157.0", L.BUNDLED_ENGINE);
    check("compare v0.157.0 → latest: exactly the set-writes-nil statement differs",
      c.differences.length === 1 && c.differences[0].index === 0 && c.differences[0].a.verdict === "no effect" && c.differences[0].b.verdict === "wrote an empty value", JSON.stringify(c.differences));
    // The example config's upgrade-check block, as a user would run it from the editor.
    const yamlText = readFileSync(join(root, "examples", "collector.yaml"), "utf8");
    const line = yamlText.split("\n").findIndex((l) => l.includes('set(log.attributes["owner"]'));
    const blk = L.collectStatementsForDryRun(yamlText, line);
    const cx = L.compareTraces(tr("v0.157.0", blk.statements, "logs", sample("logs-simple")), tr(L.BUNDLED_ENGINE, blk.statements, "logs", sample("logs-simple")), "v0.157.0", L.BUNDLED_ENGINE);
    check("examples/collector.yaml upgrade-check: both statements change behaviour between v0.157.0 and latest",
      cx.differences.length === 2 && cx.differences[0].b.verdict === "wrote an empty value" && cx.differences[1].a.verdict === "no effect" && cx.differences[1].b.verdict === "error", JSON.stringify(cx.differences.map((x) => [x.a.verdict, x.b.verdict])));
  }
}

console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll real-engine checks passed.");
process.exit(failed ? 1 : 0);
