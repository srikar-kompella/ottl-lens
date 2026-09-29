import { describe, it, expect } from "vitest";
import {
  parseDebugText,
  goTimeToUnixNano,
  typedToAnyValue,
  rawToAnyValue,
  looksLikeDebugOutput,
} from "./debugText";

/*
 * Fixtures mirror the upstream marshaler exactly
 * (opentelemetry-collector/exporter/debugexporter/internal/otlptext):
 *   logEntry  → "<text>\n"
 *   logAttr   → "    %-15s: %s"         (span fields)
 *   attributes→ "     -> key: Type(v)"  (event attrs nest under "     -> Attributes::")
 *   doubles   → %f (always a decimal point), ints → %d
 */

const NS = (iso: string, fracNs = 0n) => (BigInt(Date.parse(iso)) * 1_000_000n + fracNs).toString();

const LOGS = [
  "2026-09-21T12:53:21.000Z\tinfo\tResourceLog #0",
  "Resource SchemaURL: https://opentelemetry.io/schemas/1.26.0",
  "Resource attributes:",
  "     -> service.name: Str(checkout)",
  "     -> k8s.pod.name: Str(checkout-7d9f8c6b5-x2kqp)",
  "ScopeLogs #0",
  "ScopeLogs SchemaURL: ",
  "InstrumentationScope app 1.2.0",
  "InstrumentationScope attributes:",
  "     -> lib.lang: Str(go)",
  "LogRecord #0",
  "ObservedTimestamp: 2026-09-21 12:53:20.25 +0000 UTC",
  "Timestamp: 2026-09-21 12:53:20 +0000 UTC",
  "SeverityText: ERROR",
  "SeverityNumber: Error(17)",
  'Body: Str({"level":"error","msg":"payment declined"})',
  "Attributes:",
  "     -> http.response.status_code: Int(500)",
  "     -> retry: Bool(true)",
  "     -> ratio: Double(0.75)",
  '     -> tags: Slice(["a","b"])',
  '     -> ctx: Map({"user":{"id":7}})',
  "     -> raw: Bytes(aGVsbG8=)",
  "     -> nothing: Empty()",
  "Trace ID: 4bf92f3577b34da6a3ce929d0e0e4736",
  "Span ID: 00f067aa0ba902b7",
  "Flags: 1",
  "LogRecord #1",
  "ObservedTimestamp: 1970-01-01 00:00:00 +0000 UTC",
  "Timestamp: 1970-01-01 00:00:00 +0000 UTC",
  "SeverityText: ",
  "SeverityNumber: Unspecified(0)",
  "Body: Str(java.lang.IllegalStateException: boom",
  "\tat com.example.Checkout.pay(Checkout.java:42)",
  "\tat com.example.Main.main(Main.java:7))",
  "Trace ID: ",
  "Span ID: ",
  "Flags: 0",
  '\t{"otelcol.component.id": "debug", "otelcol.component.kind": "exporter", "otelcol.signal": "logs"}',
].join("\n");

const TRACES = [
  "ResourceSpans #0",
  "Resource SchemaURL: ",
  "Resource attributes:",
  "     -> service.name: Str(checkout)",
  "ScopeSpans #0",
  "ScopeSpans SchemaURL: ",
  "InstrumentationScope io.opentelemetry.http ",
  "Span #0",
  "    Trace ID       : 4bf92f3577b34da6a3ce929d0e0e4736",
  "    Parent ID      : ",
  "    ID             : 00f067aa0ba902b7",
  "    Name           : POST /api/checkout",
  "    Kind           : Server",
  "    TraceState     : vendor=abc",
  "    Start time     : 2026-09-21 12:53:20 +0000 UTC",
  "    End time       : 2026-09-21 12:53:20.25 +0000 UTC",
  "    Status code    : Error",
  "    Status message : payment gateway timeout",
  "    DroppedAttributesCount: 2",
  "    DroppedEventsCount: 0",
  "    DroppedLinksCount: 0",
  "Attributes:",
  "     -> http.request.method: Str(POST)",
  "     -> http.response.status_code: Int(500)",
  "Events:",
  "SpanEvent #0",
  "     -> Name: exception",
  "     -> Timestamp: 2026-09-21 12:53:20.25 +0000 UTC",
  "     -> DroppedAttributesCount: 0",
  "     -> Attributes::",
  "          -> exception.type: Str(PaymentGatewayTimeout)",
  "Links:",
  "SpanLink #0",
  "     -> Trace ID: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "     -> ID: bbbbbbbbbbbbbbbb",
  "     -> TraceState: ",
  "     -> DroppedAttributesCount: 0",
  "Span #1",
  "    Trace ID       : 4bf92f3577b34da6a3ce929d0e0e4736",
  "    Parent ID      : 00f067aa0ba902b7",
  "    ID             : b7ad6b7169203331",
  "    Name           : SELECT shop.users",
  "    Kind           : Client",
  "    Start time     : 2026-09-21 12:53:20 +0000 UTC",
  "    End time       : 2026-09-21 12:53:20.25 +0000 UTC",
  "    Status code    : Unset",
  "    Status message : ",
  "    DroppedAttributesCount: 0",
  "    DroppedEventsCount: 0",
  "    DroppedLinksCount: 0",
].join("\n");

