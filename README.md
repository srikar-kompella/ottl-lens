# OTTL Lens (community)

**Catch OTTL mistakes inside your Collector YAML before they hit a running collector.**

OTTL Lens brings the OpenTelemetry Transformation Language (OTTL) feedback loop into VS Code: a fast static linter that works **inside your Collector config** (where OTTL actually lives), syntax highlighting for `.ottl` files, and an offline dry-run that executes your statements with the **real OTTL engine** — no collector, no network.

> **Community project. Not affiliated with, endorsed by, or sponsored by the OpenTelemetry project or CNCF.**
> OpenTelemetry and OTTL are trademarks of their respective owners. This extension tracks the
> upstream OTTL function reference but is independently maintained.

---

## Why

OTTL is powerful but easy to get subtly wrong — a mis-cased function (`ParseJson` vs `ParseJSON`), a stray `=`, or an unbalanced paren often fails silently or only surfaces at collector runtime. Existing checks are web playgrounds (`ottl.run`), outside the editor and the config files you actually work in. OTTL Lens pulls that check into the editor, and the dry-run runs the same engine a real collector uses.

## Features

| Feature | What it does |
|---|---|
| **Collector-YAML aware linting** | Finds and lints OTTL embedded in Collector configs — `transform` / `filter` processors (flat, advanced, and legacy shapes) and the `routing` connector — with diagnostics on the right lines. Works on `.yaml` / `.yml`, not just `.ottl`. |
| **Offline dry-run (real engine)** | Runs your `.ottl` statements against a sample OTLP payload using the upstream transform processor compiled to WebAssembly. See the transformed logs, traces, or metrics — entirely offline. |
| Syntax highlighting | Functions, strings, comments, keywords (`where` / `and` / `or` / `not`), constants (`true` / `false` / `nil`), numbers, and operators for `.ottl` files. |
| Unknown-function lint | Flags calls that aren't in the OTTL editor/converter catalog, with a **"did you mean"** hint (`ParseJson` → `ParseJSON`). |
| Delimiter checks | Unbalanced / unclosed `(` and `[`, and mismatches. |
| String checks | Unterminated string literals (escape-aware). |
| `=` vs `==` | Flags a single `=` (invalid in OTTL) and points you to `==` or `set(...)`. |
| Empty `where` | Flags a `where` with no condition after it. |

Diagnostics update on open and on edit. Strings and `#` comments are masked, so the linter won't false-positive on `(`, `=`, or function-looking text inside them.

## Getting started

1. Install **OTTL Lens** from the VS Code Extensions view (search "OTTL Lens") once published, or install the packaged `.vsix`.
2. Open a Collector config (`otelcol.yaml`) or a `.ottl` file — linting runs automatically.
3. Fix the squiggles. That's it.

*(Not yet on the Marketplace — build locally for now; see "Develop" below.)*

## Dry-run

Run **OTTL: Dry Run** from the Command Palette with either a `.ottl` file open, or your cursor placed inside a `transform` block in your Collector YAML. A panel opens beside your editor:

1. It loads the statements from the active `.ottl` file, or from the transform block at your cursor (and preselects that block's signal).
2. Pick the signal type (logs / traces / metrics) and paste or edit the sample OTLP JSON payload (a default is pre-filled).
3. Click **▶ Run** — the real OTTL engine executes the statements and shows the transformed output.

The engine runs entirely offline in the extension host via WebAssembly. No network requests. The WASM binary is pre-built and bundled.

**Why it's useful — you see exactly what your rules do.** Say a log record comes in with `attributes: { environment: staging, http.method: GET }` and you run:

```
set(log.attributes["env"], "production")
set(log.attributes["env.upper"], ConvertCase(log.attributes["env"], "upper"))
keep_keys(log.attributes, ["env", "env.upper", "http.method"])
```

The dry-run shows the output: `attributes: { http.method: GET, env: production, env.upper: PRODUCTION }`. Notice `environment` is **gone** — `keep_keys` dropped it, silently. This is the class of mistake that normally only shows up in production after data goes missing; the dry-run surfaces it before you deploy. Think `terraform plan`, but for telemetry transforms.

## Known limitations

- **The linter is heuristic, not a parser.** It catches common structural and naming mistakes, but does not do full semantic/type checking — e.g. a wrong argument type or an invalid path can still pass the linter. The dry-run, which uses the real engine, is the authoritative check.
- **Dry-run** runs a whole `.ottl` file, or the `transform` **statements** in the block at your cursor in Collector YAML. It executes statements (not filter conditions), and supports the logs, traces, and metrics signals.
- **Templated configs are best-effort.** Helm / Go-templated YAML that doesn't parse as valid YAML yields no diagnostics (the extractor skips what it can't parse rather than guessing). Untemplated sections still lint.
- The bundled WASM engine is large (tens of MB uncompressed); the Marketplace package compresses it.

## Roadmap

- Quick-fixes for detected errors, hover docs and autocomplete for OTTL functions and context paths, dry-run of filter conditions, and declarative-syntax support (tracking contrib [#11852](https://github.com/open-telemetry/opentelemetry-collector-contrib/issues/11852)).

## Develop

```bash
npm install
npm run compile      # build the extension (tsc)
npm test             # run unit tests (vitest)
npm run coverage     # run tests with coverage (fails under 90% on src/ottl/**)
npm run build:wasm   # (re)build the WASM engine (requires Go)
npm run gen:catalog -- <path-to>/pkg/ottl/ottlfuncs/README.md   # regenerate the function catalog
# Press F5 in VS Code to launch the Extension Development Host, then open
# examples/collector.yaml or examples/sample.ottl.
```

## Design

- **Static linter** (`src/ottl/catalog.ts`, `src/ottl/linter.ts`): the function catalog is auto-generated from the upstream OTTL function reference (`pkg/ottl/ottlfuncs/README.md`) via `scripts/gen-catalog.mjs`, so the known-function list never drifts. `src/ottl/extras.ts` adds component-scoped functions (e.g. `route()`) that live outside `ottlfuncs`.
- **Collector-YAML extractor** (`src/ottl/yaml.ts`): parses Collector config with the `yaml` CST to locate every embedded OTTL string with its line/column, context, signal, and dialect. This is what lets the linter run on the files people actually edit. `scripts/scan.mjs` runs the extractor + linter over a directory of configs.
- **Dry-run engine** (`wasm/`): wraps `opentelemetry-collector-contrib/processor/transformprocessor` compiled to WebAssembly. Statements are wrapped into a transform processor config and executed against the sample payload using the same engine a real collector runs.

**Tests & coverage.** The linting logic is a pure module (`src/ottl/`) with a full unit suite and a **90% coverage gate**. The VS Code host glue (`src/extension.ts`, `src/ottl/wasmRunner.ts`) and the webview panel are thin and verified manually via F5.

## Contributing

Issues and PRs welcome. Keep the linter false-positive-averse — a noisy linter gets disabled. New rules should ship with tests and hold coverage at or above the gate.

## Author

Created and maintained by **Srikar Kompella**. Contributions welcome via GitHub issues and pull requests.

## License

[Apache-2.0](LICENSE).
