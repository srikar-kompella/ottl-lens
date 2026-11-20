# OTTL behaviour by Collector version

This is an upgrade reference for Collector **contrib**, covering the seven
boundaries tracked by [OTTL Lens](src/ottl/versions.ts). It is not a complete
upstream changelog. The examples assume default feature gates unless noted.

| First contrib version | Change | Before | From this version | Upstream reference |
| --- | --- | --- | --- | --- |
| v0.141.0 | Typed log severity assignment | A string assigned to the numeric severity field could silently do nothing. | The wrong type returns an error. Use a severity enum or integer. | [v0.141.0 release, #40198](https://github.com/open-telemetry/opentelemetry-collector-contrib/releases/tag/v0.141.0) |
| v0.150.0 | Typed trace/span ID assignment | Assigning a hex string directly could do nothing. | A type mismatch is an error; use the ID's `.string` access path for hex text. | [v0.150.0 release, #40198](https://github.com/open-telemetry/opentelemetry-collector-contrib/releases/tag/v0.150.0) |
| v0.153.0 | Default transform error handling | The default is `propagate`. | The default becomes `ignore` with the beta gate enabled; explicit `error_mode` still takes precedence. | [#48415](https://github.com/open-telemetry/opentelemetry-collector-contrib/pull/48415), [release](https://github.com/open-telemetry/opentelemetry-collector-contrib/releases/tag/v0.153.0) |
| v0.160.0 | Failed numeric conversion | Converting a nonnumeric string with `Int()` returns nil; a surrounding `set()` writes nothing. | The conversion returns an error. | [v0.160.0 release, #50564](https://github.com/open-telemetry/opentelemetry-collector-contrib/releases/tag/v0.160.0) |
| v0.161.0 | Missing source value in `set()` | With the default gates, nil is skipped, leaving the target unchanged. | Nil is passed to the setter; an existing attribute can become an empty value. | [v0.161.0 release, #49741](https://github.com/open-telemetry/opentelemetry-collector-contrib/releases/tag/v0.161.0) |
| v0.163.0 | Dynamic slice arguments (notably `keep_keys`) | `keep_keys` requires a literal list. | A path or converter returning a list is accepted under the beta dynamic-slice gate. | [v0.163.0 release, #45980 and #51565](https://github.com/open-telemetry/opentelemetry-collector-contrib/releases/tag/v0.163.0) |
| v0.164.0 | OTTL stability | Traces, metrics and logs were beta. | Those signals become stable; experimental functions and APIs are not covered by the same guarantees. | [v0.164.0 release, #51068 and #47305](https://github.com/open-telemetry/opentelemetry-collector-contrib/releases/tag/v0.164.0) |

The dynamic-slice boundary in OTTL Lens is specifically exercised with
`keep_keys`. Upstream introduced `SliceGetter` in v0.160.0 (#49341) and
enabled dynamic values for `Concat` in v0.161.0 (#27821, #38690); the broader
beta feature gate `pkg.ottl.functions.enableDynamicSliceArguments` arrived
in v0.163.0. See the corresponding release notes above. Do not assume all
list-taking functions acquired this support at the same time.

For nil assignment, `ottl.set.allowNil` became beta and default-on in
v0.161.0; the stable gate was removed in v0.164.0 (#48714).

## Reproduce an upgrade

Use a logs payload with attributes `user = "alice"`, `s = "abc"`,
`keys = "user,s"` and no attribute called `missing`. For trace ID tests use
a spans payload with an existing ID different from the test value. Run each
statement separately, using **Compare with** to select the older engine.

| Statement | Engines to compare | Expected result |
| --- | --- | --- |
| `set(log.severity_number, "INFO")` | v0.140.0 / v0.146.0 | No effect / error |
| `set(span.trace_id, "11111111111111111111111111111111")` | v0.146.0 / v0.150.0 | No effect / error |
| `set(log.attributes["n"], Int(log.attributes["s"]))` | v0.157.0 / v0.160.0 | No effect / error |
| `set(log.attributes["user"], log.attributes["missing"])` | v0.160.0 / v0.161.0 | No effect / writes empty |
| `keep_keys(log.attributes, Split(log.attributes["keys"], ","))` | v0.161.0 / v0.163.0 | Configuration error / changed |

For the severity example use `set(log.severity_number, SEVERITY_NUMBER_INFO)`
instead. For the trace example use `span.trace_id.string` as the target.
For a missing attribute, append `where log.attributes["missing"] != nil`
to preserve the old value. A literal list such as
`keep_keys(log.attributes, ["user", "s"])` is portable across the listed
engines when the keys are fixed.

To avoid depending on a changing transform default, explicitly configure
`error_mode: propagate` (stop on a runtime error) or `error_mode: ignore`
(continue past it) according to the intended behavior. OTTL Lens simulates
these modes per statement; see the [limitations](README.md#known-limitations)
for multi-record behavior. Stability is a release-level guarantee, not a
statement verdict.

The exact boundaries and fixtures are maintained in
[scripts/verify-engine.mjs](scripts/verify-engine.mjs). From a development
checkout, run:

```sh
npm ci
npm run fetch:engines
npm run verify:engine
```

OTTL Lens uses representative engines, not a binary for every release.
For instance, the v0.141.0 change is checked with the v0.140.0 and v0.146.0
engines. Compare against an actual Collector of your deployed version when
validating production configurations, particularly when feature gates or
changes outside the covered boundaries are involved.
