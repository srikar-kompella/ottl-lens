import { describe, it, expect } from "vitest";
import { normalizePayloadInput, detectSignal, countRecords, describeConversion } from "./payload";
import { SAMPLES, defaultSampleFor, sampleById, samplePayloadText } from "./samples";

const LOG_REQ = (body: string) =>
  JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: [{ body: { stringValue: body } }] }] }] });
const SPAN_REQ = JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [{ name: "a" }, { name: "b" }] }] }] });

describe("detectSignal / countRecords", () => {
  it("detects each signal, including snake_case roots", () => {
    expect(detectSignal({ resourceLogs: [] })).toBe("logs");
    expect(detectSignal({ resource_spans: [] })).toBe("traces");
    expect(detectSignal({ resourceMetrics: [] })).toBe("metrics");
    expect(detectSignal({ foo: 1 })).toBeUndefined();
    expect(detectSignal([1, 2])).toBeUndefined();
  });

  it("counts records per signal", () => {
    expect(countRecords(JSON.parse(SPAN_REQ), "traces")).toBe(2);
    expect(countRecords(JSON.parse(LOG_REQ("x")), "logs")).toBe(1);
    expect(
      countRecords(
        { resourceMetrics: [{ scopeMetrics: [{ metrics: [{ gauge: { dataPoints: [{}, {}] } }, { sum: { dataPoints: [{}] } }] }] }] },
        "metrics"
      )
    ).toBe(3);
    expect(countRecords("nope", "logs")).toBe(0);
  });

  it("counts snake_case payloads from older exporters", () => {
    expect(countRecords({ resource_logs: [{ scope_logs: [{ log_records: [{}, {}] }] }] }, "logs")).toBe(2);
    expect(countRecords({ resource_spans: [{ scope_spans: [{ spans: [{}] }] }] }, "traces")).toBe(1);
    expect(
      countRecords({ resource_metrics: [{ scope_metrics: [{ metrics: [{ gauge: { data_points: [{}] } }] }] }] }, "metrics")
    ).toBe(1);
  });

  it("counts summary and exponential-histogram datapoints, and tolerates metrics without data", () => {
    const payload = {
      resourceMetrics: [{
        scopeMetrics: [{
          metrics: [{ summary: { dataPoints: [{}] } }, { exponentialHistogram: { dataPoints: [{}, {}] } }, { name: "empty" }],
        }],
      }],
    };
    expect(countRecords(payload, "metrics")).toBe(3);
    expect(countRecords({ resourceLogs: [{}] }, "logs")).toBe(0);
  });
});

describe("normalizePayloadInput", () => {
  it("passes OTLP JSON through untouched, preserving the user's formatting", () => {
    const text = '{\n  "resourceSpans": []\n}';
    const r = normalizePayloadInput(text);
    expect(r).toMatchObject({ ok: true, signal: "traces", source: "json", json: text });
    expect(describeConversion(r)).toBeUndefined();
  });

  it("rejects JSON that isn't OTLP", () => {
    const r = normalizePayloadInput('{"hello": "world"}');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/isn't an OTLP payload/);
  });

  it("reports the parse error for broken JSON", () => {
    const r = normalizePayloadInput('{"resourceLogs": [');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/looks like JSON but doesn't parse/);
  });

  it("merges JSON Lines from the file exporter", () => {
    const r = normalizePayloadInput(`${LOG_REQ("one")}\n${LOG_REQ("two")}\n`);
    expect(r).toMatchObject({ ok: true, signal: "logs", source: "jsonl", records: 2 });
    expect(JSON.parse(r.json!).resourceLogs).toHaveLength(2);
    expect(describeConversion(r)).toBe("Converted JSON Lines → OTLP JSON (2 log records).");
  });

  it("keeps the first signal in mixed JSON Lines and warns", () => {
    const r = normalizePayloadInput(`${LOG_REQ("one")}\n${SPAN_REQ}`);
    expect(r.signal).toBe("logs");
    expect(r.warnings[0]).toMatch(/Skipped 1 line that weren't logs/);
  });

  it("converts debug exporter output", () => {
    const text = "ResourceSpans #0\nScopeSpans #0\nSpan #0\n    Name           : GET /\n    Kind           : Server";
    const r = normalizePayloadInput(text);
    expect(r).toMatchObject({ ok: true, signal: "traces", source: "debug", records: 1 });
    expect(JSON.parse(r.json!).resourceSpans[0].scopeSpans[0].spans[0]).toMatchObject({ name: "GET /", kind: 2 });
    expect(describeConversion(r)).toBe("Converted debug exporter output → OTLP JSON (1 span).");
  });

  it("surfaces a debug-parse failure", () => {
    const r = normalizePayloadInput("ResourceLog #0\nScopeLogs #0");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no complete records/);
  });

  it("points basic/normal verbosity users at `verbosity: detailed`", () => {
    const r = normalizePayloadInput('2026-09-21T12:53:21Z\tinfo\tLogs\t{"resource logs": 1, "log records": 1}');
    expect(r.error).toMatch(/verbosity: detailed/);
  });

  it("gives a generic message for unrecognisable text", () => {
    expect(normalizePayloadInput("just some words").error).toMatch(/Couldn't read the payload/);
  });

  it("rejects an empty payload", () => {
    expect(normalizePayloadInput("   \n ").error).toMatch(/empty/);
  });

  it("uses the first line that has a signal, even if an earlier line has none", () => {
    const r = normalizePayloadInput(`{"meta": 1}\n${SPAN_REQ}`);
    expect(r).toMatchObject({ ok: true, signal: "traces", source: "jsonl", records: 2 });
    expect(r.warnings[0]).toMatch(/Skipped 1 line/);
  });

  it("does not treat lines as JSON Lines when one of them fails to parse", () => {
    const r = normalizePayloadInput(`${LOG_REQ("one")}\n{broken`);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/doesn't parse/);
  });

  it("does not treat non-OTLP JSON Lines as a payload", () => {
    const r = normalizePayloadInput('{"a":1}\n{"b":2}');
    expect(r.ok).toBe(false);
  });

  it("describes a metrics conversion in datapoints", () => {
    const text = [
      "ResourceMetrics #0", "ScopeMetrics #0", "Metric #0", "Descriptor:",
      "     -> Name: m", "     -> DataType: Gauge", "NumberDataPoints #0", "Value: 1",
    ].join("\n");
    expect(describeConversion(normalizePayloadInput(text))).toBe(
      "Converted debug exporter output → OTLP JSON (1 datapoint)."
    );
  });
});

describe("samples", () => {
  it("has unique ids and a payload that matches its declared signal", () => {
    expect(new Set(SAMPLES.map((s) => s.id)).size).toBe(SAMPLES.length);
    for (const s of SAMPLES) {
      const r = normalizePayloadInput(samplePayloadText(s));
      expect(r.ok, s.id).toBe(true);
      expect(r.signal, s.id).toBe(s.signal);
      expect(r.records, s.id).toBeGreaterThan(0);
    }
  });

  it("offers at least two samples per signal", () => {
    for (const sig of ["logs", "traces", "metrics"]) {
      expect(SAMPLES.filter((s) => s.signal === sig).length).toBeGreaterThanOrEqual(2);
    }
  });

  it("picks a default per signal and looks samples up by id", () => {
    expect(defaultSampleFor("traces").signal).toBe("traces");
    expect(defaultSampleFor("unknown").id).toBe(SAMPLES[0].id);
    expect(sampleById("logs-json-body-pii")?.signal).toBe("logs");
    expect(sampleById("nope")).toBeUndefined();
  });
});