const METRICS = [
  "ResourceMetrics #0",
  "Resource SchemaURL: ",
  "Resource attributes:",
  "     -> service.name: Str(checkout)",
  "ScopeMetrics #0",
  "ScopeMetrics SchemaURL: ",
  "InstrumentationScope io.opentelemetry.http ",
  "Metric #0",
  "Descriptor:",
  "     -> Name: http.server.requests",
  "     -> Description: Total requests",
  "     -> Unit: {request}",
  "     -> DataType: Sum",
  "     -> IsMonotonic: true",
  "     -> AggregationTemporality: Cumulative",
  "NumberDataPoints #0",
  "Data point attributes:",
  "     -> http.request.method: Str(GET)",
  "StartTimestamp: 2026-09-21 12:53:20 +0000 UTC",
  "Timestamp: 2026-09-21 12:53:20.25 +0000 UTC",
  "Value: 1532",
  "Metric #1",
  "Descriptor:",
  "     -> Name: cpu.utilization",
  "     -> Description: ",
  "     -> Unit: 1",
  "     -> DataType: Gauge",
  "NumberDataPoints #0",
  "StartTimestamp: 1970-01-01 00:00:00 +0000 UTC",
  "Timestamp: 2026-09-21 12:53:20 +0000 UTC",
  "Value: 0.420000",
  "Metric #2",
  "Descriptor:",
  "     -> Name: http.server.request.duration",
  "     -> Description: ",
  "     -> Unit: s",
  "     -> DataType: Histogram",
  "     -> AggregationTemporality: Delta",
  "HistogramDataPoints #0",
  "Data point attributes:",
  "     -> http.route: Str(/api/orders)",
  "StartTimestamp: 2026-09-21 12:53:20 +0000 UTC",
  "Timestamp: 2026-09-21 12:53:20.25 +0000 UTC",
  "Count: 3",
  "Sum: 0.600000",
  "Min: 0.100000",
  "Max: 0.300000",
  "ExplicitBounds #0: 0.250000",
  "ExplicitBounds #1: 0.500000",
  "Buckets #0, Count: 1",
  "Buckets #1, Count: 2",
  "Buckets #2, Count: 0",
  "Exemplars:",
  "Exemplar #0",
  "     -> Trace ID: 4bf92f3577b34da6a3ce929d0e0e4736",
  "     -> Span ID: 00f067aa0ba902b7",
  "     -> Timestamp: 2026-09-21 12:53:20 +0000 UTC",
  "     -> Value: 0.100000",
  "     -> FilteredAttributes:",
  "          -> host: Str(a)",
  "Metric #3",
  "Descriptor:",
  "     -> Name: rpc.duration.summary",
  "     -> Description: ",
  "     -> Unit: ms",
  "     -> DataType: Summary",
  "SummaryDataPoints #0",
  "StartTimestamp: 2026-09-21 12:53:20 +0000 UTC",
  "Timestamp: 2026-09-21 12:53:20.25 +0000 UTC",
  "Count: 10",
  "Sum: 100.000000",
  "QuantileValue #0: Quantile 0.500000, Value 9.000000",
].join("\n");

/* eslint-disable @typescript-eslint/no-explicit-any */
const logsOf = (p: any) => p.resourceLogs[0].scopeLogs[0].logRecords;
const spansOf = (p: any) => p.resourceSpans[0].scopeSpans[0].spans;
const metricsOf = (p: any) => p.resourceMetrics[0].scopeMetrics[0].metrics;

