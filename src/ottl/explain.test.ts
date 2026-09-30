import { describe, it, expect } from "vitest";
import { classifyError, explainEngineError, editDistance, segmentsAfter, suggestSegment, unqualifiedPath, functionsIn } from "./explain";

// Messages below are verbatim from the real engine (contrib v0.146.0).
const UNKNOWN_NEWER =
  'OTTL parse error: unable to infer a valid context (["resource" "scope" "log"]) from statements ["clear(log.attributes)"] and conditions []: inferred context "log" does not support the function "clear"';
const BAD_PATH =
  'OTTL parse error: unable to parse OTTL statement "set(log.atributes[\\"a\\"], \\"1\\")": error while parsing arguments for call to "set": invalid argument at position 0: segment "atributes" from path "log.atributes[a]" is not a valid path nor a valid OTTL keyword for the Log context';
const NO_PATH =
  'OTTL parse error: unable to infer context from statements ["resource" "scope" "metric" "datapoint"] and conditions ["convert_gauge_to_sum(\\"cumulative\\", true)"], path\'s first segment must be a valid context name [], and at least one context must be capable of parsing all statements';

describe("classifyError", () => {
  it("separates config, payload and runtime errors", () => {
    expect(classifyError(UNKNOWN_NEWER)).toBe("config");
    expect(classifyError("invalid OTLP logs JSON: unexpected EOF")).toBe("payload");
    expect(classifyError("payload is empty")).toBe("payload");
    expect(classifyError("failed to execute statement: something at runtime")).toBe("runtime");
  });
});

