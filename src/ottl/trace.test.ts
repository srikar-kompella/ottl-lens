import { describe, it, expect } from "vitest";
import {
  splitStatements,
  stripWhereClause,
  diffJSON,
  describeErrorMode,
  traceStatements,
  summarize,
  baselineStatement,
  knownNoOpHint,
  describeError,
  type EvalFn,
} from "./trace";

/* ------------------------------------------------------------------ *
 * A fake engine.
 *
 * The real engine is Go/WASM and cannot run in unit tests, so we model just
 * enough OTTL semantics to exercise the trace logic: `set(...)` adds a key,
 * `delete_key(...)` removes one, `noop(...)` does nothing, `boom(...)` errors,
 * and a `where false` guard suppresses the whole statement.
 * ------------------------------------------------------------------ */
type Bag = { attributes: Array<{ key: string; value: { stringValue: string } }> };

function makeEngine(): EvalFn {
  return (statements, _signal, payloadJSON) => {
    let doc: Bag;
    try { doc = JSON.parse(payloadJSON) as Bag; } catch { return { ok: false, error: "bad json" }; }
    doc.attributes = doc.attributes ? [...doc.attributes.map((a) => ({ ...a }))] : [];

    for (const line of statements.split("\n").map((l) => l.trim()).filter(Boolean)) {
      if (/\bboom\(/.test(line)) return { ok: false, error: "engine exploded" };
      if (/\bwhere\s+(false|1\s*==\s*2)\b/.test(line)) continue; // guard excludes everything
      if (/\bnoop\(/.test(line)) continue;                    // runs, changes nothing
      if (/\bmetric\.type\b/.test(line)) continue;             // no-op in the transform processor
      if (/\bparsefail\(/.test(line)) return { ok: false, error: 'OTTL parse error: unable to parse OTTL statement "parsefail()"' };
      if (/\bInt\("abc"\)/.test(line)) continue;               // converter returns nil → nothing set
      if (/\btrace_id\b/.test(line) && !/\.string\b/.test(line)) continue; // silent type failure

      const setM = /set\(\s*([\w.]+)\s*,\s*"([^"]*)"\s*\)/.exec(line);
      if (setM) {
        const [, key, value] = setM;
        const existing = doc.attributes.find((a) => a.key === key);
        if (existing) existing.value = { stringValue: value };
        else doc.attributes.push({ key, value: { stringValue: value } });
        continue;
      }
      const delM = /delete_key\(\s*"([^"]*)"\s*\)/.exec(line);
      if (delM) {
        doc.attributes = doc.attributes.filter((a) => a.key !== delM[1]);
      }
    }
    return { ok: true, output: JSON.stringify(doc), executionMs: 1 };
  };
}

const PAYLOAD = JSON.stringify({
  attributes: [
    { key: "environment", value: { stringValue: "staging" } },
    { key: "http.method", value: { stringValue: "GET" } },
  ],
});

/* ------------------------------------------------------------------ */

describe("splitStatements", () => {
  it("drops comments and blank lines", () => {
    expect(splitStatements('# c\n\nset(a, "b")   # trailing\n\nnoop()')).toEqual([
      'set(a, "b")',
      "noop()",
    ]);
  });

  it("returns [] for a comments-only block", () => {
    expect(splitStatements("# just a comment\n\n  # another")).toEqual([]);
  });
});

describe("stripWhereClause", () => {
  it("removes a trailing guard", () => {
    expect(stripWhereClause('set(a, "b") where c == 1')).toBe('set(a, "b")');
  });

  it("returns null when there is no guard", () => {
    expect(stripWhereClause('set(a, "b")')).toBeNull();
  });

  it("ignores the word 'where' inside a string literal", () => {
    expect(stripWhereClause('set(a, "where is it")')).toBeNull();
  });

  it("handles escaped quotes before the guard", () => {
    expect(stripWhereClause('set(a, "he said \\"hi\\"") where x == 1')).toBe(
      'set(a, "he said \\"hi\\"")'
    );
  });

  it("returns null when the statement is only a guard", () => {
    expect(stripWhereClause("where x == 1")).toBeNull();
  });
});

describe("diffJSON", () => {
  it("returns [] for identical values", () => {
    expect(diffJSON({ a: 1 }, { a: 1 })).toEqual([]);
  });

  it("detects added, removed and changed object keys", () => {
    const d = diffJSON({ a: 1, b: 2 }, { a: 9, c: 3 });
    expect(d).toContainEqual({ path: "a", kind: "changed", before: 1, after: 9 });
    expect(d).toContainEqual({ path: "b", kind: "removed", before: 2 });
    expect(d).toContainEqual({ path: "c", kind: "added", after: 3 });
  });

  it("diffs OTLP attribute arrays by key, not by index", () => {
    const before = { attributes: [{ key: "a", value: 1 }, { key: "b", value: 2 }] };
    const after = { attributes: [{ key: "b", value: 2 }] };   // 'a' removed, 'b' moved
    const d = diffJSON(before, after);
    expect(d).toHaveLength(1);
    expect(d[0].kind).toBe("removed");
    expect(d[0].path).toBe('attributes["a"]');
  });

  it("diffs plain arrays positionally", () => {
    const d = diffJSON([1, 2], [1, 2, 3]);
    expect(d).toEqual([{ path: "[2]", kind: "added", after: 3 }]);
  });

  it("recurses into nested structures", () => {
    const d = diffJSON({ x: { y: { z: 1 } } }, { x: { y: { z: 2 } } });
    expect(d).toEqual([{ path: "x.y.z", kind: "changed", before: 1, after: 2 }]);
  });
});

describe("diffJSON — edge cases", () => {
  it("treats a type change between container kinds as a single change", () => {
    const d = diffJSON({ a: [1, 2] }, { a: { b: 1 } });
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ path: "a", kind: "changed" });
  });

  it("treats an empty attribute list as keyed when the other side is keyed", () => {
    const d = diffJSON({ attributes: [] }, { attributes: [{ key: "a", value: 1 }] });
    expect(d).toEqual([{ path: 'attributes["a"]', kind: "added", after: { key: "a", value: 1 } }]);
  });

  it("expands an attribute list that appears or disappears into per-key entries", () => {
    expect(diffJSON({ body: 1 }, { body: 1, attributes: [{ key: "a", value: 1 }, { key: "b", value: 2 }] })).toEqual([
      { path: 'attributes["a"]', kind: "added", after: { key: "a", value: 1 } },
      { path: 'attributes["b"]', kind: "added", after: { key: "b", value: 2 } },
    ]);
    expect(diffJSON({ attributes: [{ key: "a", value: 1 }] }, {})).toEqual([
      { path: 'attributes["a"]', kind: "removed", before: { key: "a", value: 1 } },
    ]);
  });

  it("keeps two empty arrays equal and still diffs non-keyed arrays positionally", () => {
    expect(diffJSON({ a: [] }, { a: [] })).toEqual([]);
    expect(diffJSON({ dataPoints: [] }, { dataPoints: [{ asInt: "1" }] })).toEqual([
      { path: "dataPoints[0]", kind: "added", after: { asInt: "1" } },
    ]);
  });

  it("falls back to positional diffing when only some elements have a key", () => {
    const before = { xs: [{ key: "a" }, { other: 1 }] };
    const after = { xs: [{ key: "a" }, { other: 2 }] };
    expect(diffJSON(before, after)).toEqual([
      { path: "xs[1].other", kind: "changed", before: 1, after: 2 },
    ]);
  });

  it("reports a removed element when a plain array shrinks", () => {
    expect(diffJSON([1, 2, 3], [1, 2])).toEqual([{ path: "[2]", kind: "removed", before: 3 }]);
  });

  it("returns [] for structurally equal but distinct objects", () => {
    expect(diffJSON({ a: { b: [1] } }, { a: { b: [1] } })).toEqual([]);
  });

  it("labels a bare scalar change at the root", () => {
    expect(diffJSON(1, 2)).toEqual([{ path: "(root)", kind: "changed", before: 1, after: 2 }]);
  });
});