describe("goTimeToUnixNano", () => {
  it("converts Go time.String() in UTC, with and without fraction", () => {
    expect(goTimeToUnixNano("2026-09-21 12:53:20 +0000 UTC")).toBe(NS("2026-09-21T12:53:20Z"));
    expect(goTimeToUnixNano("2026-09-21 12:53:20.25 +0000 UTC")).toBe(NS("2026-09-21T12:53:20Z", 250_000_000n));
  });
  it("keeps full nanosecond precision", () => {
    expect(goTimeToUnixNano("2026-09-21 12:53:20.123456789 +0000 UTC")).toBe(
      NS("2026-09-21T12:53:20Z", 123_456_789n)
    );
  });
  it("applies a non-UTC offset", () => {
    expect(goTimeToUnixNano("2026-09-21 14:53:20 +0200 CEST")).toBe(NS("2026-09-21T12:53:20Z"));
    expect(goTimeToUnixNano("2026-09-21 07:53:20 -0500 EST")).toBe(NS("2026-09-21T12:53:20Z"));
  });
  it("returns '0' for the epoch and undefined for garbage", () => {
    expect(goTimeToUnixNano("1970-01-01 00:00:00 +0000 UTC")).toBe("0");
    expect(goTimeToUnixNano("yesterday")).toBeUndefined();
  });
});

describe("typedToAnyValue / rawToAnyValue", () => {
  const w: string[] = [];
  it("maps every pcommon value type", () => {
    expect(typedToAnyValue("Str(hi)", w)).toEqual({ stringValue: "hi" });
    expect(typedToAnyValue("Int(42)", w)).toEqual({ intValue: "42" });
    expect(typedToAnyValue("Double(1.5)", w)).toEqual({ doubleValue: 1.5 });
    expect(typedToAnyValue("Bool(false)", w)).toEqual({ boolValue: false });
    expect(typedToAnyValue("Bytes(aGk=)", w)).toEqual({ bytesValue: "aGk=" });
    expect(typedToAnyValue("Empty()", w)).toEqual({});
  });
  it("keeps parentheses that belong to the string", () => {
    expect(typedToAnyValue("Str(f(x) = y)", w)).toEqual({ stringValue: "f(x) = y" });
  });
  it("converts Map and Slice JSON recursively", () => {
    expect(typedToAnyValue('Map({"a":1,"b":[true,null,"s",2.5]})', w)).toEqual({
      kvlistValue: {
        values: [
          { key: "a", value: { intValue: "1" } },
          {
            key: "b",
            value: {
              arrayValue: { values: [{ boolValue: true }, {}, { stringValue: "s" }, { doubleValue: 2.5 }] },
            },
          },
        ],
      },
    });
  });
  it("falls back to a string (with a warning) for unreadable Map JSON", () => {
    const warnings: string[] = [];
    expect(typedToAnyValue("Map({broken)", warnings)).toEqual({ stringValue: "{broken" });
    expect(warnings[0]).toMatch(/Map value/);
  });
  it("keeps a non-finite double as a string", () => {
    const warnings: string[] = [];
    expect(typedToAnyValue("Double(NaN)", warnings)).toEqual({ stringValue: "NaN" });
    expect(warnings).toHaveLength(1);
  });
  it("treats an untyped value as a plain string", () => {
    expect(typedToAnyValue("plain", w)).toEqual({ stringValue: "plain" });
    expect(rawToAnyValue(undefined)).toEqual({});
  });
});