describe("explainEngineError", () => {
  it("explains a function that is newer than the bundled engine", () => {
    expect(explainEngineError(UNKNOWN_NEWER)).toMatch(/`clear` is a real OTTL function, but it was added after v0\.146\.0/);
  });

  it("suggests the right casing for a mis-cased function", () => {
    const msg = UNKNOWN_NEWER.replace(/"clear"$/, '"parsejson"');
    expect(explainEngineError(msg)).toMatch(/Did you mean `ParseJSON`\?/);
  });

  it("says plainly when a function doesn't exist", () => {
    expect(explainEngineError(UNKNOWN_NEWER.replace(/"clear"$/, '"frobnicate"'))).toBe("There is no OTTL function `frobnicate`.");
  });

  it("handles a known function that is not allowed in this context", () => {
    expect(explainEngineError(UNKNOWN_NEWER.replace(/"clear"$/, '"set"'))).toMatch(/can't be used in this context/);
  });

  it("mentions the feature gate for an experimental function the engine lacks", () => {
    expect(explainEngineError(UNKNOWN_NEWER.replace(/"clear"$/, '"Filter"'))).toMatch(/needs the `ottl\.functions\.enableLambda` feature gate/);
  });

  it("explains a lambda the bundled engine can't lex (verbatim engine message)", () => {
    const stmt = 'set(log.attributes["t"], Filter(log.attributes, (k, _) => k == "environment"))';
    const msg = 'OTTL parse error: unable to infer a valid context (["resource" "scope" "log"]) from statements ["set(log.attributes[\\"t\\"], Filter(log.attributes, (k, _) => k == \\"environment\\"))"] and conditions []: statement has invalid syntax: 1:53: lexer: invalid input text "_) => k == \\"envi..."';
    expect(explainEngineError(msg, stmt)).toMatch(/uses `Filter` with lambda syntax, which the bundled dry-run engine \(v0\.146\.0\) can't parse yet/);
    expect(explainEngineError(msg, stmt)).toMatch(/ottl\.functions\.enableLambda/);
  });

  it("explains lambda syntax without a known newer function", () => {
    const msg = "OTTL parse error: x: statement has invalid syntax: 1:30: lexer: invalid input text \"_) => v\"";
    expect(explainEngineError(msg, "set(log.body, Mystery(x, (_, v) => v))")).toMatch(/Lambda syntax \(`=>`\) isn't supported/);
  });

  it("points at the column and text for an ordinary syntax error", () => {
    const msg = 'OTTL parse error: x: statement has invalid syntax: 1:15: lexer: invalid input text "@@ oops"';
    expect(explainEngineError(msg, "set(log.body, @@ oops)")).toBe("Syntax error at column 15: the engine couldn't read `@@ oops`.");
    expect(explainEngineError("OTTL parse error: statement has invalid syntax: 1:5: unexpected token", "set((log.body")).toMatch(/Syntax error at column 5/);
  });

  it("lists the functions a statement calls, ignoring strings", () => {
    expect(functionsIn('set(log.body, Concat(["Filter(", x], ""))')).toEqual(["set", "Concat"]);
  });

  it("recognises the undefined-function wording too", () => {
    expect(explainEngineError('undefined function "IsEmpty"')).toMatch(/added after/);
  });

  it("suggests the closest valid path for a typo", () => {
    expect(explainEngineError(BAD_PATH)).toBe("`log.atributes` isn't a valid path. Did you mean `log.attributes`?");
  });

  it("lists valid fields when no suggestion is close enough", () => {
    const msg = BAD_PATH.replace(/atributes/g, "zzzzzzzzzz");
    expect(explainEngineError(msg)).toMatch(/valid fields after `log\.` include/);
  });

  it("explains a statement with no path (context can't be inferred)", () => {
    expect(explainEngineError(NO_PATH, 'convert_gauge_to_sum("cumulative", true)')).toMatch(/doesn't reference any path/);
  });

  it("tells an unprefixed path apart from no path, though the engine message is identical", () => {
    // Verbatim: the engine emits this exact message for `set(attributes["a"], "1")`.
    const same = 'OTTL parse error: unable to infer context from statements ["scope" "log" "resource"] and conditions ["set(attributes[\\"a\\"], \\"1\\")"], path\'s first segment must be a valid context name [], and at least one context must be capable of parsing all statements';
    expect(explainEngineError(same, 'set(attributes["a"], "1")')).toMatch(/`attributes` needs its context prefix — write `log\.attributes`/);
  });

  it("explains a mis-cased converter from its dedicated message", () => {
    const msg = "OTTL parse error: unable to infer a valid context (…) and conditions []: converter names must start with an uppercase letter but got 'parsejson'";
    expect(explainEngineError(msg)).toBe("Converter names start with an uppercase letter. Did you mean `ParseJSON`?");
    expect(explainEngineError(msg.replace("parsejson", "frob"))).toMatch(/no converter called `frob`/);
  });

  it("falls back to general context advice for other inference failures", () => {
    expect(explainEngineError("OTTL parse error: unable to infer a valid context (x)", "set(log.body, 1)")).toMatch(/couldn't infer which context/);
  });

  it("finds unqualified paths but ignores strings, calls and qualified paths", () => {
    expect(unqualifiedPath('set(attributes["a"], "1")')).toBe("attributes");
    expect(unqualifiedPath('set(log.attributes["a"], "x.y[1]")')).toBeUndefined();
    expect(unqualifiedPath("set(log.body, body.string)")).toBe("body");
    expect(unqualifiedPath('convert_gauge_to_sum("cumulative", true)')).toBeUndefined();
  });

  it("explains an invalid payload and returns undefined for anything else", () => {
    expect(explainEngineError("invalid OTLP traces JSON: bad")).toMatch(/Fix the payload/);
    expect(explainEngineError("something unexpected")).toBeUndefined();
  });
});

describe("path helpers", () => {
  it("lists the segments after a context", () => {
    const segs = segmentsAfter("log");
    for (const s of ["attributes", "body", "severity_number", "trace_id"]) expect(segs).toContain(s);
    expect(segmentsAfter("log.trace_id")).toEqual(["string"]);
  });

  it("suggests only plausible typo fixes", () => {
    expect(suggestSegment("span", "nmae")).toBe("name");
    expect(suggestSegment("log", "severity_numbr")).toBe("severity_number");
    expect(suggestSegment("log", "xyz")).toBeUndefined();
  });

  it("computes edit distance with an early exit", () => {
    expect(editDistance("kitten", "sitting")).toBe(3);
    expect(editDistance("nmae", "name")).toBe(1); // adjacent swap counts once
    expect(editDistance("a", "abcdefgh", 3)).toBe(4);
    expect(editDistance("abc", "xyzabc", 2)).toBe(3);
  });
});
