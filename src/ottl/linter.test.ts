import { describe, it, expect } from "vitest";
import { lint, Diagnostic, describeGate, sliceParams } from "./linter";

const codes = (ds: Diagnostic[]) => ds.map((d) => d.code);
const onLine = (ds: Diagnostic[], line: number) => ds.filter((d) => d.line === line);

describe("valid OTTL — no diagnostics", () => {
  it.each([
    'set(attributes["environment"], "production") where attributes["environment"] == nil',
    'delete_key(attributes, "http.request.header.authorization")',
    'set(attributes["name.upper"], ConvertCase(attributes["name"], "upper"))',
    'keep_keys(attributes, ["service.name", "host.name"])',
    'limit(attributes, 100, [])',
    'set(attributes["ok"], "yes") where IsMatch(name, ".*") and severity_number >= 9',
    'set(attributes["big"], XXH128(body))',
    'set(attributes["u"], URL(attributes["href"]))',
    'delete_index(attributes["list"], 0)',
    'stringify_all()'
  ])("no diagnostics for: %s", (line) => {
    expect(lint(line)).toEqual([]);
  });

  it("ignores blank lines and comments", () => {
    const text = ["", "# this is a comment with set( and = and unterminated \"", "   ", "# ParseJson( in a comment"].join("\n");
    expect(lint(text)).toEqual([]);
  });
});

describe("unknown function detection", () => {
  it("flags an unknown function", () => {
    const d = lint('set(attributes["x"], Frobnicate(body))');
    expect(codes(d)).toContain("ottl.unknownFunction");
  });

  it("suggests correct casing (ParseJson -> ParseJSON)", () => {
    const d = lint("set(a, ParseJson(body))");
    const uf = d.find((x) => x.code === "ottl.unknownFunction");
    expect(uf?.message).toMatch(/ParseJSON/);
  });

  it("suggests correct casing from all-lowercase (parsejson -> ParseJSON)", () => {
    const d = lint("set(a, parsejson(body))");
    expect(d.find((x) => x.code === "ottl.unknownFunction")?.message).toMatch(/ParseJSON/);
  });

  it("no suggestion when there is no close match", () => {
    const d = lint("set(a, Zzzxyz(body))");
    const uf = d.find((x) => x.code === "ottl.unknownFunction");
    expect(uf).toBeTruthy();
    expect(uf?.message).not.toMatch(/Did you mean/);
  });

  it("does not flag known editors or converters", () => {
    for (const fn of ["set", "delete_index", "stringify_all", "ParseJSON", "XXH128", "URL", "IsMatch"]) {
      const d = lint(`set(a, ${fn === "set" ? "b" : `${fn}(b)`})`);
      expect(codes(d)).not.toContain("ottl.unknownFunction");
    }
  });

  it("does not treat language keywords as functions", () => {
    // `not(...)`, `and`, `or`, `where` must never be flagged as unknown functions
    const d = lint('set(a, b) where not(IsString(name)) and IsMatch(name, "x")');
    expect(codes(d)).not.toContain("ottl.unknownFunction");
  });

  it("reports accurate column for the unknown function", () => {
    const d = lint("set(a, Frobnicate(b))");
    const uf = d.find((x) => x.code === "ottl.unknownFunction");
    expect(uf?.line).toBe(0);
    expect(uf?.startCol).toBe("set(a, ".length);
    expect(uf?.endCol).toBe("set(a, Frobnicate".length);
  });
});

describe("single '=' rule", () => {
  it("flags a single '='", () => {
    expect(codes(lint('set(attributes["env"] = "prod")'))).toContain("ottl.singleEquals");
  });

  it.each(["==", "!=", "<=", ">="])("does not flag comparison operator %s", (op) => {
    const d = lint(`set(a, b) where x ${op} y`);
    expect(codes(d)).not.toContain("ottl.singleEquals");
  });

  it("does not flag '=' inside a string or comment", () => {
    expect(codes(lint('set(a, "x = y")'))).not.toContain("ottl.singleEquals");
    expect(codes(lint("set(a, b) # x = y"))).not.toContain("ottl.singleEquals");
  });
});

describe("delimiter balance", () => {
  it("flags an unclosed paren", () => {
    expect(codes(lint("set(a, Concat([a], b)"))).toContain("ottl.delimiters");
  });

  it("flags a stray closing bracket / mismatch", () => {
    expect(codes(lint("keep_keys(attributes, [a)"))).toContain("ottl.delimiters");
  });

  it("flags a closing paren with no opener", () => {
    expect(codes(lint("a, b)"))).toContain("ottl.delimiters");
  });

  it("accepts nested balanced delimiters", () => {
    expect(codes(lint("set(a, Concat([b, c], Split(d, e)))"))).not.toContain("ottl.delimiters");
  });

  it("ignores delimiters inside strings and comments", () => {
    expect(codes(lint('set(a, "((([")'))).not.toContain("ottl.delimiters");
    expect(codes(lint("set(a, b)  # ((("))).not.toContain("ottl.delimiters");
  });
});