describe("describeErrorMode", () => {
  it("warns that propagate drops the record", () => {
    expect(describeErrorMode("propagate")).toMatch(/DROPPED/);
  });
  it("describes config and payload errors without mentioning error_mode outcomes", () => {
    expect(describeError("config", "propagate")).toMatch(/fail to start/);
    expect(describeError("payload", "ignore")).toMatch(/payload was rejected/);
    expect(describeError("runtime", "propagate")).toMatch(/DROPPED/);
  });
  it("explains ignore and silent distinctly", () => {
    expect(describeErrorMode("ignore")).toMatch(/logged/);
    expect(describeErrorMode("silent")).toMatch(/no log line/);
  });
});

describe("traceStatements", () => {
  const engine = makeEngine();

  it("marks a statement that changes the payload as `changed` with a diff", () => {
    const r = traceStatements('set(env, "production")', "logs", PAYLOAD, engine);
    expect(r.ok).toBe(true);
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0].verdict).toBe("changed");
    expect(r.steps[0].diff?.[0]).toMatchObject({ kind: "added", path: 'attributes["env"]' });
  });

  it("attributes each change to the right statement across a sequence", () => {
    const block = ['set(a, "1")', 'set(b, "2")', 'delete_key("environment")'].join("\n");
    const r = traceStatements(block, "logs", PAYLOAD, engine);
    expect(r.steps.map((s) => s.verdict)).toEqual(["changed", "changed", "changed"]);
    expect(r.steps[0].diff?.[0].path).toBe('attributes["a"]');
    expect(r.steps[1].diff?.[0].path).toBe('attributes["b"]');
    expect(r.steps[2].diff?.[0]).toMatchObject({ kind: "removed", path: 'attributes["environment"]' });
  });

  it("flags an inert statement as `no-effect`", () => {
    const r = traceStatements("noop()", "logs", PAYLOAD, engine);
    expect(r.steps[0].verdict).toBe("no-effect");
    expect(r.noEffectCount).toBe(1);
  });

  it("distinguishes an unmatched guard from an inert statement", () => {
    const r = traceStatements('set(env, "prod") where false', "logs", PAYLOAD, engine);
    expect(r.steps[0].verdict).toBe("not-matched");
    expect(r.steps[0].note).toMatch(/where clause matched no records/);
    expect(r.noEffectCount).toBe(0);
  });

  it("still reports no-effect when removing the guard changes nothing either", () => {
    const r = traceStatements("noop() where false", "logs", PAYLOAD, engine);
    expect(r.steps[0].verdict).toBe("no-effect");
  });

  it("gives the hint for set(metric.type, …), a verified no-op", () => {
    const r = traceStatements("set(metric.type, METRIC_DATA_TYPE_SUM)", "metrics", PAYLOAD, engine);
    expect(r.steps[0].verdict).toBe("no-effect");
    expect(r.steps[0].note).toMatch(/convert_gauge_to_sum/);
  });

  it("explains a converter that returned nil", () => {
    const r = traceStatements('set(x, Int("abc"))', "logs", PAYLOAD, engine);
    expect(r.steps[0].verdict).toBe("no-effect");
    expect(r.steps[0].note).toMatch(/returned nil/);
  });

  it("does not blame a converter that only appears in the where guard", () => {
    expect(knownNoOpHint('set(a, "x") where IsMatch(b, "y")')).toBeUndefined();
  });

  it("continues past a runtime error under error_mode ignore, like a collector", () => {
    const block = ['set(a, "1")', "boom()", 'set(b, "2")'].join("\n");
    const r = traceStatements(block, "logs", PAYLOAD, engine, "ignore");
    expect(r.steps.map((s) => s.verdict)).toEqual(["changed", "error", "changed"]);
    expect(r.steps[1].errorClass).toBe("runtime");
    expect(r.steps[1].consequence).toMatch(/continues without this statement/);
    // The failed statement is excluded from later prefixes, so #3's diff is only its own change.
    expect(r.steps[2].diff?.map((d) => d.path)).toEqual(['attributes["b"]']);
  });

  it("stops at a config (parse) error even under ignore, and says error_mode doesn't apply", () => {
    const r = traceStatements(['set(a, "1")', "parsefail()", 'set(b, "2")'].join("\n"), "logs", PAYLOAD, engine, "ignore");
    expect(r.steps).toHaveLength(2);
    expect(r.steps[1].errorClass).toBe("config");
    expect(r.steps[1].consequence).toMatch(/fail to start/);
    expect(r.steps[1].consequence).not.toMatch(/DROPPED/);
  });

  it("gives the documented hint for trace_id without .string", () => {
    const r = traceStatements('set(trace_id, "abc")', "traces", PAYLOAD, engine);
    expect(r.steps[0].verdict).toBe("no-effect");
    expect(r.steps[0].note).toMatch(/\.string suffix/);
  });

  it("reports an engine error with the error_mode consequence and stops", () => {
    const r = traceStatements(['set(a, "1")', "boom()", 'set(b, "2")'].join("\n"), "logs", PAYLOAD, engine);
    expect(r.ok).toBe(false);
    expect(r.steps).toHaveLength(2);            // stops after the failure
    expect(r.steps[1].verdict).toBe("error");
    expect(r.steps[1].error).toBe("engine exploded");
    expect(r.steps[1].consequence).toMatch(/DROPPED/);
  });

  it("uses the supplied error_mode in the consequence text", () => {
    const r = traceStatements("boom()", "logs", PAYLOAD, engine, "silent");
    expect(r.steps[0].consequence).toMatch(/no log line/);
  });

  it("errors cleanly on an empty block", () => {
    const r = traceStatements("# only a comment", "logs", PAYLOAD, engine);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/No runnable OTTL statements/);
  });

  it("errors cleanly on an invalid payload", () => {
    const r = traceStatements('set(a, "1")', "logs", "{not json", engine);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not valid JSON/);
  });

  it("surfaces non-JSON engine output as an error", () => {
    const bad: EvalFn = () => ({ ok: true, output: "<html>" });
    const r = traceStatements('set(a, "1")', "logs", PAYLOAD, bad);
    expect(r.steps[0].verdict).toBe("error");
    expect(r.steps[0].error).toMatch(/not valid JSON/);
  });

  it("exposes the final payload after the last successful statement", () => {
    const r = traceStatements('set(env, "production")', "logs", PAYLOAD, engine);
    expect(JSON.parse(r.finalOutput!)).toMatchObject({
      attributes: expect.arrayContaining([{ key: "env", value: { stringValue: "production" } }]),
    });
  });
});

