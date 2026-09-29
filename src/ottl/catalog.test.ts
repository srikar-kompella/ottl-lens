import { describe, it, expect } from "vitest";
import {
  EDITORS, CONVERTERS, KNOWN_FUNCTIONS, CASEFOLD_INDEX, FUNCTION_DOCS, CONTEXT_PATHS, ENUMS,
  NOT_IN_ENGINE, REMOVED_UPSTREAM, ENGINE_VERSION,
} from "./catalog";

describe("catalog", () => {
  it("has the expected editor and converter counts (regen if OTTL changes)", () => {
    // Union of contrib main (2026-09-29) and the bundled engine's reference (v0.146.0).
    expect(EDITORS.size).toBe(17);
    expect(CONVERTERS.size).toBe(98);
  });

  it("includes known editors and converters", () => {
    for (const e of ["set", "delete_index", "stringify_all", "keep_keys", "clear"]) expect(EDITORS.has(e)).toBe(true);
    for (const c of ["ParseJSON", "XXH128", "URL", "ConvertCase", "IsEmpty", "Base64Decode"]) expect(CONVERTERS.has(c)).toBe(true);
  });

  it("KNOWN_FUNCTIONS is the union of editors and converters", () => {
    expect(KNOWN_FUNCTIONS.size).toBe(EDITORS.size + CONVERTERS.size);
    for (const n of [...EDITORS, ...CONVERTERS]) expect(KNOWN_FUNCTIONS.has(n)).toBe(true);
  });

  it("editors and converters do not overlap", () => {
    for (const e of EDITORS) expect(CONVERTERS.has(e)).toBe(false);
  });

  it("CASEFOLD_INDEX maps lowercased names back to canonical casing", () => {
    expect(CASEFOLD_INDEX.get("parsejson")).toBe("ParseJSON");
    expect(CASEFOLD_INDEX.get("set")).toBe("set");
    expect(CASEFOLD_INDEX.size).toBe(KNOWN_FUNCTIONS.size);
  });
});

describe("catalog — version metadata (verified against the real engine)", () => {
  it("records the bundled engine version", () => {
    expect(ENGINE_VERSION).toBe("v0.146.0");
  });

  it("lists functions the bundled engine rejects", () => {
    expect([...NOT_IN_ENGINE].sort()).toEqual(["Base64Encode", "Coalesce", "IsEmpty", "clear", "stringify_all"]);
  });

  it("lists functions removed from the latest reference", () => {
    expect(REMOVED_UPSTREAM.has("Base64Decode")).toBe(true);
  });
});

describe("catalog — docs, paths, enums", () => {
  it("documents every function with a signature naming it and a description", () => {
    for (const name of KNOWN_FUNCTIONS) {
      const d = FUNCTION_DOCS[name];
      expect(d, name).toBeDefined();
      expect(d.signature.startsWith(name + "("), name).toBe(true);
      expect(d.summary.length, name).toBeGreaterThan(10);
    }
  });

  it("captures real signatures, including triple-backtick and inline forms", () => {
    expect(FUNCTION_DOCS.set.signature).toBe("set(target, value)");
    expect(FUNCTION_DOCS.Split.signature).toBe("Split(target, delimiter)");
    expect(FUNCTION_DOCS.Values.signature).toBe("Values(target)");
    expect(FUNCTION_DOCS.set.examples.length).toBeGreaterThan(0);
  });

  it("has the context paths people use most", () => {
    const paths = new Set(CONTEXT_PATHS.map((p) => p.path));
    for (const p of ["log.body", 'log.attributes[""]', "log.severity_number", "span.name", "span.trace_id.string",
      "metric.type", "datapoint.value_double", 'resource.attributes[""]', "instrumentation_scope.name"]) {
      expect(paths.has(p), p).toBe(true);
    }
    expect(paths.has("metric.data_type")).toBe(false); // not a real path — see trace.ts
  });

  it("has enum symbols with values", () => {
    const warn = ENUMS.find((e) => e.name === "SEVERITY_NUMBER_WARN");
    expect(warn?.value).toBe(13);
    expect(ENUMS.find((e) => e.name === "METRIC_DATA_TYPE_SUM")?.value).toBe(2);
  });
});