describe("string handling", () => {
  it("flags an unterminated string", () => {
    expect(codes(lint('set(a, "oops'))).toContain("ottl.unterminatedString");
  });

  it("accepts an escaped quote inside a string", () => {
    expect(codes(lint('set(a, "she said \\"hi\\"")'))).not.toContain("ottl.unterminatedString");
  });

  it("reports the unterminated string starting column", () => {
    const d = lint('set(a, "oops');
    const s = d.find((x) => x.code === "ottl.unterminatedString");
    expect(s?.startCol).toBe('set(a, '.length);
  });
});

describe("empty where", () => {
  it("flags a trailing empty where", () => {
    expect(codes(lint("delete_key(attributes, \"x\") where"))).toContain("ottl.emptyWhere");
  });

  it("does not flag a where with a condition", () => {
    expect(codes(lint('delete_key(attributes, "x") where name == "y"'))).not.toContain("ottl.emptyWhere");
  });
});

describe("options", () => {
  it("suppresses unknown-function warnings when unknownFunctions:false", () => {
    const d = lint("set(a, Frobnicate(b))", { unknownFunctions: false });
    expect(codes(d)).not.toContain("ottl.unknownFunction");
  });
  it("still reports other diagnostics when unknownFunctions:false", () => {
    const d = lint("set(a = b)", { unknownFunctions: false });
    expect(codes(d)).toContain("ottl.singleEquals");
  });
});

describe("multi-line + multiple diagnostics", () => {
  it("attaches diagnostics to the correct lines", () => {
    const text = ['set(a, b)', 'set(a, ParseJson(b))', 'set(a = b)'].join("\n");
    const d = lint(text);
    expect(onLine(d, 0)).toEqual([]);
    expect(codes(onLine(d, 1))).toContain("ottl.unknownFunction");
    expect(codes(onLine(d, 2))).toContain("ottl.singleEquals");
  });

  it("handles CRLF line endings", () => {
    const d = lint('set(a, b)\r\nset(a, ParseJson(b))');
    expect(d.some((x) => x.line === 1 && x.code === "ottl.unknownFunction")).toBe(true);
  });

  it("returns [] for empty input", () => {
    expect(lint("")).toEqual([]);
  });
});

describe("removed and newer functions", () => {
  it("flags a function removed upstream as info, with its replacement", () => {
    const d = lint('set(log.attributes["d"], Base64Decode(log.body))');
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ severity: "info", code: "ottl.removedFunction" });
    expect(d[0].message).toMatch(/Use Decode\(value, "base64"\) instead/);
  });

  it("accepts functions that exist only in newer OTTL (no false positive)", () => {
    expect(lint("clear(log.attributes)")).toEqual([]);
    expect(lint('set(log.attributes["e"], IsEmpty(log.body))')).toEqual([]);
  });

  it("accepts component-scoped and profiles functions", () => {
    expect(lint('set(log.attributes["p"], ProfileID(x))')).toEqual([]);
  });
});

describe("lambdas (experimental, xottl)", () => {
  const stmt = 'set(log.attributes["prod_tags"], Filter(log.attributes["tags"], (_, v) => v == "prod"))';

  it("does not mistake the lambda arrow for a single '='", () => {
    expect(lint(stmt).filter((d) => d.code === "ottl.singleEquals")).toEqual([]);
  });

  it("accepts lambda functions and notes the feature gate they need", () => {
    const d = lint(stmt);
    expect(d.filter((x) => x.severity !== "info")).toEqual([]);
    const info = d.find((x) => x.code === "ottl.experimentalFunction")!;
    expect(info.message).toMatch(/"Filter" is experimental and needs the `ottl\.functions\.enableLambda` feature gate \(alpha since v0\.155\.0, off by default\)/);
    expect(info.message).toMatch(/--feature-gates=ottl\.functions\.enableLambda/);
  });

  it("still flags a real single '='", () => {
    expect(codes(lint('set(log.body, x) where a = 1'))).toContain("ottl.singleEquals");
  });

  it("describes unknown gates plainly", () => {
    expect(describeGate("made.up")).toBe("the `made.up` feature gate");
  });
});

