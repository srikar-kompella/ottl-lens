package internal

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/open-telemetry/opentelemetry-collector-contrib/processor/transformprocessor"
	"go.opentelemetry.io/collector/component"
	"go.opentelemetry.io/collector/component/componenttest"
	"go.opentelemetry.io/collector/confmap"
	"go.opentelemetry.io/collector/consumer"
	"go.opentelemetry.io/collector/pdata/plog"
	"go.opentelemetry.io/collector/pdata/pmetric"
	"go.opentelemetry.io/collector/pdata/ptrace"
	"go.opentelemetry.io/collector/processor"
	"go.uber.org/zap"
)

type evalResult struct {
	OK          bool   `json:"ok"`
	Output      string `json:"output,omitempty"`
	Error       string `json:"error,omitempty"`
	ExecutionMs int64  `json:"executionMs"`
}

var (
	factory      = transformprocessor.NewFactory()
	procSettings processor.Settings
)

func init() {
	ts := componenttest.NewNopTelemetrySettings()
	ts.Logger = zap.NewNop()
	procSettings = processor.Settings{
		ID:                component.MustNewIDWithName("transform", "ottl_vscode"),
		TelemetrySettings: ts,
		BuildInfo:         component.NewDefaultBuildInfo(),
	}
}

// Eval runs OTTL statements against a sample OTLP payload and returns a JSON-encoded evalResult.
func Eval(statements, signal, payloadJSON string) string {
	start := time.Now()
	res := run(statements, signal, payloadJSON)
	res.ExecutionMs = time.Since(start).Milliseconds()
	b, _ := json.Marshal(res)
	return string(b)
}

func run(statements, signal, payloadJSON string) evalResult {
	if strings.TrimSpace(payloadJSON) == "" {
		return evalResult{Error: "payload is empty"}
	}
	cfg, err := parseConfig(statements, signal)
	if err != nil {
		return evalResult{Error: "OTTL parse error: " + err.Error()}
	}
	var out string
	switch signal {
	case "logs":
		out, err = evalLogs(cfg, payloadJSON)
	case "traces":
		out, err = evalTraces(cfg, payloadJSON)
	case "metrics":
		out, err = evalMetrics(cfg, payloadJSON)
	default:
		return evalResult{Error: fmt.Sprintf("unsupported signal %q — use logs, traces, or metrics", signal)}
	}
	if err != nil {
		return evalResult{Error: err.Error()}
	}
	return evalResult{OK: true, Output: out}
}

// buildYAML wraps bare OTTL statements into the transform processor's YAML config format.
// Blank lines and full-line `#` comments are stripped (inline comments are left as-is).
// Single quotes in statements are escaped ('' in YAML).
func buildYAML(statements, signal string) string {
	signalKey := map[string]string{
		"logs":    "log_statements",
		"traces":  "trace_statements",
		"metrics": "metric_statements",
	}[signal]
	if signalKey == "" {
		return ""
	}
	var lines []string
	for _, line := range strings.Split(statements, "\n") {
		line = strings.TrimSpace(line)
		if line != "" && !strings.HasPrefix(line, "#") {
			lines = append(lines, line)
		}
	}
	if len(lines) == 0 {
		return ""
	}
	var sb strings.Builder
	sb.WriteString("transform:\n  ")
	sb.WriteString(signalKey)
	sb.WriteString(":\n    - statements:\n")
	for _, s := range lines {
		sb.WriteString("        - '")
		sb.WriteString(strings.ReplaceAll(s, "'", "''"))
		sb.WriteString("'\n")
	}
	return sb.String()
}

func parseConfig(statements, signal string) (*transformprocessor.Config, error) {
	yaml := buildYAML(statements, signal)
	if yaml == "" {
		return factory.CreateDefaultConfig().(*transformprocessor.Config), nil
	}
	retrieved, err := confmap.NewRetrievedFromYAML([]byte(yaml))
	if err != nil {
		return nil, err
	}
	fullConf, err := retrieved.AsConf()
	if err != nil {
		return nil, err
	}
	// The YAML has "transform:" at root; Sub extracts the inner config map.
	subConf, err := fullConf.Sub("transform")
	if err != nil {
		return nil, err
	}
	cfg := factory.CreateDefaultConfig().(*transformprocessor.Config)
	if err := subConf.Unmarshal(cfg); err != nil {
		return nil, err
	}
	// Validate() catches OTTL syntax errors before the processor runs.
	if v, ok := any(cfg).(interface{ Validate() error }); ok {
		if err := v.Validate(); err != nil {
			return nil, err
		}
	}
	return cfg, nil
}

func evalLogs(cfg *transformprocessor.Config, payloadJSON string) (string, error) {
	input, err := (&plog.JSONUnmarshaler{}).UnmarshalLogs([]byte(payloadJSON))
	if err != nil {
		return "", fmt.Errorf("invalid OTLP logs JSON: %w", err)
	}
	var output plog.Logs
	sink, _ := consumer.NewLogs(func(_ context.Context, ld plog.Logs) error { output = ld; return nil })
	proc, err := factory.CreateLogs(context.Background(), procSettings, cfg, sink)
	if err != nil {
		return "", err
	}
	if err := proc.Start(context.Background(), componenttest.NewNopHost()); err != nil {
		return "", err
	}
	if err := proc.ConsumeLogs(context.Background(), input); err != nil {
		return "", err
	}
	b, err := (&plog.JSONMarshaler{}).MarshalLogs(output)
	return string(b), err
}

func evalTraces(cfg *transformprocessor.Config, payloadJSON string) (string, error) {
	input, err := (&ptrace.JSONUnmarshaler{}).UnmarshalTraces([]byte(payloadJSON))
	if err != nil {
		return "", fmt.Errorf("invalid OTLP traces JSON: %w", err)
	}
	var output ptrace.Traces
	sink, _ := consumer.NewTraces(func(_ context.Context, td ptrace.Traces) error { output = td; return nil })
	proc, err := factory.CreateTraces(context.Background(), procSettings, cfg, sink)
	if err != nil {
		return "", err
	}
	if err := proc.Start(context.Background(), componenttest.NewNopHost()); err != nil {
		return "", err
	}
	if err := proc.ConsumeTraces(context.Background(), input); err != nil {
		return "", err
	}
	b, err := (&ptrace.JSONMarshaler{}).MarshalTraces(output)
	return string(b), err
}

func evalMetrics(cfg *transformprocessor.Config, payloadJSON string) (string, error) {
	input, err := (&pmetric.JSONUnmarshaler{}).UnmarshalMetrics([]byte(payloadJSON))
	if err != nil {
		return "", fmt.Errorf("invalid OTLP metrics JSON: %w", err)
	}
	var output pmetric.Metrics
	sink, _ := consumer.NewMetrics(func(_ context.Context, md pmetric.Metrics) error { output = md; return nil })
	proc, err := factory.CreateMetrics(context.Background(), procSettings, cfg, sink)
	if err != nil {
		return "", err
	}
	if err := proc.Start(context.Background(), componenttest.NewNopHost()); err != nil {
		return "", err
	}
	if err := proc.ConsumeMetrics(context.Background(), input); err != nil {
		return "", err
	}
	b, err := (&pmetric.JSONMarshaler{}).MarshalMetrics(output)
	return string(b), err
}
