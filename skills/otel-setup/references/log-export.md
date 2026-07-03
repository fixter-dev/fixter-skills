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
