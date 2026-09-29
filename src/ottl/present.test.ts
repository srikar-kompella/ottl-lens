import { describe, it, expect } from "vitest";
import { ottlLabel, displayValue, presentDiff, computeOrdinals, tokenize, kindOf } from "./present";
import { diffJSON } from "./trace";

const LOG = "resourceLogs[0].scopeLogs[0].logRecords[0]";
const SPAN = "resourceSpans[0].scopeSpans[0].spans[0]";
const MET = "resourceMetrics[0].scopeMetrics[0].metrics[0]";

describe("tokenize", () => {
  it("splits names, indices and quoted keys (keys may contain dots and quotes)", () => {
    expect(tokenize('a[0].b["x.y"]["q\\"t"]')).toEqual([
      { t: "name", v: "a" }, { t: "index", v: 0 }, { t: "name", v: "b" },
      { t: "key", v: "x.y" }, { t: "key", v: 'q"t' },
    ]);
  });
  it("rejects paths it cannot read", () => {
    expect(tokenize("(root)")).toBeUndefined();
  });
});

describe("ottlLabel", () => {
  const l = (p: string) => ottlLabel(p).label;

  it("maps log fields to OTTL log paths", () => {
    expect(l(`${LOG}.attributes["env"]`)).toBe('log.attributes["env"]');
    expect(l(`${LOG}.attributes["env"].value.stringValue`)).toBe('log.attributes["env"]');
    expect(l(`${LOG}.body.stringValue`)).toBe("log.body");
    expect(l(`${LOG}.severityText`)).toBe("log.severity_text");
    expect(l(`${LOG}.timeUnixNano`)).toBe("log.time_unix_nano");
  });

  it("reports the leaf value kind", () => {
    expect(ottlLabel(`${LOG}.attributes["code"].value.intValue`).leafKind).toBe("intValue");
  });

  it("unwraps nested maps and slices into OTTL indexing", () => {
    expect(l(`${LOG}.attributes["m"].value.kvlistValue.values["inner"].value.stringValue`)).toBe(
      'log.attributes["m"]["inner"]'
    );
    expect(l(`${LOG}.attributes["tags"].value.arrayValue.values[1].stringValue`)).toBe('log.attributes["tags"][1]');
  });

  it("maps resource and scope paths", () => {
    expect(l('resourceLogs[0].resource.attributes["service.name"]')).toBe('resource.attributes["service.name"]');
    expect(l("resourceLogs[0].schemaUrl")).toBe("resource.schema_url");
    expect(l("resourceLogs[0].scopeLogs[0].scope.name")).toBe("instrumentation_scope.name");
    expect(l("resourceLogs[0].scopeLogs[0].schemaUrl")).toBe("instrumentation_scope.schema_url");
  });

  it("maps span, span status and span event paths", () => {
    expect(l(`${SPAN}.name`)).toBe("span.name");
    expect(l(`${SPAN}.status.code`)).toBe("span.status.code");
    expect(l(`${SPAN}.parentSpanId`)).toBe("span.parent_span_id");
    expect(l(`${SPAN}.events[0].attributes["exception.type"]`)).toBe(
      'spanevent.attributes["exception.type"]  (event #1)'
    );
  });

  it("maps metric and datapoint paths, including value_double / value_int", () => {
    expect(l(`${MET}.name`)).toBe("metric.name");
    expect(l(`${MET}.gauge.dataPoints[0].asDouble`)).toBe("datapoint.value_double");
    expect(l(`${MET}.sum.dataPoints[0].asInt`)).toBe("datapoint.value_int");
    expect(l(`${MET}.sum.dataPoints[0].attributes["url.path"]`)).toBe('datapoint.attributes["url.path"]');
    expect(l(`${MET}.sum`)).toBe("metric.sum");
  });

  it("falls back to the raw path for anything it doesn't recognise", () => {
    expect(l("(root)")).toBe("(root)");
    expect(l("foo[0].bar")).toBe("foo[0].bar");
    expect(l("resourceLogs[0].weird")).toBe("resourceLogs[0].weird");
    expect(l("resourceLogs[0].scopeLogs[0].weird")).toBe("resourceLogs[0].scopeLogs[0].weird");
  });
});

