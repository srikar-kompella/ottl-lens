// Scan a directory of collector YAML configs: extract embedded OTTL, lint each
// statement, and report findings as file:line. Doubles as the real-world test
// harness and the "corpus scan" for impact.
//
// Usage: node scripts/scan.mjs <dir-or-file> [<dir-or-file> ...]
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { extractOTTL } from "../out/ottl/yaml.js";
import { lint } from "../out/ottl/linter.js";

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error("usage: node scripts/scan.mjs <dir-or-file> ...");
  process.exit(2);
}

function* walk(p) {
  const st = statSync(p);
  if (st.isDirectory()) {
    for (const e of readdirSync(p)) yield* walk(join(p, e));
  } else if ([".yaml", ".yml"].includes(extname(p))) {
    yield p;
  }
}

let files = 0, withOttl = 0, statements = 0, findings = 0;
const byCode = {};

for (const root of roots) {
  for (const file of walk(root)) {
    files++;
    let text;
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    let extracted;
    try { extracted = extractOTTL(text); } catch (e) { continue; }
    if (extracted.length === 0) continue;
    withOttl++;
    for (const ex of extracted) {
      statements++;
      const diags = lint(ex.text);
      for (const d of diags) {
        findings++;
        byCode[d.code] = (byCode[d.code] || 0) + 1;
        const rel = file.replace(process.cwd() + "/", "");
        console.log(`${rel}:${ex.line + 1}  [${d.severity}] ${d.code}  ${d.message}`);
        console.log(`    ${ex.dialect} in ${ex.component} (context=${ex.context ?? "inferred"}): ${ex.text}`);
      }
    }
  }
}

console.log("\n=== SCAN SUMMARY ===");
console.log(`files scanned:        ${files}`);
console.log(`files with OTTL:      ${withOttl}`);
console.log(`OTTL strings found:   ${statements}`);
console.log(`lint findings:        ${findings}`);
console.log(`by code:`, byCode);
