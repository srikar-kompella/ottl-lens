# OTTL Lens (community)

**See what your OTTL actually does, statement by statement, before it reaches a collector.**

OTTL Lens brings the OpenTelemetry Transformation Language (OTTL) feedback loop into VS Code. It lints OTTL **inside your Collector config** (where OTTL actually lives), documents and autocompletes functions and paths, and runs your statements offline with the **real upstream OTTL engine for your collector version**. Then it tells you what each statement did, including the ones that silently did nothing, and what will change when you upgrade.

> **Community project. Not affiliated with, endorsed by, or sponsored by the OpenTelemetry project or CNCF.**
> OpenTelemetry and OTTL are trademarks of their respective owners. This extension tracks the
> upstream OTTL reference but is independently maintained.

---

## Why

OTTL fails quietly. A statement can be valid, raise no error, and change nothing. You find out when data goes missing in production. The usual way to check is to run a local collector with a `debug` exporter, feed it telemetry, and read `docker logs`, one iteration at a time.

OTTL Lens does that loop in the editor, in about a second, with the same transform processor a collector runs.

## Features

| Feature | What it does |
|---|---|
| **▶ Dry-run from the editor** | A **▶ Dry-run** button above every runnable transform block (and at the top of `.ottl` files) opens the panel and runs that block. |
| **True for your collector version** | Pick the collector version the dry-run uses, or let OTTL Lens find it in your workspace (compose files, Helm values, Dockerfiles, `go.mod`). Engines for 9 versions from v0.140 to v0.164.1 are built from the real transform processor; the latest is bundled, the others download on request. |
| **Upgrade check** | **Compare with** another version: the same block and payload run on both engines, and OTTL Lens lists every statement whose result changes. For example, a `set()` that did nothing on v0.157 but writes an empty value on v0.161+. |
| **Per-statement trace** | Runs your statements one at a time with the real engine and gives each a verdict: `changed` (with a diff), **`no effect`**, `matched nothing`, or `error`. The verdict also appears **at the end of each statement's line** in your YAML; hover it for the detail. |
| **"Can never match" checks** | Flags comparisons that are valid but can never be true because a typed field is compared with a string: `metric.type == "Sum"`, `span.trace_id == "0102…"`, `log.severity_number == "9"`. Also string assignments to typed fields such as `set(span.trace_id, "<hex>")`. |
| **Quick fixes** | One click: `"Sum"` → `METRIC_DATA_TYPE_SUM`, `span.trace_id` → `span.trace_id.string`, `"9"` → `9`, `log.atributes` → `log.attributes`, `parsejson` → `ParseJSON`, `Base64Decode(x)` → `Decode(x, "base64")`, `keep_keys(x, "a")` → `keep_keys(x, ["a"])`, deprecated `flatten_data: true` → `flatten: { log: true }`. Each OTTL fix was checked to make the statement work on the real engine. |
| **Redaction check** | After a run, lists values in the output that still look like personal data or credentials (emails, card numbers, JWTs, bearer tokens, SSNs). For example, an email you removed from the attributes but that is still inside `log.body`. |
| **Readable diffs, in OTTL** | Changes are shown as OTTL paths and values: `+ log.attributes["env"] = "production"`, `− log.attributes["environment"] = "staging"`. Type changes are called out: `200 → "200" (int → string)`. |
| **Paste what you already have** | The payload box accepts OTLP JSON, JSON Lines from the file exporter, or **raw `debug` exporter output** straight from `docker logs`, converted automatically, with the signal detected from the content. |
| **Realistic samples** | Nine built-in payloads shaped around real transforms: a k8s log with a JSON body and PII, health-check noise, an errored HTTP span with an exception event, a SQL span with an email in the query, counters, histograms. |
| **Errors you can act on** | Engine errors are translated: `log.atributes` → *did you mean `log.attributes`?*, `parsejson` → *did you mean `ParseJSON`?*, `attributes["x"]` → *needs its context prefix*. Config errors ("the collector won't start") are kept separate from runtime errors ("what `error_mode` does"). |
| **`error_mode` that actually changes the result** | The dry-run uses your block's own `error_mode`. With `propagate`, a runtime error drops the whole batch the processor received and the trace stops; with `ignore` or `silent`, the trace continues past the failed statement, as a collector would. If your config doesn't set it, you're told the default for the collector version you picked: `ignore` since v0.153, `propagate` before. |
| **Feature gates** | Add gates to `ottl.dryRun.featureGates` (as you'd pass `--feature-gates`). For example, `ottl.functions.enableLambda` runs the experimental lambda functions (`Filter`, `MapEach`, …) on v0.157+ engines. |
| **Hover docs** | Hover any function, path or enum: signature, description, examples and a link to the upstream reference. Paths show their type (`log.severity_number` → `int64`). |
| **Autocomplete** | Functions with argument placeholders (editors only at the start of a statement), context fields after `log.` / `span.` / `metric.` / `datapoint.` / `resource.`, enums and keywords. Works while the YAML is half-typed. |
| **Collector-YAML aware linting** | Finds and lints OTTL in `transform` / `filter` processors (flat, advanced and legacy shapes) and the `routing` connector, on the right lines. Unknown / mis-cased functions, unbalanced delimiters, single `=`, unterminated strings, empty `where`. |
| **Version-aware** | The catalog is generated from contrib v0.164.1 (OTTL 1.x stable), including the transform processor's own functions (`convert_gauge_to_sum`, `extract_count_metric`, `ParseCEF`, …) and the filter processor's (`HasAttrOnDatapoint`). Hover says when a function appeared; if you run one on an engine that predates it, the dry-run says which version you need. Removed functions get a migration hint (`Base64Decode` → `Decode(value, "base64")`). |
| Syntax highlighting | For `.ottl` files. |

See [OTTL behaviour by Collector version](VERSION_CHANGES.md) for the upgrade boundaries, examples and upstream release references.

## Getting started

1. Install **OTTL Lens**:
   - **VS Code:** from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=srikar-kompella.ottl-lens), or search "OTTL Lens" in the Extensions view.
   - **Cursor, Windsurf, VSCodium, Gitpod:** from [Open VSX](https://open-vsx.org/extension/srikar-kompella/ottl-lens) (these editors use the Open VSX registry).
2. Open a Collector config or a `.ottl` file. Linting, hover and autocomplete work immediately.
3. Click **▶ Dry-run** above a `transform` block (or run **OTTL: Dry Run** from the Command Palette).
4. Check the **Collector** version in the panel (it's preselected from your workspace when OTTL Lens finds one), and pick an older or newer version under **Compare with** to see what an upgrade changes.

## Dry-run

The panel loads the statements from the active `.ottl` file, or from the `transform` block at your cursor (and follows that block's signal).

**Payload.** Pick a sample, click **Open file…**, or paste your own. Whatever you paste is converted when you run:

- **OTLP JSON:** used as-is.
- **JSON Lines** (the file exporter's format, one export request per line): merged.
- **`debug` exporter output** (`verbosity: detailed`): converted to OTLP JSON, including when it's wrapped in zap log prefixes, docker-compose prefixes, or a collector logging as JSON.

The converted JSON replaces your paste in the box, so you can see and edit exactly what ran.

**Per-statement trace.** Click **▶ Run**:

| Verdict | Meaning |
|---|---|
| **changed** | The statement modified the payload, shown as a diff in OTTL paths. |
| **no effect** | The statement ran without error and changed **nothing**. Usually a bug. |
| **matched nothing** | The `where` guard excluded every record in this payload. If the guard compares a typed field with a string, it says the clause **can never match** any payload. |
| **error** | The engine rejected it, with an explanation and what happens next. |

`no effect` is the point. These are real, silent failures, each reproduced on the engines on both sides of the version where it changed:

- `set(metric.type, METRIC_DATA_TYPE_SUM)` is accepted and does nothing on every version; changing a metric's type needs a conversion function such as `convert_gauge_to_sum()`.
- `set(span.trace_id, "4bf92f…")` does nothing up to v0.149 and is a run-time error from v0.150. The field is bytes; use `span.trace_id.string`.
- `set(log.attributes["user"], log.attributes["missing"])` does nothing up to v0.160. **From v0.161 it overwrites `user` with an empty value.** OTTL Lens marks that step **wrote an empty value** and suggests `where log.attributes["missing"] != nil`.
- `set(log.attributes["n"], Int(log.attributes["s"]))` with a non-numeric `s` writes nothing up to v0.159 and is a run-time error from v0.160.

OTTL Lens flags each one, for the version you picked, and says why. To tell "did nothing" apart from "guard matched nothing", the trace re-runs the statement without its `where` clause: if the unguarded form *does* change the payload, the guard was the reason.

Open `examples/collector.yaml` and dry-run the `transform/logs` block to see all four verdicts at once. Then dry-run `transform/upgrade-check` with **Compare with: v0.157.0** to see two statements change behaviour across versions.

**Network.** The bundled engine runs entirely offline in the extension host via WebAssembly. Picking another collector version downloads that engine once (about 5 MB) from this extension's [GitHub release](https://github.com/srikar-kompella/ottl-lens/releases/tag/engines-1), after you agree; it is checked against a sha256 built into the extension before it ever runs, and cached. Nothing else goes over the network.

## Known limitations

- **Engines exist for 9 collector versions** (v0.140.0, v0.146.0, v0.150.0, v0.153.0, v0.157.0, v0.160.0, v0.161.0, v0.163.0, v0.164.1), the releases where a documented OTTL behaviour changed. For a version in between, OTTL Lens uses the closest engine at or below it; every behaviour it reports on is the same between those boundaries, but other changes in intermediate releases are not modelled.
- **Statements without any path can't be dry-run** (e.g. `convert_gauge_to_sum(...)`). The engine infers each statement's context from its paths; in a collector config you would set `context:` on the block.
- **The dry-run executes statements, not filter conditions.** Filter conditions are linted, documented and autocompleted.
- **`ignore`/`silent` are simulated per statement.** If a statement fails for only some records, a real collector would still apply it to the others; the dry-run skips it for all of them.
- **Debug-exporter conversion** covers logs, spans (with events) and gauge / sum / histogram metrics. Exponential histograms, summaries, span links and exemplars are skipped, with a note.
- **Processor-level settings aren't executed.** The dry-run runs your statements with the default processor config; `flatten`, `context:` and similar settings are linted, not simulated.
- **The catalog tracks the latest collector release** (currently v0.164.1), not unreleased changes on `main`.
- **The linter is heuristic, not a parser.** It catches structural, naming and type mistakes; anything else is checked authoritatively by the dry-run. Path-typo warnings only appear when there is a close match in the catalog.
- **Quick fixes in double-quoted YAML** (`- "set(…)"`) aren't offered, because escapes shift positions; diagnostics still appear. Plain and single-quoted values get fixes.
- **Templated configs are best-effort.** Helm / Go-templated YAML that doesn't parse yields no lint diagnostics; hover and autocomplete still work line by line.

## Develop

```bash
npm install
npm run fetch:engines   # download the OTTL engines (checksum-verified); no Go needed
npm run compile      # build the extension (tsc)
npm test             # run unit tests (vitest)
npm run coverage     # run tests with coverage (fails under 90% on src/ottl/**)
npm run build:wasm   # (re)build the bundled WASM engine (requires Go)
bash scripts/build-engines.sh   # build every supported version → ../ottl-engines (+ bundle the latest)
npm run verify:engine           # real-engine release gate: bundled + every engine at its boundary
node scripts/check-panel.mjs    # headless webview check (npm i --no-save jsdom first)
# Regenerate the catalog (functions, paths, enums) from a contrib checkout, plus the
# function reference from the engine's version (see the header of scripts/gen-catalog.mjs):
npm run gen:catalog -- <contrib>/pkg/ottl --engine-version v0.164.1 \
  --component transform=<contrib>/processor/transformprocessor/README.md \
  --component filter=<contrib>/processor/filterprocessor/README.md \
  --history <dir of ottlfuncs-/xottl-/transform-/filter-vX.Y.Z.md per engine version>
# Press F5 in VS Code to launch the Extension Development Host, then open
# examples/collector.yaml or examples/sample.ottl.
```

## Design

- **Catalog** (`src/ottl/catalog.ts`, generated by `scripts/gen-catalog.mjs`): function signatures, descriptions and examples from `pkg/ottl/ottlfuncs/README.md`; the path tables and enums of every context from `pkg/ottl/contexts/*/README.md`. Nothing is hand-typed, so it never drifts from upstream.
- **Trace** (`src/ottl/trace.ts`): runs growing prefixes of the block and diffs consecutive outputs, so no engine changes are needed. Diffs are taken against the engine's own normalized form of the input (it canonicalizes payloads, e.g. adding an empty `status` to spans), so no statement is blamed for the engine's normalization. `src/ottl/present.ts` renders diffs as OTTL paths; `src/ottl/explain.ts` translates engine errors.
- **Payloads** (`src/ottl/payload.ts`, `src/ottl/debugText.ts`, `src/ottl/samples.ts`): input detection, debug-exporter conversion (format taken from the upstream `debugexporter` marshaler), and the sample library.
- **Hover & autocomplete** (`src/ottl/assist.ts`, glue in `src/providers.ts`): pure line-level logic; in YAML it activates only on OTTL list items and routing statements, decided from indentation so it works on invalid YAML.
- **Collector-YAML extractor** (`src/ottl/yaml.ts`): locates every embedded OTTL string with its line/column, context, signal and dialect.
- **Dry-run engines** (`wasm/`, `scripts/build-engines.sh`): `opentelemetry-collector-contrib/processor/transformprocessor` compiled to WebAssembly, once per supported version. The runner forces `error_mode: propagate` so every runtime error reaches the trace, which simulates `ignore`/`silent` itself (the processor's default became `ignore` in v0.153 and would hide them). `src/ottl/engines.ts` pins each engine's checksum; `src/ottl/engineHost.ts` loads several engines side by side; `src/ottl/compare.ts` lines two traces up.

**Tests & coverage.** Everything under `src/ottl/` is pure and unit-tested against a **90% coverage gate**. The trace, error explanations, samples and debug-exporter conversion were also verified end to end against the bundled engine. The VS Code glue and webview are thin and verified via F5.

## Contributing

Bug reports, ideas and pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), then look at issues labelled [good first issue](https://github.com/srikar-kompella/ottl-lens/labels/good%20first%20issue). Questions and ideas go in [Discussions](https://github.com/srikar-kompella/ottl-lens/discussions).

## Maintainer

Created and maintained by **Srikar Kompella** ([@srikar-kompella](https://github.com/srikar-kompella)).

## License

[Apache-2.0](LICENSE).