describe("parseDebugText — logs", () => {
  const r = parseDebugText(LOGS);
  const recs = logsOf(r.payload);

  it("detects the signal and counts records", () => {
    expect(r.ok).toBe(true);
    expect(r.signal).toBe("logs");
    expect(r.records).toBe(2);
  });

  it("reads resource, schema URL and scope", () => {
    const rl = (r.payload as any).resourceLogs[0];
    expect(rl.schemaUrl).toBe("https://opentelemetry.io/schemas/1.26.0");
    expect(rl.resource.attributes).toContainEqual({ key: "service.name", value: { stringValue: "checkout" } });
    expect(rl.scopeLogs[0].scope).toEqual({
      name: "app",
      version: "1.2.0",
      attributes: [{ key: "lib.lang", value: { stringValue: "go" } }],
    });
    expect(rl.scopeLogs[0].schemaUrl).toBeUndefined();
  });

  it("reads every log record field", () => {
    expect(recs[0]).toMatchObject({
      observedTimeUnixNano: NS("2026-09-21T12:53:20Z", 250_000_000n),
      timeUnixNano: NS("2026-09-21T12:53:20Z"),
      severityText: "ERROR",
      severityNumber: 17,
      body: { stringValue: '{"level":"error","msg":"payment declined"}' },
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      flags: 1,
    });
    expect(recs[0].attributes).toHaveLength(7);
    expect(recs[0].attributes[0]).toEqual({ key: "http.response.status_code", value: { intValue: "500" } });
  });

  it("joins a multi-line body (stack trace) and ignores the trailing zap fields", () => {
    expect(recs[1].body.stringValue).toBe(
      "java.lang.IllegalStateException: boom\n\tat com.example.Checkout.pay(Checkout.java:42)\n\tat com.example.Main.main(Main.java:7)"
    );
  });

  it("omits zero timestamps, empty ids and empty attribute lists", () => {
    expect(recs[1].timeUnixNano).toBeUndefined();
    expect(recs[1].traceId).toBeUndefined();
    expect(recs[1].severityNumber).toBeUndefined();
    expect(recs[1].attributes).toBeUndefined();
    expect(recs[1].flags).toBeUndefined();
  });
});

describe("parseDebugText — traces", () => {
  const r = parseDebugText(TRACES);
  const [server, client] = spansOf(r.payload);

  it("reads the padded span fields", () => {
    expect(r.signal).toBe("traces");
    expect(r.records).toBe(2);
    expect(server).toMatchObject({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      name: "POST /api/checkout",
      kind: 2,
      traceState: "vendor=abc",
      startTimeUnixNano: NS("2026-09-21T12:53:20Z"),
      endTimeUnixNano: NS("2026-09-21T12:53:20Z", 250_000_000n),
      status: { code: 2, message: "payment gateway timeout" },
      droppedAttributesCount: 2,
    });
    expect(server.parentSpanId).toBeUndefined();
    expect(client).toMatchObject({ kind: 3, parentSpanId: "00f067aa0ba902b7" });
    expect(client.status).toBeUndefined(); // Unset + empty message
  });

  it("reads span events with their nested attributes", () => {
    expect(server.events).toEqual([
      {
        name: "exception",
        timeUnixNano: NS("2026-09-21T12:53:20Z", 250_000_000n),
        attributes: [{ key: "exception.type", value: { stringValue: "PaymentGatewayTimeout" } }],
      },
    ]);
  });

  it("does not leak link fields into the span, and warns about links", () => {
    expect(server.attributes).toHaveLength(2);
    expect(r.warnings.some((w) => /links/i.test(w))).toBe(true);
  });

  it("reads a scope with a name and no version", () => {
    expect((r.payload as any).resourceSpans[0].scopeSpans[0].scope).toEqual({ name: "io.opentelemetry.http" });
  });
});

describe("parseDebugText — metrics", () => {
  const r = parseDebugText(METRICS);
  const ms = metricsOf(r.payload);

  it("converts sum, gauge and histogram, and skips summaries with a warning", () => {
    expect(r.signal).toBe("metrics");
    expect(ms.map((m: any) => m.name)).toEqual([
      "http.server.requests",
      "cpu.utilization",
      "http.server.request.duration",
    ]);
    expect(r.records).toBe(3);
    expect(r.warnings.some((w) => /Skipped 1 Summary metric/.test(w))).toBe(true);
  });

  it("reads a monotonic cumulative sum with an int value", () => {
    expect(ms[0]).toMatchObject({ description: "Total requests", unit: "{request}" });
    expect(ms[0].sum).toMatchObject({ isMonotonic: true, aggregationTemporality: 2 });
    expect(ms[0].sum.dataPoints[0]).toMatchObject({
      asInt: "1532",
      attributes: [{ key: "http.request.method", value: { stringValue: "GET" } }],
      startTimeUnixNano: NS("2026-09-21T12:53:20Z"),
    });
  });

  it("reads a gauge with a double value and no start time", () => {
    expect(ms[1].description).toBeUndefined();
    expect(ms[1].gauge.dataPoints[0]).toEqual({ timeUnixNano: NS("2026-09-21T12:53:20Z"), asDouble: 0.42 });
  });

  it("reads a histogram's count, sum, bounds and buckets, ignoring exemplars", () => {
    expect(ms[2].histogram.aggregationTemporality).toBe(1);
    expect(ms[2].histogram.dataPoints[0]).toMatchObject({
      count: "3",
      sum: 0.6,
      min: 0.1,
      max: 0.3,
      explicitBounds: [0.25, 0.5],
      bucketCounts: ["1", "2", "0"],
      attributes: [{ key: "http.route", value: { stringValue: "/api/orders" } }],
    });
  });
});

