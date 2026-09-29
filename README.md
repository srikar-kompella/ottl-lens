# OTTL Lens (community)

**See what your OTTL actually does — statement by statement — before it reaches a collector.**

OTTL Lens brings the OpenTelemetry Transformation Language (OTTL) feedback loop into VS Code. It lints OTTL **inside your Collector config** (where OTTL actually lives), documents and autocompletes functions and paths, and runs your statements offline with the **real upstream OTTL engine** — then tells you what each statement did, including the ones that silently did nothing.

> **Community project. Not affiliated with, endorsed by, or sponsored by the OpenTelemetry project or CNCF.**
> OpenTelemetry and OTTL are trademarks of their respective owners. This extension tracks the
> upstream OTTL reference but is independently maintained.

---

## Why

OTTL fails quietly. A statement can be valid, raise no error, and change nothing — and you find out when data goes missing in production. The usual way to check is to run a local collector with a `debug` exporter, feed it telemetry, and read `docker logs`, one iteration at a time.

OTTL Lens does that loop in the editor, in about a second, with the same transform processor a collector runs.

## Features

| Feature | What it does |
|---|---|
| **Per-statement trace** | Runs your statements one at a time with the real engine and gives each a verdict: `changed` (with a diff), **`no effect`**, `matched nothing`, or `error`. |
| **Readable diffs, in OTTL** | Changes are shown as OTTL paths and values — `+ log.attributes["env"] = "production"`, `− log.attributes["environment"] = "staging"` — and type changes are called out: `200 → "200" (int → string)`. |
| **Paste what you already have** | The payload box accepts OTLP JSON, JSON Lines from the file exporter, or **raw `debug` exporter output** straight from `docker logs` — converted automatically, with the signal detected from the content. |
| **Realistic samples** | Nine built-in payloads shaped around real transforms: a k8s log with a JSON body and PII, health-check noise, an errored HTTP span with an exception event, a SQL span with an email in the query, counters, histograms. |
| **Errors you can act on** | Engine errors are translated: `log.atributes` → *did you mean `log.attributes`?*, `parsejson` → *did you mean `ParseJSON`?*, `attributes["x"]` → *needs its context prefix*. Config errors ("the collector won't start") are kept separate from runtime errors ("what `error_mode` does"). |
| **`error_mode` that actually changes the result** | With `propagate` (the default), a runtime error drops the record and the trace stops. With `ignore` or `silent`, the trace continues past the failed statement — as a collector would. |
| **Hover docs** | Hover any function, path or enum: signature, description, examples and a link to the upstream reference. Paths show their type (`log.severity_number` → `int64`). |
| **Autocomplete** | Functions with argument placeholders (editors only at the start of a statement), context fields after `log.` / `span.` / `metric.` / `datapoint.` / `resource.`, enums and keywords. Works while the YAML is half-typed. |
| **Collector-YAML aware linting** | Finds and lints OTTL in `transform` / `filter` processors (flat, advanced and legacy shapes) and the `routing` connector, on the right lines. Unknown / mis-cased functions, unbalanced delimiters, single `=`, unterminated strings, empty `where`. |
| **Version-aware** | The function catalog is the union of the latest OTTL reference and the version the bundled engine is built from. Functions removed upstream get a migration hint (`Base64Decode` → `Decode(value, "base64")`); functions newer than the engine are accepted by the linter and flagged in hover. |
| Syntax highlighting | For `.ottl` files. |

## Getting started

