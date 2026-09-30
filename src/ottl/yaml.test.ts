import { describe, it, expect } from "vitest";
import { extractOTTL, collectStatementsForDryRun, stripOttlComments } from "./yaml";

describe("extractOTTL — transform processor", () => {
  it("extracts advanced-style statements with context + signal + position", () => {
    const yaml = [
      "processors:",
      "  transform/logs:",
      "    log_statements:",
      "      - context: log",
      "        statements:",
      '          - set(body, "x")',
    ].join("\n");
    const got = extractOTTL(yaml);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      text: 'set(body, "x")',
      component: "transform/logs",
      context: "log",
      signal: "logs",
      dialect: "statement",
    });
    expect(got[0].line).toBe(5); // 0-based line of the statement
  });

  it("extracts flat-style statement strings (context inferred)", () => {
    const yaml = [
      "processors:",
      "  transform:",
      "    trace_statements:",
      '      - set(span.name, "x")',
    ].join("\n");
    const got = extractOTTL(yaml);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ context: null, signal: "traces", dialect: "statement" });
  });

  it("extracts conditions as the condition dialect", () => {
    const yaml = [
      "processors:",
      "  transform:",
      "    log_statements:",
      "      - conditions:",
      '          - IsMatch(log.body, ".*")',
      "        statements:",
      '          - set(log.body, "y")',
    ].join("\n");
    const got = extractOTTL(yaml);
    expect(got.find((g) => g.dialect === "condition")?.text).toBe('IsMatch(log.body, ".*")');
    expect(got.find((g) => g.dialect === "statement")?.text).toBe('set(log.body, "y")');
  });
});

describe("extractOTTL — filter processor", () => {
  it("extracts new-style *_conditions", () => {
    const yaml = [
      "processors:",
      "  filter:",
      "    log_conditions:",
      '      - IsMatch(log.body, ".*secret.*")',
    ].join("\n");
    const got = extractOTTL(yaml);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ component: "filter", signal: "logs", dialect: "condition" });
  });

  it("extracts legacy filter shape (traces.span[])", () => {
    const yaml = [
      "processors:",
      "  filter/legacy:",
      "    traces:",
      "      span:",
      '        - attributes["k"] == "v"',
    ].join("\n");
    const got = extractOTTL(yaml);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ context: "span", signal: "traces", dialect: "condition" });
  });
});

describe("extractOTTL — routing connector (scalar OTTL)", () => {
  it("extracts scalar statement/condition from the routing table", () => {
    const yaml = [
      "connectors:",
      "  routing:",
      "    table:",
      "      - context: resource",
      '        statement: route() where attributes["env"] == "prod"',
      "        pipelines: [logs/prod]",
    ].join("\n");
    const got = extractOTTL(yaml);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ component: "routing", dialect: "statement", context: "resource" });
    expect(got[0].text).toContain("route()");
  });
});

describe("stripOttlComments", () => {
  it("strips full-line and inline comments and blank lines", () => {
    const input = [
      "# a comment",
      "",
      'set(log.attributes["x"], "y")   # inline',
      "keep_keys(log.attributes, [\"x\"])",
    ].join("\n");
    expect(stripOttlComments(input)).toBe(
      'set(log.attributes["x"], "y")\nkeep_keys(log.attributes, ["x"])'
    );
  });

  it("does not strip a # inside a string literal", () => {
    expect(stripOttlComments('set(log.body, "a #b c")')).toBe('set(log.body, "a #b c")');
  });

  it("handles escaped quotes before a #", () => {
    expect(stripOttlComments('set(log.body, "he said \\"hi\\"") # tail')).toBe(
      'set(log.body, "he said \\"hi\\"")'
    );
  });

  it("returns empty for comments-only input", () => {
    expect(stripOttlComments("# just a comment\n\n   # another")).toBe("");
  });
});