describe("parseDebugText — real-world wrappers", () => {
  it("strips docker-compose prefixes", () => {
    const composed = TRACES.split("\n").map((l) => `otelcol-1  | ${l}`).join("\n");
    const r = parseDebugText(composed);
    expect(r.ok).toBe(true);
    expect(spansOf(r.payload)[0].name).toBe("POST /api/checkout");
  });

  it("unwraps a collector that logs as JSON (text inside msg)", () => {
    const jsonLine = JSON.stringify({ level: "info", ts: 1, msg: TRACES + "\n", "otelcol.component.id": "debug" });
    const r = parseDebugText(jsonLine);
    expect(r.ok).toBe(true);
    expect(r.records).toBe(2);
  });

  it("strips zap fields printed on the same line as the last entry", () => {
    const text = [
      "ResourceLog #0",
      "ScopeLogs #0",
      "LogRecord #0",
      'Body: Str(line one',
      'line two)\t{"otelcol.component.id": "debug", "otelcol.signal": "logs"}',
    ].join("\n");
    const r = parseDebugText(text);
    expect(logsOf(r.payload)[0].body).toEqual({ stringValue: "line one\nline two" });
  });

  it("keeps only the first signal when several are pasted together", () => {
    const r = parseDebugText(LOGS + "\n" + TRACES);
    expect(r.signal).toBe("logs");
    expect(r.records).toBe(2);
    expect(r.warnings.some((w) => /also contained traces/.test(w))).toBe(true);
  });

  it("ignores summary lines and records before the first root", () => {
    const text = '2026-09-21T12:53:21.000Z\tinfo\tLogs\t{"resource logs": 1, "log records": 2}\n' + LOGS;
    expect(parseDebugText(text).records).toBe(2);
  });

  it("creates a scope implicitly when a record appears without one", () => {
    const r = parseDebugText("ResourceLog #0\nLogRecord #0\nBody: Str(x)");
    expect(logsOf(r.payload)[0].body).toEqual({ stringValue: "x" });
  });
});