describe("locators for multi-record payloads", () => {
  const logs = {
    resourceLogs: [
      { resource: {}, scopeLogs: [{ logRecords: [{}, {}] }] },
      { resource: {}, scopeLogs: [{ logRecords: [{}] }, { logRecords: [{}] }] },
    ],
  };
  const ord = computeOrdinals(logs);

  it("numbers records in payload order across resources and scopes", () => {
    expect(ottlLabel("resourceLogs[0].scopeLogs[0].logRecords[1].body", ord).label).toBe("log.body  (log #2)");
    expect(ottlLabel("resourceLogs[1].scopeLogs[1].logRecords[0].body", ord).label).toBe("log.body  (log #4)");
  });

  it("labels resources and scopes when there are several", () => {
    expect(ottlLabel('resourceLogs[1].resource.attributes["a"]', ord).label).toBe('resource.attributes["a"]  (resource #2)');
    expect(ottlLabel("resourceLogs[1].scopeLogs[1].scope.name", ord).label).toBe("instrumentation_scope.name  (scope #3)");
    expect(ottlLabel("resourceLogs[1].schemaUrl", ord).label).toBe("resource.schema_url (resource #2)");
  });

  it("numbers datapoints across metrics, and spans for events", () => {
    const metrics = {
      resourceMetrics: [{ scopeMetrics: [{ metrics: [{ gauge: { dataPoints: [{}] } }, { sum: { dataPoints: [{}, {}] } }] }] }],
    };
    const mo = computeOrdinals(metrics);
    expect(ottlLabel(`resourceMetrics[0].scopeMetrics[0].metrics[1].sum.dataPoints[1].asInt`, mo).label).toBe(
      "datapoint.value_int  (datapoint #3)"
    );
    const spans = { resourceSpans: [{ scopeSpans: [{ spans: [{}, { events: [{}] }] }] }] };
    expect(
      ottlLabel('resourceSpans[0].scopeSpans[0].spans[1].events[0].name', computeOrdinals(spans)).label
    ).toBe("spanevent.name  (span #2, event #1)");
  });

  it("returns empty ordinals for non-OTLP input", () => {
    expect(computeOrdinals("x").resources).toBe(0);
    expect(computeOrdinals({ foo: [] }).items.size).toBe(0);
  });
});

describe("displayValue / kindOf", () => {
  it("renders OTTL-style literals", () => {
    expect(displayValue({ key: "env", value: { stringValue: "prod" } })).toBe('"prod"');
    expect(displayValue({ intValue: "500" })).toBe("500");
    expect(displayValue({ boolValue: true })).toBe("true");
    expect(displayValue({ doubleValue: 0.5 })).toBe("0.5");
    expect(displayValue({ bytesValue: "aGk=" })).toBe('"bytes(aGk=)"');
    expect(displayValue({})).toBe("nil");
    expect(displayValue(undefined)).toBe("nil");
  });

  it("renders maps and slices compactly", () => {
    expect(
      displayValue({ kvlistValue: { values: [{ key: "a", value: { intValue: "1" } }, { key: "b", value: { arrayValue: { values: [{ stringValue: "x" }] } } }] } })
    ).toBe('{"a":1,"b":["x"]}');
  });

  it("uses the leaf kind for bare primitives", () => {
    expect(displayValue("500", "intValue")).toBe("500");
    expect(displayValue("500", "stringValue")).toBe('"500"');
    expect(displayValue("x")).toBe('"x"');
    expect(displayValue(42)).toBe("42");
  });

  it("truncates long values and shows unknown objects as JSON", () => {
    const long = displayValue({ weird: "y".repeat(300) });
    expect(long.length).toBe(100);
    expect(long.endsWith("…")).toBe(true);
    expect(displayValue({ kvlistValue: {} })).toBe("{}");
    expect(displayValue({ arrayValue: {} })).toBe("[]");
  });

  it("identifies value kinds", () => {
    expect(kindOf({ key: "k", value: { intValue: "1" } })).toBe("intValue");
    expect(kindOf({})).toBe("empty");
    expect(kindOf("x")).toBeUndefined();
  });
});

