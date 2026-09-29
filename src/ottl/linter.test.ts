import { describe, it, expect } from "vitest";
import { lint, Diagnostic } from "./linter";

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