describe("collectStatementsForDryRun", () => {
  const yaml = [
    "processors:",                              // 0
    "  transform/logs:",                        // 1
    "    log_statements:",                      // 2
    "      - context: log",                     // 3
    '        statements:',                      // 4
    '          - set(log.body, "a")',           // 5
    '          - set(log.attributes["x"], "y")',// 6
    "  transform/traces:",                      // 7
    "    trace_statements:",                    // 8
    "      - context: span",                    // 9
    "        statements:",                      // 10
    '          - set(span.name, "z")',          // 11
  ].join("\n");

  it("picks the logs block when the cursor is inside it", () => {
    const r = collectStatementsForDryRun(yaml, 6);
    expect(r.signal).toBe("logs");
    expect(r.statements).toBe('set(log.body, "a")\nset(log.attributes["x"], "y")');
  });

  it("picks the traces block when the cursor is inside it", () => {
    const r = collectStatementsForDryRun(yaml, 11);
    expect(r.signal).toBe("traces");
    expect(r.statements).toBe('set(span.name, "z")');
  });

  it("falls back to the first block when the cursor is above everything", () => {
    const r = collectStatementsForDryRun(yaml, 0);
    expect(r.signal).toBe("logs");
  });

  it("returns empty when there are no runnable statements (filter conditions only)", () => {
    const filterOnly = [
      "processors:",
      "  filter:",
      "    log_conditions:",
      '      - IsMatch(log.body, ".*x.*")',
    ].join("\n");
    expect(collectStatementsForDryRun(filterOnly, 3)).toEqual({ statements: "", signal: null, errorMode: null });
  });
});

describe("error_mode extraction", () => {
  const cfg = [
    "processors:",                                // 0
    "  transform/a:",                             // 1
    "    error_mode: propagate",                  // 2
    "    log_statements:",                        // 3
    "      - context: log",                       // 4
    "        statements:",                        // 5
    '          - set(log.body, "a")',             // 6
    "      - context: log",                       // 7
    "        error_mode: silent",                 // 8
    "        statements:",                        // 9
    '          - set(log.body, "b")',             // 10
    "  transform/flat:",                          // 11
    "    trace_statements:",                      // 12
    '      - set(span.name, "x")',                // 13
    "connectors:",                                // 14
    "  routing:",                                 // 15
    "    error_mode: ignore",                     // 16
    "    table:",                                 // 17
    "      - statement: route() where true",      // 18
  ].join("\n");
  const byText = (t: string) => extractOTTL(cfg).find((x) => x.text.includes(t))!;

  it("uses the processor-level error_mode", () => {
    expect(byText('"a"').errorMode).toBe("propagate");
  });
  it("lets a statement group override it", () => {
    expect(byText('"b"').errorMode).toBe("silent");
  });
  it("is null when the config doesn't set it", () => {
    expect(byText("span.name").errorMode).toBeNull();
  });
  it("reads the routing connector's error_mode", () => {
    expect(byText("route()").errorMode).toBe("ignore");
  });
  it("returns the error_mode of the group under the cursor for dry-run", () => {
    expect(collectStatementsForDryRun(cfg, 6).errorMode).toBe("propagate");
    expect(collectStatementsForDryRun(cfg, 10).errorMode).toBe("silent");
    expect(collectStatementsForDryRun(cfg, 13).errorMode).toBeNull();
  });
});

describe("extractOTTL — robustness", () => {
  it("returns [] for non-collector YAML", () => {
    expect(extractOTTL("foo: bar\nbaz: [1,2,3]")).toEqual([]);
  });
  it("returns [] for invalid YAML instead of throwing", () => {
    expect(extractOTTL("processors: {{ .Values.x }}")).toEqual([]);
  });
  it("ignores non-OTTL processors", () => {
    const yaml = ["processors:", "  batch:", "    timeout: 5s"].join("\n");
    expect(extractOTTL(yaml)).toEqual([]);
  });
  it("handles the bare top-level component map (testdata style)", () => {
    const yaml = [
      "transform:",
      "  trace_statements:",
      '    - set(span.name, "x")',
    ].join("\n");
    const got = extractOTTL(yaml);
    expect(got).toHaveLength(1);
    expect(got[0].component).toBe("transform");
  });
});
