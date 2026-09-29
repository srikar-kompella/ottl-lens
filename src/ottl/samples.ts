/**
 * Realistic sample payloads for the dry-run panel.
 *
 * The point is that a first-time user never faces an empty box or a toy record.
 * Each sample is shaped around a transform people actually write: parsing a JSON
 * log body, redacting PII, dropping health checks, tagging errored spans, and
 * renaming or filtering metrics. Attribute names follow current OpenTelemetry
 * semantic conventions. All values are fake (example.com, test card 4242).
 */

export type Signal = "logs" | "traces" | "metrics";

export interface Sample {
  id: string;
  label: string;
  signal: Signal;
  /** One line on what this sample is good for. */
  hint: string;
  payload: unknown;
}

const T0 = "1790000000000000000"; // 2026-09-21T12:53:20Z
const T1 = "1790000000250000000"; // +250 ms

type Attr = { key: string; value: Record<string, unknown> };
const str = (key: string, v: string): Attr => ({ key, value: { stringValue: v } });
const int = (key: string, v: number): Attr => ({ key, value: { intValue: String(v) } });

const K8S_RESOURCE = {
  attributes: [
    str("service.name", "checkout"),
    str("service.version", "2.14.0"),
    str("deployment.environment.name", "production"),
    str("k8s.namespace.name", "shop"),
    str("k8s.pod.name", "checkout-7d9f8c6b5-x2kqp"),
    str("k8s.container.name", "checkout"),
  ],
};

const logs = (records: unknown[], resource: unknown = K8S_RESOURCE) => ({
  resourceLogs: [{ resource, scopeLogs: [{ scope: { name: "app" }, logRecords: records }] }],
});

const spans = (items: unknown[]) => ({
  resourceSpans: [{
    resource: K8S_RESOURCE,
    scopeSpans: [{ scope: { name: "io.opentelemetry.http" }, spans: items }],
  }],
});

const metrics = (items: unknown[]) => ({
  resourceMetrics: [{
    resource: K8S_RESOURCE,
    scopeMetrics: [{ scope: { name: "io.opentelemetry.http" }, metrics: items }],
  }],
});