describe("presentDiff on real OTLP diffs", () => {
  const rec = (attrs: unknown[], body = "hello") => ({
    resourceLogs: [{ scopeLogs: [{ logRecords: [{ body: { stringValue: body }, attributes: attrs }] }] }],
  });

  it("reads like OTTL: added, removed and changed attributes", () => {
    const before = rec([{ key: "environment", value: { stringValue: "staging" } }, { key: "tier", value: { stringValue: "free" } }]);
    const after = rec([{ key: "tier", value: { stringValue: "gold" } }, { key: "env", value: { stringValue: "production" } }]);
    expect(presentDiff(diffJSON(before, after), before)).toEqual([
      { kind: "removed", label: 'log.attributes["environment"]', text: '"staging"' },
      { kind: "changed", label: 'log.attributes["tier"]', text: '"free" → "gold"' },
      { kind: "added", label: 'log.attributes["env"]', text: '"production"' },
    ]);
  });

  it("merges a type change into one line and names the conversion", () => {
    const before = rec([{ key: "code", value: { stringValue: "500" } }]);
    const after = rec([{ key: "code", value: { intValue: "500" } }]);
    expect(presentDiff(diffJSON(before, after), before)).toEqual([
      { kind: "changed", label: 'log.attributes["code"]', text: '"500" → 500  (string → int)' },
    ]);
  });

  it("shows a parsed JSON body landing as a map attribute", () => {
    const parsed = { key: "parsed", value: { kvlistValue: { values: [{ key: "level", value: { stringValue: "error" } }] } } };
    const before = rec([]);
    expect(presentDiff(diffJSON(before, rec([parsed])), before)).toEqual([
      { kind: "added", label: 'log.attributes["parsed"]', text: '{"level":"error"}' },
    ]);
  });

  it("names each attribute when the engine output had no attribute list at all", () => {
    // Real engine output omits empty lists, so `attributes` appears from nothing.
    const bare = { resourceLogs: [{ scopeLogs: [{ logRecords: [{ body: { stringValue: "x" } }] }] }] };
    const after = rec([{ key: "env", value: { stringValue: "production" } }], "x");
    expect(presentDiff(diffJSON(bare, after), bare)).toEqual([
      { kind: "added", label: 'log.attributes["env"]', text: '"production"' },
    ]);
  });

  it("shows a body rewrite", () => {
    const before = rec([], "a");
    const after = rec([], "b");
    expect(presentDiff(diffJSON(before, after), before)).toEqual([
      { kind: "changed", label: "log.body", text: '"a" → "b"' },
    ]);
  });

  it("does not merge a removed/added pair on different paths", () => {
    const before = rec([{ key: "a", value: { stringValue: "1" } }]);
    const after = rec([{ key: "b", value: { stringValue: "1" } }]);
    expect(presentDiff(diffJSON(before, after), before).map((r) => r.kind)).toEqual(["removed", "added"]);
  });

  it("merges an added-then-removed pair too, without a type note when kinds match", () => {
    const rows = presentDiff(
      [
        { path: `${LOG}.attributes["x"].value.stringValue`, kind: "added", after: "b" },
        { path: `${LOG}.attributes["x"].value.stringValue`, kind: "removed", before: "a" },
      ],
      rec([])
    );
    expect(rows).toEqual([{ kind: "changed", label: 'log.attributes["x"]', text: '"a" → "b"' }]);
  });
});
