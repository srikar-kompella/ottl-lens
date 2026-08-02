import { describe, it, expect } from "vitest";
import { EDITORS, CONVERTERS, KNOWN_FUNCTIONS, CASEFOLD_INDEX } from "./catalog";

describe("catalog", () => {
  it("has the expected editor and converter counts (regen if OTTL changes)", () => {
    expect(EDITORS.size).toBe(16);
    expect(CONVERTERS.size).toBe(96);
  });

  it("includes known editors and converters", () => {
    for (const e of ["set", "delete_index", "stringify_all", "keep_keys"]) expect(EDITORS.has(e)).toBe(true);
    for (const c of ["ParseJSON", "XXH128", "URL", "ConvertCase"]) expect(CONVERTERS.has(c)).toBe(true);
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
