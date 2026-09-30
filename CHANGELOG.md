# Changelog

## 0.2.1

Correctness release.

### `error_mode` now follows your config and your collector version
0.2.0 called `propagate` "the default". That was true only for older collectors: the transform processor's default is **`propagate` up to v0.152 and `ignore` from v0.153** (feature gate `processor.transform.defaultErrorModeIgnore`: beta in v0.153, stable in v0.158, removed in v0.162 — checked in the contrib source for each version).

- The dry-run reads `error_mode` from the block under your cursor (a statement group's own setting overrides the processor's), and the panel shows "from your config".
- If the block doesn't set it, the dry-run uses `ignore` and tells you the default depends on your collector version.
- An invalid value (`error_mode: ingore`) is reported: the collector would reject the config.

### Experimental lambda functions
`All`, `Any`, `Filter`, `Find`, `MapEach`, `MapKeys`, `Reduce` and `When` (moved to `pkg/ottl/xottl` upstream on 2026-09-28) are no longer flagged as unknown.
- A note says they need the `ottl.functions.enableLambda` feature gate (alpha since v0.155.0, off by default) — without it the collector rejects the config.
- Hover and autocomplete document them.
- The lambda arrow `=>` is no longer reported as a single `=`.
- The bundled engine (v0.146.0) can't run them; the dry-run now says exactly that instead of a lexer error.

### Clearer syntax errors
Engine syntax errors now point at the column and text that couldn't be read.

### Catalog
Regenerated from contrib `main` (2026-09-29), plus the experimental function reference and the OTTL feature-gate table.

## 0.2.0

### Per-statement trace
The dry-run now runs your statements one at a time and reports what each one did:

- **changed** — with a diff in OTTL terms: `+ log.attributes["env"] = "production"`. Type changes are named: `200 → "200" (int → string)`. With several records, each change says which one (`log #2`).
- **no effect** — ran without error, changed nothing. Known traps get a specific hint; each was reproduced on the bundled engine: `set(metric.type, …)` (use `convert_gauge_to_sum()`), `span.trace_id` without `.string`, and a converter returning nil (`Int("abc")`).
- **matched nothing** — the `where` guard excluded every record (decided by re-running the statement without its guard).
- **error** — explained in plain language, with the right consequence: a config error means the collector won't start; a runtime error depends on `error_mode`.

Diffs are taken against the engine's own normalized form of the input, so no statement is blamed for the engine's normalization (it adds an empty `status` to spans that had none).

### `error_mode` that changes the result
`propagate` (the default) stops the trace at a runtime error — the record would be dropped. `ignore` and `silent` continue past the failed statement, as a collector would.

### Paste what you already have
The payload box accepts OTLP JSON, JSON Lines from the file exporter, or raw `debug` exporter output (`verbosity: detailed`), including zap, docker-compose and JSON-logging wrappers. The signal is detected from the content. **Open file…** loads the same formats from disk.

### Samples
Nine realistic payloads: a k8s log with a JSON body and PII, health-check noise, an errored HTTP span with an exception event, a SQL client span with an email in the query, a gauge, a counter with a high-cardinality attribute, and a latency histogram.

### Hover docs and autocomplete
- Hover functions, paths and enums for signatures, descriptions, examples, types and a link to the upstream reference.
- Autocomplete functions (with argument placeholders; editors only at statement start), context fields after `log.` / `span.` / `metric.` / `datapoint.` / `resource.`, enums and keywords. Works in `.ottl` files and on OTTL lines in Collector YAML, even while the YAML is half-typed.

### Errors you can act on
`log.atributes` → *did you mean `log.attributes`?* · `parsejson` → *did you mean `ParseJSON`?* · `attributes["x"]` → *needs its context prefix* · functions newer than the bundled engine are identified as such instead of surfacing as a context-inference error.

### Version-aware catalog
The catalog is regenerated from upstream `main` and now includes context paths and enums. It is the union of the latest reference and the engine's version (contrib v0.146.0):
- `clear`, `IsEmpty`, `Coalesce`, `stringify_all`, `Base64Encode` are no longer flagged as unknown (false positives in 0.1.1).
- `Base64Decode`, removed upstream, gets an informational hint to use `Decode(value, "base64")`.
- `ProfileID` (profiles) is recognised.

### Fixes
- The panel no longer replaces a pasted payload when you move the cursor in your YAML.
- Layout: in a narrow side panel the payload and results stack instead of squeezing the results off-screen, and the results scroll into view after a run.

## 0.1.1

Collector-YAML-aware linting, offline dry-run with the real upstream OTTL engine (Go → WebAssembly), syntax highlighting, and an auto-generated function catalog with "did you mean" suggestions.