1. Install **OTTL Lens**:
   - **VS Code** — from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=srikar-kompella.ottl-lens), or search "OTTL Lens" in the Extensions view.
   - **Cursor, Windsurf, VSCodium, Gitpod** — from [Open VSX](https://open-vsx.org/extension/srikar-kompella/ottl-lens) (these editors use the Open VSX registry).
2. Open a Collector config or a `.ottl` file — linting, hover and autocomplete work immediately.
3. Put your cursor in a `transform` block and run **OTTL: Dry Run** from the Command Palette.

## Dry-run

The panel loads the statements from the active `.ottl` file, or from the `transform` block at your cursor (and follows that block's signal).

**Payload.** Pick a sample, click **Open file…**, or paste your own. Whatever you paste is converted when you run:

- **OTLP JSON** — used as-is.
- **JSON Lines** (the file exporter's format, one export request per line) — merged.
- **`debug` exporter output** (`verbosity: detailed`) — converted to OTLP JSON, including when it's wrapped in zap log prefixes, docker-compose prefixes, or a collector logging as JSON.

The converted JSON replaces your paste in the box, so you can see and edit exactly what ran.

**Per-statement trace.** Click **▶ Run**:

| Verdict | Meaning |
|---|---|
| **changed** | The statement modified the payload — shown as a diff in OTTL paths. |
| **no effect** | The statement ran without error and changed **nothing**. Usually a bug. |
| **matched nothing** | The statement is fine, but its `where` guard excluded every record in this payload. |
| **error** | The engine rejected it, with an explanation and what happens next. |

`no effect` is the point. These are real, silent failures — each reproduced on the bundled engine:

- `set(metric.type, METRIC_DATA_TYPE_SUM)` is accepted and does nothing; changing a metric's type needs a conversion function such as `convert_gauge_to_sum()`.
- `set(span.trace_id, "4bf92f…")` does nothing — the field is bytes; use `span.trace_id.string`.
- `set(log.attributes["n"], Int("abc"))` writes nothing because the converter returns nil.

OTTL Lens flags each one and says why. To tell "did nothing" apart from "guard matched nothing", the trace re-runs the statement without its `where` clause: if the unguarded form *does* change the payload, the guard was the reason.

Open `examples/collector.yaml` and dry-run the `transform/logs` block to see all four verdicts at once.

The engine runs entirely offline in the extension host via WebAssembly — no network requests.

## Known limitations

- **The bundled engine is built from contrib `v0.146.0`.** Functions added later (`clear`, `IsEmpty`, `Coalesce`, `stringify_all`, `Base64Encode`) lint and document fine, but the dry-run can't execute them yet — the panel says so rather than showing a confusing engine error.
- **Statements without any path can't be dry-run** (e.g. `convert_gauge_to_sum(...)`). The engine infers each statement's context from its paths; in a collector config you would set `context:` on the block.
- **The dry-run executes statements, not filter conditions.** Filter conditions are linted, documented and autocompleted.
- **`ignore`/`silent` are simulated per statement.** If a statement fails for only some records, a real collector would still apply it to the others; the dry-run skips it for all of them.
- **Debug-exporter conversion** covers logs, spans (with events) and gauge / sum / histogram metrics. Exponential histograms, summaries, span links and exemplars are skipped, with a note.
- **The linter is heuristic, not a parser.** It catches structural and naming mistakes; argument types and paths are checked authoritatively by the dry-run.
- **Templated configs are best-effort.** Helm / Go-templated YAML that doesn't parse yields no lint diagnostics; hover and autocomplete still work line by line.

## Develop

```bash
npm install
npm run compile      # build the extension (tsc)
npm test             # run unit tests (vitest)
npm run coverage     # run tests with coverage (fails under 90% on src/ottl/**)
npm run build:wasm   # (re)build the WASM engine (requires Go)
# Regenerate the catalog (functions, paths, enums) from a contrib checkout, plus the
# function reference from the engine's version (see the header of scripts/gen-catalog.mjs):
npm run gen:catalog -- <contrib>/pkg/ottl --engine <ottlfuncs-README@v0.146.0.md> --engine-version v0.146.0
# Press F5 in VS Code to launch the Extension Development Host, then open
# examples/collector.yaml or examples/sample.ottl.
```

## Design

- **Catalog** (`src/ottl/catalog.ts`, generated by `scripts/gen-catalog.mjs`): function signatures, descriptions and examples from `pkg/ottl/ottlfuncs/README.md`; the path tables and enums of every context from `pkg/ottl/contexts/*/README.md`. Nothing is hand-typed, so it never drifts from upstream.
- **Trace** (`src/ottl/trace.ts`): runs growing prefixes of the block and diffs consecutive outputs, so no engine changes are needed. Diffs are taken against the engine's own normalized form of the input (it canonicalizes payloads, e.g. adding an empty `status` to spans), so no statement is blamed for the engine's normalization. `src/ottl/present.ts` renders diffs as OTTL paths; `src/ottl/explain.ts` translates engine errors.
- **Payloads** (`src/ottl/payload.ts`, `src/ottl/debugText.ts`, `src/ottl/samples.ts`): input detection, debug-exporter conversion (format taken from the upstream `debugexporter` marshaler), and the sample library.
- **Hover & autocomplete** (`src/ottl/assist.ts`, glue in `src/providers.ts`): pure line-level logic; in YAML it activates only on OTTL list items and routing statements, decided from indentation so it works on invalid YAML.
- **Collector-YAML extractor** (`src/ottl/yaml.ts`): locates every embedded OTTL string with its line/column, context, signal and dialect.
- **Dry-run engine** (`wasm/`): `opentelemetry-collector-contrib/processor/transformprocessor` compiled to WebAssembly.

**Tests & coverage.** Everything under `src/ottl/` is pure and unit-tested against a **90% coverage gate**. The trace, error explanations, samples and debug-exporter conversion were also verified end to end against the bundled engine. The VS Code glue and webview are thin and verified via F5.

## Contributing

Issues and PRs welcome. Keep the linter false-positive-averse — a noisy linter gets disabled. New rules should ship with tests and hold coverage at or above the gate.

## Author

Created and maintained by **Srikar Kompella**. Contributions welcome via GitHub issues and pull requests.

## License

[Apache-2.0](LICENSE).
