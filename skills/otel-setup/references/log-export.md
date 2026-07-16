# Log Export Reference

Traces and spans are handled by the OTel SDK/agent, but logs require separate
configuration in most languages. This reference covers two paths per language:
OTel log bridge (preferred) and log shipper fallback.

## Path 1: OTel log bridge

Bridges the app's logging framework to OTLP. Preserves trace-log correlation.

### Java / Kotlin

The OTel Java agent auto-bridges logback and log4j2 — no code changes needed
if you're using the agent approach.

If using SDK without agent, add the log appender:
- Logback: `io.opentelemetry.instrumentation:opentelemetry-logback-appender-1.0`
- Log4j2: `io.opentelemetry.instrumentation:opentelemetry-log4j-appender-2.17`

### Python

Install: `pip install opentelemetry-instrumentation-logging`

For structlog: add an OTel processor that injects trace context and exports
log records via the OTel SDK's LoggerProvider.

For stdlib logging: the instrumentation package hooks into the logging module
and exports records via OTLP.

### JavaScript / TypeScript

Per-framework transport:
- Winston: `@opentelemetry/instrumentation-winston`
- Pino: `pino-opentelemetry-transport` (configure as a pino transport)
- Bunyan: `@opentelemetry/instrumentation-bunyan`

Not automatic — must be added explicitly per logging framework.

### C# / .NET

Add: `OpenTelemetry.Exporter.OpenTelemetryProtocol.Logs`

Hooks into the `ILogger` / `ILoggerFactory` pipeline. Register the OTLP
exporter in the logging builder:
    builder.Logging.AddOpenTelemetry(o => o.AddOtlpExporter());

### Ruby

`opentelemetry-logs-sdk` exists but is experimental. Check current status
before recommending. If unstable, use Path 2.

### PHP

No stable OTel log bridge. Use Path 2.

### Go

`go.opentelemetry.io/otel/log` is experimental. The `slog` handler for OTel
(`go.opentelemetry.io/contrib/bridges/otelslog`) may be available. Check
current status. If unstable, use Path 2.

### Rust

If using the `tracing` crate for both logs and spans, `tracing-opentelemetry`
exports everything as spans and span events. Log events emitted via
`tracing::info!()` etc. are included. This covers most Rust projects.

If using the `log` crate separately, `tracing-log` bridges log records into
the tracing subscriber, which then exports via OTel.

## Path 2 requires JSON logs

Path 2 has two required halves, and the app's log **format** is the first. Collectors
and shippers forward stdout **verbatim** — they add no structure. So a plaintext line

    2026-07-16 08:20:11 INFO OrderController : order 12345 placed by user 987, total=42.50

arrives in Fixter as one opaque `message` string: no queryable `level`, no fields,
timestamp defaulted to ingest time. Collection "working" (logs flowing) is not the
goal — queryable logs are. **Make the app emit structured JSON to stdout before wiring
any shipper.** This is not a later improvement; without it the collected logs are
near-useless for search, alerting, and trace correlation.

(This section is Path 2 only. Path 1 — the OTel log bridge — emits structured records
itself, so the app's console format is irrelevant there. Do not tell a Path 1 project
to change its log format.)

**How Fixter reads a JSON log line:** ingestion parses the JSON body into fields — it
takes `message` or `msg` as the log text and explodes the remaining keys into queryable
attributes. Put IDs/values as top-level keys (not baked into the message string), and
include `trace_id` / `span_id` when you have tracing so logs correlate with spans. Keep
logging to stdout; change only the format:

| Stack | JSON logging |
|---|---|
| Java / Spring Boot 3.4+ | `logging.structured.format.console=ecs` (no dependency); older: `logstash-logback-encoder` |
| Python | `python-json-logger`, or structlog with `JSONRenderer` |
| Node / TS | pino (JSON by default), or winston `format.json()` |
| Go | `slog` with `JSONHandler` (or zerolog / zap) |
| C# / .NET | Serilog `CompactJsonFormatter` |
| Ruby | ougai, or lograge with JSON |
| PHP | Monolog `JsonFormatter` |

Confirm with `kubectl logs <pod>` — one JSON object per line — **before** wiring the
shipper below. In the shipper, parse the JSON so `level`/`timestamp` map correctly
(e.g. the OTel Collector's `json_parser` operator, or Fluent Bit's `json` parser); even
without that, Fixter's ingestion still parses the JSON body into fields.

## Path 2: Log shipper

Configure an existing log collector to forward to Fixter's OTLP endpoint.

### Fluentd

Add an OTLP output plugin:
    <match **>
      @type opentelemetry
      endpoint https://ingest.fixter.dev/v1/logs
      <headers>
        Authorization Bearer ${FIXTER_API_KEY}
      </headers>
    </match>

### Fluent Bit

    [OUTPUT]
        Name              opentelemetry
        Match             *
        Host              ingest.fixter.dev
        Port              443
        Tls               On
        Header            Authorization Bearer ${FIXTER_API_KEY}
        Logs_uri          /v1/logs

### Vector

    [sinks.fixter]
    type = "opentelemetry"
    inputs = ["your_source"]
    endpoint = "https://ingest.fixter.dev"
    [sinks.fixter.headers]
    Authorization = "Bearer ${FIXTER_API_KEY}"

### Logstash

    output {
      http {
        url => "https://ingest.fixter.dev/v1/logs"
        http_method => "post"
        content_type => "application/x-protobuf"
        headers => { "Authorization" => "Bearer ${FIXTER_API_KEY}" }
      }
    }

### Kubernetes (stdout collection)

**First confirm the app logs JSON to stdout** ("Path 2 requires JSON logs" above) —
tailing plaintext pods just ships opaque blobs. Then:

Most k8s clusters run Fluent Bit or Fluentd as a DaemonSet collecting stdout
from containers. Add a Fixter output to the existing DaemonSet config using
the Fluent Bit or Fluentd snippets above.

If using an OTel Collector as the log shipper, add an OTLP exporter:
    exporters:
      otlphttp/fixter:
        endpoint: https://ingest.fixter.dev
        headers:
          Authorization: "Bearer ${FIXTER_API_KEY}"
    service:
      pipelines:
        logs:
          receivers: [filelog]
          exporters: [otlphttp/fixter]