describe("summarize", () => {
  const engine = makeEngine();

  it("counts each verdict", () => {
    const block = ['set(a, "1")', "noop()", 'set(b, "2") where false'].join("\n");
    const s = summarize(traceStatements(block, "logs", PAYLOAD, engine));
    expect(s).toContain("1 changed");
    expect(s).toContain("1 had no effect");
    expect(s).toContain("1 matched nothing");
  });

  it("passes through a fatal error", () => {
    expect(summarize(traceStatements("# c", "logs", PAYLOAD, engine))).toMatch(/No runnable/);
  });

  it("counts errored statements", () => {
    const s = summarize(traceStatements('set(a, "1")\nboom()', "logs", PAYLOAD, engine));
    expect(s).toContain("1 errored");
  });

  it("reports only the changed count when nothing else happened", () => {
    expect(summarize(traceStatements('set(a, "1")', "logs", PAYLOAD, engine))).toBe("1 changed");
  });
});

describe("traceStatements — engine normalization baseline", () => {
  // Models the real engine: pdata re-marshaling drops empty messages such as `scope: {}`.
  const normalizing: EvalFn = (statements, _s, payload) => {
    const doc = JSON.parse(payload) as Record<string, unknown>;
    if (doc.scope && Object.keys(doc.scope as object).length === 0) delete doc.scope;
    if (/\bset\(a,/.test(statements)) doc.a = 1;
    return { ok: true, output: JSON.stringify(doc) };
  };
  const RAW = JSON.stringify({ scope: {}, x: 1 });

  it("does not report engine normalization as a change by statement #1", () => {
    const r = traceStatements("noop()", "logs", RAW, normalizing);
    expect(r.steps[0].verdict).toBe("no-effect");
  });

  it("attributes only the statement's own change, not the normalization", () => {
    const r = traceStatements("set(a, 1)", "logs", RAW, normalizing);
    expect(r.steps[0].verdict).toBe("changed");
    expect(r.steps[0].diff).toEqual([{ path: "a", kind: "added", after: 1 }]);
  });

  it("falls back to the raw payload for an unknown signal (no baseline)", () => {
    // No baseline → the dropped `scope` is (correctly, for lack of better info) visible.
    const r = traceStatements("noop()", "profiles", RAW, normalizing);
    expect(r.steps[0].verdict).toBe("changed");
  });

  it("discards a contaminated baseline if the engine ignored the guard", () => {
    // A broken engine that applies every set(), ignoring `where 1 == 2`.
    const leaky: EvalFn = (statements, _s, payload) => {
      const doc = JSON.parse(payload) as Record<string, unknown>;
      const m = /"(__ottl_lens_baseline)"/.exec(statements);
      if (m) doc[m[1]] = "x";
      return { ok: true, output: JSON.stringify(doc) };
    };
    const r = traceStatements("noop()", "logs", JSON.stringify({ x: 1 }), leaky);
    // Falls back to the raw payload, so the no-op is still reported correctly.
    expect(r.steps[0].verdict).toBe("no-effect");
  });

  it("uses a signal-appropriate, never-matching baseline statement", () => {
    expect(baselineStatement("logs")).toMatch(/^set\(log\.attributes.*where 1 == 2$/);
    expect(baselineStatement("traces")).toMatch(/^set\(span\.attributes.*where 1 == 2$/);
    expect(baselineStatement("metrics")).toMatch(/^set\(metric\.name.*where 1 == 2$/);
    expect(baselineStatement("profiles")).toBeUndefined();
  });
});

describe("traceStatements — guard probe robustness", () => {
  it("falls back to no-effect when the unguarded probe itself errors", () => {
    // `where` present, no change, and the probe (statement minus guard) fails.
    const engine: EvalFn = (statements, _s, payload) =>
      /where/.test(statements)
        ? { ok: true, output: payload }        // guarded form: no change
        : { ok: false, error: "probe failed" }; // unguarded probe: errors
    const r = traceStatements('set(a, "1") where x == 1', "logs", PAYLOAD, engine);
    expect(r.steps[0].verdict).toBe("no-effect");
  });

  it("falls back to no-effect when the unguarded probe returns invalid JSON", () => {
    const engine: EvalFn = (statements, _s, payload) =>
      /where/.test(statements) ? { ok: true, output: payload } : { ok: true, output: "<nope>" };
    const r = traceStatements('set(a, "1") where x == 1', "logs", PAYLOAD, engine);
    expect(r.steps[0].verdict).toBe("no-effect");
  });

  it("leaves finalOutput undefined when the very first statement errors", () => {
    const engine: EvalFn = () => ({ ok: false, error: "nope" });
    const r = traceStatements('set(a, "1")', "logs", PAYLOAD, engine);
    expect(r.finalOutput).toBeUndefined();
    expect(r.ok).toBe(false);
  });
});
