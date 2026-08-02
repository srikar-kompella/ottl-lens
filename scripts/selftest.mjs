// Minimal self-test for the pure linter (no VS Code host needed).
// Run: npm run compile && node scripts/selftest.mjs
import { lint } from "../out/ottl/linter.js";

const sample = [
  'set(attributes["environment"], "production") where attributes["environment"] == nil', // clean
  'set(attributes["x"], ParseJson(body))', // unknown function (ParseJson -> ParseJSON)
  'set(attributes["env"] = "prod")', // single '='
  'set(attributes["y"], Concat(["a", "b"], "-")', // unclosed (
  'set(attributes["z"], "unterminated', // unterminated string
  'delete_key(attributes, "temp") where' // empty where
].join("\n");

const diags = lint(sample);
const codes = diags.map((d) => d.code);

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else {
    console.log("ok  :", msg);
  }
}

// line 0 (clean) should produce no diagnostics
assert(!diags.some((d) => d.line === 0), "clean statement -> no diagnostics");
assert(codes.includes("ottl.unknownFunction"), "detects unknown function (ParseJson)");
assert(
  diags.some((d) => d.code === "ottl.unknownFunction" && /ParseJSON/.test(d.message)),
  "suggests correct casing ParseJSON"
);
assert(codes.includes("ottl.singleEquals"), "detects single '='");
assert(codes.includes("ottl.delimiters"), "detects unclosed '('");
assert(codes.includes("ottl.unterminatedString"), "detects unterminated string");
assert(codes.includes("ottl.emptyWhere"), "detects empty where");

console.log(`\n${diags.length} diagnostics total`);
for (const d of diags) {
  console.log(`  L${d.line + 1}:${d.startCol + 1} [${d.severity}] ${d.code} — ${d.message}`);
}