export const SAMPLES: readonly Sample[] = [
  /* ------------------------------ logs ------------------------------ */
  {
    id: "logs-simple",
    label: "Simple log record",
    signal: "logs",
    hint: "Minimal record with two attributes. Good for trying set / keep_keys.",
    payload: logs(
      [{
        timeUnixNano: T0,
        severityNumber: 9,
        severityText: "INFO",
        body: { stringValue: "Hello world" },
        attributes: [str("environment", "staging"), str("http.method", "GET")],
      }],
      { attributes: [str("service.name", "my-service")] }
    ),
  },
  {
    id: "logs-json-body-pii",
    label: "App log with JSON body + PII (k8s)",
    signal: "logs",
    hint: "Structured body as a string. Try ParseJSON, then redacting user_email / card_last4.",
    payload: logs([{
      timeUnixNano: T0,
      observedTimeUnixNano: T0,
      severityNumber: 17,
      severityText: "ERROR",
      body: {
        stringValue:
          '{"level":"error","msg":"payment declined","user_email":"jane.doe@example.com","card_last4":"4242","order_id":"ord_8812","latency_ms":412}',
      },
      attributes: [str("log.file.path", "/var/log/pods/shop_checkout/checkout/0.log"), str("log.iostream", "stdout")],
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
    }]),
  },
  {
    id: "logs-healthcheck",
    label: "Health-check access logs (noise)",
    signal: "logs",
    hint: "Two records, one of them a /healthz probe. Good for filtering with where clauses.",
    payload: logs([
      {
        timeUnixNano: T0,
        severityNumber: 9,
        severityText: "INFO",
        body: { stringValue: "GET /healthz 200 1ms" },
        attributes: [str("http.request.method", "GET"), str("http.route", "/healthz"), int("http.response.status_code", 200)],
      },
      {
        timeUnixNano: T1,
        severityNumber: 9,
        severityText: "INFO",
        body: { stringValue: "POST /api/orders 201 38ms" },
        attributes: [str("http.request.method", "POST"), str("http.route", "/api/orders"), int("http.response.status_code", 201)],
      },
    ]),
  },

  /* ----------------------------- traces ----------------------------- */
  {
    id: "traces-simple",
    label: "Simple span",
    signal: "traces",
    hint: "Minimal internal span. Good for trying span.name / attribute edits.",
    payload: {
      resourceSpans: [{
        resource: { attributes: [str("service.name", "my-service")] },
        scopeSpans: [{
          scope: {},
          spans: [{
            traceId: "00000000000000000000000000000001",
            spanId: "0000000000000001",
            name: "my-operation",
            kind: 1,
            startTimeUnixNano: T0,
            endTimeUnixNano: T1,
            attributes: [str("http.method", "GET"), int("http.status_code", 200)],
          }],
        }],
      }],
    },
  },
  {
    id: "traces-http-error",
    label: "HTTP server span, 500 + exception event",
    signal: "traces",
    hint: "Errored server span with an exception event. Try tagging errors or dropping user.email.",
    payload: spans([{
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      name: "POST /api/checkout",
      kind: 2,
      startTimeUnixNano: T0,
      endTimeUnixNano: T1,
      attributes: [
        str("http.request.method", "POST"),
        str("url.path", "/api/checkout"),
        str("http.route", "/api/checkout"),
        int("http.response.status_code", 500),
        str("server.address", "shop.example.com"),
        str("user.email", "jane.doe@example.com"),
      ],
      events: [{
        timeUnixNano: T1,
        name: "exception",
        attributes: [
          str("exception.type", "PaymentGatewayTimeout"),
          str("exception.message", "upstream gateway did not respond within 200ms"),
        ],
      }],
      status: { code: 2, message: "payment gateway timeout" },
    }]),
  },
  {
    id: "traces-db-client",
    label: "Database client span with PII in SQL",
    signal: "traces",
    hint: "db.query.text contains an email literal. Good for replace_pattern redaction.",
    payload: spans([{
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "b7ad6b7169203331",
      parentSpanId: "00f067aa0ba902b7",
      name: "SELECT shop.users",
      kind: 3,
      startTimeUnixNano: T0,
      endTimeUnixNano: T1,
      attributes: [
        str("db.system.name", "postgresql"),
        str("db.namespace", "shop"),
        str("db.query.text", "SELECT id, name FROM users WHERE email = 'jane.doe@example.com'"),
        str("server.address", "db.internal.example.com"),
        int("server.port", 5432),
      ],
    }]),
  },

  /* ----------------------------- metrics ---------------------------- */
  {
    id: "metrics-gauge",
    label: "Gauge",
    signal: "metrics",
    hint: "One gauge datapoint. Good for renaming metrics or editing datapoint attributes.",
    payload: {
      resourceMetrics: [{
        resource: { attributes: [str("service.name", "my-service")] },
        scopeMetrics: [{
          scope: {},
          metrics: [{
            name: "http.request.duration",
            unit: "ms",
            gauge: { dataPoints: [{ timeUnixNano: T0, asDouble: 42.5, attributes: [str("http.method", "GET")] }] },
          }],
        }],
      }],
    },
  },
  {
    id: "metrics-counter",
    label: "Monotonic counter (sum)",
    signal: "metrics",
    hint: "Cumulative request counter with a high-cardinality attribute (url.path). Try deleting it.",
    payload: metrics([{
      name: "http.server.requests",
      unit: "{request}",
      sum: {
        aggregationTemporality: 2,
        isMonotonic: true,
        dataPoints: [
          {
            startTimeUnixNano: T0, timeUnixNano: T1, asInt: "1532",
            attributes: [str("http.request.method", "GET"), int("http.response.status_code", 200), str("url.path", "/api/orders/ord_8812")],
          },
          {
            startTimeUnixNano: T0, timeUnixNano: T1, asInt: "17",
            attributes: [str("http.request.method", "POST"), int("http.response.status_code", 500), str("url.path", "/api/checkout")],
          },
        ],
      },
    }]),
  },
  {
    id: "metrics-histogram",
    label: "Latency histogram",
    signal: "metrics",
    hint: "Explicit-bucket histogram. Good for metric context and unit handling.",
    payload: metrics([{
      name: "http.server.request.duration",
      unit: "s",
      histogram: {
        aggregationTemporality: 2,
        dataPoints: [{
          startTimeUnixNano: T0,
          timeUnixNano: T1,
          count: "120",
          sum: 18.4,
          min: 0.004,
          max: 2.1,
          explicitBounds: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
          bucketCounts: ["3", "9", "21", "30", "28", "17", "7", "3", "2", "0"],
          attributes: [str("http.request.method", "GET"), str("http.route", "/api/orders")],
        }],
      },
    }]),
  },
];

/** The sample the panel loads for a signal before the user picks anything. */
export function defaultSampleFor(signal: string): Sample {
  return SAMPLES.find((s) => s.signal === signal) ?? SAMPLES[0];
}

export function sampleById(id: string): Sample | undefined {
  return SAMPLES.find((s) => s.id === id);
}

export function samplePayloadText(sample: Sample): string {
  return JSON.stringify(sample.payload, null, 2);
}