describe("0.3: type checks, path typos and quick fixes", () => {
  const apply = (line: string, d: Diagnostic) => line.slice(0, d.fix!.start) + d.fix!.replacement + line.slice(d.fix!.end);

  it("reports a never-matching comparison as a warning with a fix", () => {
    const line = 'set(log.body, "x") where log.severity_number == "9"';
    const d = lint(line).find((x) => x.code === "ottl.neverMatches")!;
    expect(d.severity).toBe("warning");
    expect(apply(line, d)).toBe('set(log.body, "x") where log.severity_number == 9');
  });

  it("ignores type issues inside a trailing comment", () => {
    expect(lint('set(log.body, "x") # where log.severity_number == "9"').filter((x) => x.code === "ottl.neverMatches")).toEqual([]);
  });

  it("flags a path typo with a fix, but stays quiet about unknown paths without a close match", () => {
    const line = 'set(log.atributes["a"], "1")';
    const d = lint(line).find((x) => x.code === "ottl.unknownPath")!;
    expect(d.message).toBe('"log.atributes" isn\'t a known path. Did you mean "log.attributes"?');
    expect(apply(line, d)).toBe('set(log.attributes["a"], "1")');
    expect(lint('set(log.zzzzzzzz, "1")').filter((x) => x.code === "ottl.unknownPath")).toEqual([]);
    expect(lint('set(span.status.code, STATUS_CODE_ERROR)').filter((x) => x.code === "ottl.unknownPath")).toEqual([]);
    expect(lint('set(log.trace_id.string, "x")').filter((x) => x.code === "ottl.unknownPath")).toEqual([]);
  });

  it("does not treat a path inside a string as a path", () => {
    expect(lint('set(log.body, "log.atributes")').filter((x) => x.code === "ottl.unknownPath")).toEqual([]);
  });

  it("offers the casing fix for a mis-cased function", () => {
    const line = "set(log.body, parsejson(log.body))";
    expect(apply(line, lint(line).find((x) => x.code === "ottl.unknownFunction")!)).toBe("set(log.body, ParseJSON(log.body))");
  });

  it("rewrites Base64Decode(x) as Decode(x, \"base64\")", () => {
    const line = 'set(log.body, Base64Decode(log.attributes["b"]))';
    const d = lint(line).find((x) => x.code === "ottl.removedFunction")!;
    expect(apply(line, d)).toBe('set(log.body, Decode(log.attributes["b"], "base64"))');
  });

  it("offers no Base64Decode fix when the call is malformed", () => {
    expect(lint("set(log.body, Base64Decode(log.body").find((x) => x.code === "ottl.removedFunction")!.fix).toBeUndefined();
  });
});

describe("0.4: list arguments and component functions", () => {
  it("flags a plain value where a list is required, with a fix", () => {
    const d = lint('keep_keys(log.attributes, "http.method")').find((x) => x.code === "ottl.sliceArgument")!;
    expect(d).toMatchObject({ severity: "error", startCol: 26, endCol: 39 });
    expect(d.message).toBe('"keep_keys" expects a list for keys — write ["http.method"]. A plain value is rejected when the collector loads the config.');
    expect(d.fix).toEqual({ title: 'Wrap in a list: ["http.method"]', start: 26, end: 39, replacement: '["http.method"]' });
    expect(lint('set(log.body, Concat("a", "-"))').filter((x) => x.code === "ottl.sliceArgument")).toHaveLength(1);
    expect(lint("set(log.body, Format(\"%d\", 5))").find((x) => x.code === "ottl.sliceArgument")?.fix?.replacement).toBe("[5]");
  });

  it("accepts lists, paths and converters in list positions", () => {
    for (const s of [
      'keep_keys(log.attributes, ["a", "b"])',
      'keep_keys(log.attributes, Split(log.attributes["k"], ","))',
      'keep_keys(log.attributes, log.attributes["list"])',
      'set(log.body, Concat([log.body, "x,y"], "-"))',
    ]) expect(lint(s).filter((x) => x.code === "ottl.sliceArgument"), s).toEqual([]);
  });

  it("reads list parameters from signatures", () => {
    expect(sliceParams("keep_keys(target, keys[])")).toEqual([{ index: 1, name: "keys" }]);
    expect(sliceParams("Format(format, []vals)")).toEqual([{ index: 1, name: "vals" }]);
    expect(sliceParams("set(target, value)")).toEqual([]);
    expect(sliceParams("nonsense")).toEqual([]);
  });

  it("no longer flags transform- and filter-processor functions as unknown", () => {
    for (const s of [
      'convert_gauge_to_sum("cumulative", false) where metric.name == "x"',
      "extract_count_metric(true)",
      'set(log.attributes["cef"], ParseCEF(log.body))',
      'HasAttrOnDatapoint("k", "v")',
    ]) expect(lint(s).filter((x) => x.code === "ottl.unknownFunction"), s).toEqual([]);
  });
});

describe("missing prefixes in inferred transform blocks", () => {
  it.each([
    ["logs", "log.attributes"],
    ["traces", "span.attributes"],
    ["metrics", "datapoint.attributes"],
  ])("suggests a context for %s first", (inferredSignal, replacement) => {
    const statement = 'set(attributes["env"], "prod")';
    const diagnostic = lint(statement, { inferredSignal }).find((d) => d.code === "ottl.missingContext");
    expect(diagnostic?.fix).toMatchObject({ start: 4, end: 14, replacement });
    expect(diagnostic?.alternativeFixes?.map((fix) => fix.replacement)).toContain("resource.attributes");
  });

  it("ignores qualified paths, strings, comments and unsupported fields", () => {
    const statement = 'set(log.attributes["env"], "attributes[env]") # attributes["ignored"]';
    expect(lint(statement, { inferredSignal: "logs" })).toEqual([]);
    expect(lint('set(unknown["env"], "prod")', { inferredSignal: "logs" })).toEqual([]);
  });
});