describe("parseDebugText — edge cases", () => {
  const spanWith = (...fields: string[]) =>
    parseDebugText(["ResourceSpans #0", "ScopeSpans #0", "Span #0", ...fields].join("\n"));

  it("keeps a status message even when the code is Unset", () => {
    const r = spanWith("    Status code    : Unset", "    Status message : partial");
    expect(spansOf(r.payload)[0].status).toEqual({ message: "partial" });
  });

  it("maps an unknown span kind to Unspecified", () => {
    expect(spansOf(spanWith("    Kind           : Weird").payload)[0].kind).toBe(0);
  });

  it("records non-zero dropped counts on spans and events", () => {
    const r = spanWith(
      "    DroppedEventsCount: 3",
      "    DroppedLinksCount: 4",
      "Events:",
      "SpanEvent #0",
      "     -> Name: e",
      "     -> DroppedAttributesCount: 5",
      "     -> Timestamp: 1970-01-01 00:00:00 +0000 UTC"
    );
    const span = spansOf(r.payload)[0];
    expect(span).toMatchObject({ droppedEventsCount: 3, droppedLinksCount: 4 });
    expect(span.events[0]).toEqual({ name: "e", droppedAttributesCount: 5 });
  });

  it("ignores events, attributes and datapoint attributes that have no owner", () => {
    const r = parseDebugText(
      ["ResourceSpans #0", "ScopeSpans #0", "SpanEvent #0", "Attributes:", "     -> k: Str(v)", "Span #0", "    Name           : ok"].join("\n")
    );
    expect(spansOf(r.payload)).toEqual([{ name: "ok" }]);
    const m = parseDebugText(["ResourceMetrics #0", "ScopeMetrics #0", "Data point attributes:", "     -> k: Str(v)"].join("\n"));
    expect(m.ok).toBe(false);
  });

  it("reads a scope with a version but no name", () => {
    const r = parseDebugText("ResourceLog #0\nScopeLogs #0\nInstrumentationScope  1.0\nLogRecord #0\nBody: Str(x)");
    expect((r.payload as any).resourceLogs[0].scopeLogs[0].scope).toEqual({ version: "1.0" });
  });

  it("reads a scope schema URL", () => {
    const r = parseDebugText("ResourceLog #0\nScopeLogs #0\nScopeLogs SchemaURL: https://x/1.0\nLogRecord #0\nBody: Str(x)");
    expect((r.payload as any).resourceLogs[0].scopeLogs[0].schemaUrl).toBe("https://x/1.0");
  });

  it("skips non-finite metric values and ignores sum-only fields on a gauge", () => {
    const r = parseDebugText(
      [
        "ResourceMetrics #0", "ScopeMetrics #0", "Metric #0", "Descriptor:",
        "     -> Name: g", "     -> DataType: Gauge",
        "     -> IsMonotonic: true", "     -> AggregationTemporality: Sideways",
        "NumberDataPoints #0", "Value: +Inf",
        "NumberDataPoints #1", "Value: -3",
      ].join("\n")
    );
    const g = metricsOf(r.payload)[0].gauge;
    expect(g.isMonotonic).toBeUndefined();
    expect(g.aggregationTemporality).toBeUndefined();
    expect(g.dataPoints).toEqual([{}, { asInt: "-3" }]);
  });

  it("defaults an unknown temporality to Unspecified", () => {
    const r = parseDebugText(
      ["ResourceMetrics #0", "ScopeMetrics #0", "Metric #0", "Descriptor:", "     -> Name: s",
        "     -> DataType: Sum", "     -> AggregationTemporality: Sideways", "NumberDataPoints #0", "Value: 1"].join("\n")
    );
    expect(metricsOf(r.payload)[0].sum.aggregationTemporality).toBe(0);
  });

  it("skips datapoints that appear before a DataType is known", () => {
    const r = parseDebugText(
      ["ResourceMetrics #0", "ScopeMetrics #0", "Metric #0", "NumberDataPoints #0", "Value: 1"].join("\n")
    );
    expect(r.ok).toBe(false);
  });

  it("reads metric metadata as attributes", () => {
    const r = parseDebugText(
      ["ResourceMetrics #0", "ScopeMetrics #0", "Metric #0", "Descriptor:", "     -> Name: m",
        "     -> DataType: Gauge", "     -> Metadata:", "          -> owner: Str(team-a)",
        "NumberDataPoints #0", "Value: 1"].join("\n")
    );
    expect(metricsOf(r.payload)[0].metadata).toEqual([{ key: "owner", value: { stringValue: "team-a" } }]);
  });

  it("reads an event name and an EventName on logs", () => {
    const r = parseDebugText("ResourceLog #0\nScopeLogs #0\nLogRecord #0\nEventName: user.login\nBody: Str(x)");
    expect(logsOf(r.payload)[0].eventName).toBe("user.login");
  });
});

describe("parseDebugText — failures and hints", () => {
  it("explains basic/normal verbosity output", () => {
    const basic = '2026-09-21T12:53:21.000Z\tinfo\tLogs\t{"otelcol.component.id": "debug", "resource logs": 1, "log records": 1}';
    const r = parseDebugText(basic);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/verbosity: detailed/);
  });

  it("explains when nothing recognisable is present", () => {
    expect(parseDebugText("hello").error).toMatch(/ResourceLog #0/);
  });

  it("fails when headers exist but no records", () => {
    const r = parseDebugText("ResourceSpans #0\nResource SchemaURL: \nScopeSpans #0");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no complete records/);
  });

  it("warns about timestamps it cannot read", () => {
    const r = parseDebugText("ResourceLog #0\nScopeLogs #0\nLogRecord #0\nTimestamp: sometime\nBody: Str(x)");
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => /could not be read/.test(w))).toBe(true);
  });

  it("drops metrics whose descriptor never named a supported type", () => {
    const r = parseDebugText("ResourceMetrics #0\nScopeMetrics #0\nMetric #0\nDescriptor:\n     -> Name: x\n     -> DataType: Empty");
    expect(r.ok).toBe(false);
    expect(r.warnings.some((w) => /Empty metric/.test(w))).toBe(true);
  });

  it("recognises debug output by its root markers", () => {
    expect(looksLikeDebugOutput(TRACES)).toBe(true);
    expect(looksLikeDebugOutput('{"resourceLogs": []}')).toBe(false);
  });
});
