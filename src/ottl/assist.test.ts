import { describe, it, expect } from "vitest";
import {
  hoverAt, completionsAt, isOttlLine, inStringOrComment, signatureSnippet,
  functionMarkdown, pathMarkdown, enumMarkdown,
} from "./assist";

const at = (line: string, marker = "|") => ({ text: line.replace(marker, ""), col: line.indexOf(marker) });

describe("hover", () => {
  it("documents a function with signature, kind, examples and a reference link", () => {
    const { text, col } = at('set(log.attributes["a"], Pars|eJSON(log.body))');
    const h = hoverAt(text, col)!;
    expect(h.markdown).toContain("ParseJSON(target)");
    expect(h.markdown).toContain("*Converter*");
    expect(h.markdown).toContain("**Examples**");
    expect(h.markdown).toMatch(/README\.md#parsejson\)/);
    expect(text.slice(h.start, h.end)).toBe("ParseJSON");
  });

  it("documents an editor", () => {
    const { text, col } = at('s|et(log.body, "x")');
    expect(hoverAt(text, col)!.markdown).toContain("*Editor*");
  });

  it("notes when a function is newer than the bundled engine", () => {
    const { text, col } = at("cle|ar(log.attributes)");
    expect(hoverAt(text, col)!.markdown).toMatch(/Added after v0\.146\.0/);
  });

  it("marks experimental lambda functions with their feature gate", () => {
    const md = functionMarkdown("Filter")!;
    expect(md).toMatch(/Experimental — needs the `ottl\.functions\.enableLambda` feature gate/);
    expect(md).toMatch(/xottl\/ottlfuncs\/README\.md#filter/);
    const { text, col } = at('set(x, Filter(log.attributes["t"], (_, v) => v == "a"))');
    expect(completionsAt(text, text.indexOf("Filter") + 3).items.find((i) => i.label === "Filter")!.detail).toMatch(/experimental/);
    void col;
  });

  it("notes a removed function and its replacement", () => {
    expect(functionMarkdown("Base64Decode")).toMatch(/Removed from the latest OTTL — use `Decode\(value, "base64"\)`/);
  });

  it("documents component-scoped functions", () => {
    expect(functionMarkdown("route")).toMatch(/routing connector/);
    expect(functionMarkdown("nope")).toBeUndefined();
  });

  it("documents the path segment under the cursor", () => {
    const { text, col } = at('set(log.sev|erity_text, "WARN")');
    const h = hoverAt(text, col)!;
    expect(h.markdown).toContain("log.severity_text");
    expect(h.markdown).toContain("**string**");
    const inner = at('set(log.trace_id.str|ing, "x")');
    expect(hoverAt(inner.text, inner.col)!.markdown).toContain("log.trace_id.string");
  });

  it("describes a container segment in the middle of a path", () => {
    const { text, col } = at('keep_keys(log.attri|butes["a"], [])');
    const h = hoverAt(text, col)!;
    expect(text.slice(h.start, h.end)).toBe("log.attributes");
  });

  it("documents enums", () => {
    const { text, col } = at("set(log.body, \"x\") where log.severity_number >= SEVERITY_NUMBER_W|ARN");
    expect(hoverAt(text, col)!.markdown).toContain("SEVERITY_NUMBER_WARN = 13");
    expect(enumMarkdown("NOPE")).toBeUndefined();
    expect(pathMarkdown("log.nope")).toBeUndefined();
  });

  it("stays quiet inside strings, comments, whitespace and unknown words", () => {
    const s = at('set(log.body, "Pars|eJSON(x)")');
    expect(hoverAt(s.text, s.col)).toBeUndefined();
    const c = at("set(log.body, 1) # ParseJ|SON here");
    expect(hoverAt(c.text, c.col)).toBeUndefined();
    const w = at("set(log.body,| 1)");
    expect(hoverAt(w.text, w.col)).toBeUndefined();
    const u = at("foo|bar");
    expect(hoverAt(u.text, u.col)).toBeUndefined();
    const up = at("set(log.nope|thing, 1)");
    expect(hoverAt(up.text, up.col)).toBeUndefined();
    const nf = at("frob|nicate(1)");
    expect(hoverAt(nf.text, nf.col)).toBeUndefined();
  });

  it("works on a YAML list item, including a double-quoted scalar", () => {
    const y = at('          - set(log.attributes["a"], Pars|eJSON(log.body))');
    expect(hoverAt(y.text, y.col, { yaml: true })!.markdown).toContain("ParseJSON(target)");
    const dq = at('          - "set(log.attributes[\\"a\\"], Pars|eJSON(log.body))"');
    expect(hoverAt(dq.text, dq.col, { yaml: true })!.markdown).toContain("ParseJSON(target)");
    const dqs = at('          - "set(log.attributes[\\"Pars|eJSON\\"], 1)"');
    expect(hoverAt(dqs.text, dqs.col, { yaml: true })).toBeUndefined();
  });
});

describe("completion", () => {
  const labels = (line: string, yaml = false) => {
    const { text, col } = at(line);
    return completionsAt(text, col, { yaml }).items.map((i) => i.label);
  };

  it("offers the fields of a context after 'log.'", () => {
    const { text, col } = at("set(log.|");
    const r = completionsAt(text, col);
    const names = r.items.map((i) => i.label);
    for (const f of ["attributes", "body", "severity_number", "trace_id"]) expect(names).toContain(f);
    expect(r.replaceStart).toBe(col);
    const body = r.items.find((i) => i.label === "body")!;
    expect(body.detail).toContain("log.body");
  });

  it("replaces the partial field and goes deeper into sub-paths", () => {
    const { text, col } = at("set(log.sev|");
    expect(completionsAt(text, col).replaceStart).toBe(col - 3);
    expect(labels("set(log.trace_id.|")).toEqual(["string"]);
  });

  it("continues into container segments like resource.attributes", () => {
    const { text, col } = at("set(resource.|");
    const items = completionsAt(text, col).items;
    expect(items.map((i) => i.label)).toContain("attributes");
  });

  it("offers editors first at the start of a statement", () => {
    const { text, col } = at("ke|");
    const items = completionsAt(text, col).items;
    const keep = items.find((i) => i.label === "keep_keys")!;
    expect(keep.sortText.startsWith("0")).toBe(true);
    expect(keep.snippet).toBe(true);
    expect(keep.insertText).toBe("keep_keys(${1:target}, ${2:keys})");
    expect(items.some((i) => i.kind === "enum")).toBe(false);
  });

  it("offers converters, contexts, enums and keywords inside arguments, but no editors", () => {
    const names = labels('set(log.attributes["a"], |');
    expect(names).toContain("ParseJSON");
    expect(names).toContain("log");
    expect(names).toContain("SEVERITY_NUMBER_WARN");
    expect(names).toContain("where");
    expect(names).not.toContain("set");
  });

  it("marks removed functions deprecated and newer ones in the detail", () => {
    const { text, col } = at("|");
    const items = completionsAt(text, col).items;
    expect(items.find((i) => i.label === "Base64Decode")!.deprecated).toBe(true);
    expect(items.find((i) => i.label === "clear")!.detail).toMatch(/newer than v0\.146\.0 engine/);
  });

  it("works on YAML list items (statement start after '- ')", () => {
    const names = labels("          - se|", true);
    expect(names).toContain("set");
    expect(labels("        statement: rou|", true)).not.toContain("where");
  });

  it("offers nothing inside strings or comments", () => {
    expect(labels('set(log.body, "log.|')).toEqual([]);
    expect(labels("set(log.body, 1) # log.|")).toEqual([]);
  });

  it("marks context roots to re-open suggestions after insertion", () => {
    const { text, col } = at("set(|");
    const log = completionsAt(text, col).items.find((i) => i.label === "log")!;
    expect(log.insertText).toBe("log.");
    expect(log.retrigger).toBe(true);
  });
});

describe("signatureSnippet", () => {
  it("builds placeholders for required arguments only", () => {
    expect(signatureSnippet("set(target, value)")).toBe("set(${1:target}, ${2:value})");
    expect(signatureSnippet("ParseKeyValue(target, Optional[delimiter], Optional[pair_delimiter])")).toBe("ParseKeyValue(${1:target})");
    expect(signatureSnippet("Format(formatString, []formatArguments)")).toBe("Format(${1:formatString}, ${2:formatArguments})");
    expect(signatureSnippet("Now()")).toBe("Now($1)");
    expect(signatureSnippet("Double(…)")).toBe("Double($1)");
    expect(signatureSnippet("weird")).toBe("weird($1)");
  });
});

describe("inStringOrComment", () => {
  it("tracks OTTL strings, escapes and comments", () => {
    const line = 'set(log.body, "a \\" b") # c';
    expect(inStringOrComment(line, 16)).toBe(true);
    expect(inStringOrComment(line, 23)).toBe(false);
    expect(inStringOrComment(line, line.length)).toBe(true);
  });
  it("treats the end of a double-quoted YAML scalar as the end of OTTL", () => {
    const line = '- "set(log.body, 1)" # yaml comment';
    expect(inStringOrComment(line, line.length, { yaml: true })).toBe(false);
  });
});

describe("isOttlLine", () => {
  const yaml = [
    "processors:",                                  // 0
    "  transform/logs:",                            // 1
    "    error_mode: ignore",                       // 2
    "    log_statements:",                          // 3
    "      - context: log",                         // 4
    "        statements:",                          // 5
    '          - set(log.body, "x")',               // 6
    "          - keep_keys(log.attributes, [])",    // 7
    "  filter/noise:",                              // 8
    "    log_conditions:",                          // 9
    "      - IsMatch(log.body, \".*\")",            // 10
    "  filter/legacy:",                             // 11
    "    traces:",                                  // 12
    "      span:",                                  // 13
    "        - attributes[\"x\"] == \"y\"",         // 14
    "  batch:",                                     // 15
    "    send_batch_size: 100",                     // 16
    "exporters:",                                   // 17
    "  otlp:",                                      // 18
    "    headers:",                                 // 19
    "      - x",                                    // 20
    "connectors:",                                  // 21
    "  routing:",                                   // 22
    "    table:",                                   // 23
    "      - statement: route() where x == 1",      // 24
    "      - condition: IsMatch(y, \"z\")",         // 25
    "flat:",                                        // 26
    "  trace_statements:",                          // 27
    "",                                             // 28
    "    # a comment",                              // 29
    "    - set(span.name, \"x\")",                  // 30
  ];
  it("recognises OTTL list items and routing statements", () => {
    for (const n of [6, 7, 10, 14, 24, 25, 30]) expect(isOttlLine(yaml, n), `line ${n}`).toBe(true);
  });
  it("rejects everything else", () => {
    for (const n of [0, 2, 3, 4, 5, 16, 20, 28]) expect(isOttlLine(yaml, n), `line ${n}`).toBe(false);
  });
  it("rejects a list whose parent key isn't OTTL, and a top-level list", () => {
    expect(isOttlLine(["- a"], 0)).toBe(false);
    expect(isOttlLine(["span:", "  - a"], 1)).toBe(false); // legacy key without a signal parent
  });
});
