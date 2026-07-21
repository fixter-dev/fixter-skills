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
`tracing::info!()` etc. are included. This covers most Rust projects. Note:
these arrive as **span events**, not log records — logs-table queries won't see
them (query spans instead). If log records are required, emit JSON to stdout
via `tracing-subscriber` and use Path 2.

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

**The field-name contract — get this right or the JSON is levelless.** The collector's
`json_parser` reads severity from a top-level **`level`** key and correlation from
top-level **`trace_id`** / **`span_id`**, and parses every other top-level key into a
queryable log attribute; Fixter ingestion reads **`message`** or **`msg`** as the log
text. Parsing happens on the collection path only — Fixter ingestion stores an unparsed
string body verbatim, so a JSON line that reaches it unparsed is one opaque message with
no queryable fields. The names are exact: a formatter that emits `log.level`,
`levelname`, `@l`, or dotted `trace.id` produces a
valid JSON line that still arrives with **no severity and no trace correlation** — and it
looks fine in `kubectl logs`, so this fails silently. Emit `level` / `trace_id` /
`span_id` with those literal names, as top-level keys (not baked into the message string).

| Stack | JSON that emits `level` (avoid the levelless default) |
|---|---|
| Java / Spring Boot 3.4+ | `logging.structured.format.console=logstash` (no dependency; emits flat `level`). **Not `ecs`** — ECS emits `log.level` / `trace.id`, which the collector's `level` / `trace_id` lookup misses. Pre-3.4: `logstash-logback-encoder`. |
| Python | structlog with `add_log_level` + `JSONRenderer` (emits `level`). `python-json-logger` emits `levelname` — pass `rename_fields={"levelname": "level"}`. |
| Node / TS | pino (emits `level`, JSON by default; numeric levels are mapped) or winston `format.json()`. |
| Go | `slog` `JSONHandler`, zerolog, or zap — all emit `level`. |
| C# / .NET | Serilog emitting `level` (e.g. an `ExpressionTemplate` with a `level` property). The default `CompactJsonFormatter` emits `@l` (and omits it for Information) — remap it. |
| Ruby / PHP | ougai / Monolog `JsonFormatter` — confirm the level key is `level` (Monolog emits `level_name`; remap). |
| Rust | `tracing-subscriber`'s JSON formatter (`.json()`) emits top-level `level` by default — add `.flatten_event(true)` so `message` (an event field) is top-level too; nested `fields.message` misses the `message`/`msg` contract. |

Confirm with `kubectl logs <pod>` — one JSON object per line — **before** wiring the
shipper below. In the shipper, parsing the JSON is **required**, not an optimization
(the OTel Collector's `json_parser` operator, Fluent Bit's `json` parser, Fluentd's
`parser` filter, Vector's `parse_json`): fields must arrive as parsed log attributes,
because Fixter ingestion does not parse string bodies — an unparsed JSON line arrives
as one opaque message.

## Stack traces must ride inside the JSON

Path 2 only (the app formats its own JSON). Path 1 bridges capture the exception
object themselves and emit it as the OTel semantic-convention attributes
`exception.type` / `exception.message` / `exception.stacktrace` — the
forward-compatible shape future exception tooling will key on. Do not tell a
Path 1 project to change any of this. One k8s caveat: a cluster running the
Fixter collector chart tails **every** pod's stdout, Path 1 apps included — a
console layout that prints multiline stacks ships shredded, severity-less
duplicate records alongside the bridged ones. On chart clusters, keep even a
Path 1 app's console output single-line.

Two failure modes make exceptions un-debuggable after collection, and both look
fine in local dev:

1. **The trace never gets logged.** `log.error(e.getMessage())` /
   `logger.error(str(e))` / `console.error(err.message)` discard the stack and the
   cause chain. Log the exception **object** and let the JSON encoder serialize it.
2. **The trace escapes the JSON.** A half-configured layout appends the raw
   multiline stack *after* the JSON line, so every `at ...` frame arrives as its
   own severity-less log record and the cause chain is shredded across records.
   The stack must ride inside the record as a `\n`-escaped field — one JSON line
   per record, exceptions included.

**Emit a documented field, at full fidelity, in the runtime's default order.**
Stack traces are machine-read downstream — grouping, dedup, root-cause
extraction — so the rules mirror the level contract above:

- **Field:** emit `exception.type` / `exception.message` / `exception.stacktrace`
  where the encoder makes that cheap — in Path 2 JSON that means three literal
  dotted top-level keys (`"exception.stacktrace": "..."`), stored verbatim as
  those attribute names and converging with Path 1. (The level contract's
  warning about dotted `trace.id` concerns the collector's severity/trace
  lookup, not these keys.) Otherwise use the encoder's standard field from the
  table below. Do not invent custom field names or custom printer formats — a
  trace in an undocumented field or shape is a one-off nothing downstream will
  look for.
- **Full fidelity:** ship the whole trace. No depth caps, no common-frame
  trimming, no frame-exclude patterns, no shortened class names on the shipped
  record — whatever the encoder cuts can never be restored, and trimmed traces
  fingerprint differently per call path and per service. Shaping is for human
  consoles; the shipped record is for machines. A full trace is typically a few
  KB — cheap next to an undebuggable error. (The JVM's own `... N more`
  common-frame elision is lossless and expected — it is not the trimming banned
  here.)
- **Default order:** keep the runtime's native frame order (JVM root cause last,
  Python root cause first, …). Do not flip it with options like Spring's
  `stacktrace.root=first` or logstash-encoder's `rootCauseFirst` — per-app
  reordering means a stored trace no longer says which end holds the root cause.
  Fixter's diagnose flow already documents each runtime's default order.
- **Type and message as separate fields** wherever the encoder supports it —
  grouping needs the exception type isolated from the message text. Where a
  stock format embeds them instead, they sit at the documented positions the
  table notes (first line on JVM / V8 / .NET, last line in Python) — a recorded
  limitation, not an accident.

| Stack | Config and what it emits |
|---|---|
| Java / Spring Boot 3.4+ | `logging.structured.format.console=logstash` emits `stack_trace` (full trace, JVM default order) when the exception object is passed to the logger — add one line, `logging.structured.json.rename.stack_trace=exception.stacktrace`, to land it under the semconv name. Type and message stay embedded in the trace's first line; the `ecs` format would separate them (`error.type` / `error.message` / `error.stack_trace`) but remains excluded until the collector is configured for its nested `log.level` (see the level table). Leave the 3.5+ `logging.structured.json.stacktrace.*` shaping knobs unset for shipped logs. |
| Java pre-3.4 (logstash-logback-encoder) | Emits `stack_trace` by default, full trace — config-only upgrade to the full triple: `<fieldNames><stackTrace>exception.stacktrace</stackTrace></fieldNames>`, plus the bundled `ThrowableClassNameJsonProvider` (`fieldName` `exception.type`, `useSimpleClassName=false`) and `ThrowableMessageJsonProvider` (`fieldName` `exception.message`) as `<provider>` entries. Skip `ShortenedThrowableConverter` on shipped output — its trimming and class-name shortening are console shaping. |
| Python | structlog: `format_exc_info` in the processor chain emits an `exception` string (standard traceback — root cause first, type and message on the **last** line); trigger with `logger.exception(...)` / `exc_info=True`. python-json-logger: emits `exc_info` (string) when `exc_info` is passed — on v3+, add `rename_fields={"exc_info": "exception.stacktrace"}` to land it under the semconv name (v3 only: v2's rename pass raises `KeyError` on records without the field). |
| Node / TS | pino: log the Error under the `err` key — `logger.error({ err }, "msg")` — emits `err.type` / `err.message` / `err.stack` (type separated); on pino >= 8.4, `pino({ errorKey: 'exception' })` lands them as `exception.type` / `exception.message` / `exception.stack`, one key short of the semconv triple. winston: `format.errors({ stack: true, cause: true })` **before** `format.json()` emits a top-level `stack` string (`cause: true` needs logform >= 2.5.0 — check the lockfile); winston emits no type field — name the error class in the message. |
| Go | Go errors carry no stack of their own. zerolog with `zerolog.ErrorStackMarshaler = pkgerrors.MarshalStack` and `.Stack().Err(err)` emits a `stack` frame array (rename once at init: `zerolog.ErrorStackFieldName = "exception.stacktrace"`) — **only for `pkg/errors`-created errors**; stdlib `errors.New` / `fmt.Errorf` errors emit no stack at all. zap's automatic `stacktrace` field is the **logging call site's** stack, not the error's origin — never treat it as the exception stack. slog: no stack support; the error field is the message only. For stdlib-error Go apps, message-only **is** the achievable end state — record it and move on; if origin stacks matter, adopt stack-capturing error wrapping at error-creation sites. |
| C# / .NET | In the same `ExpressionTemplate` that fixes the level key (level table above), emit the full triple with built-ins: `'exception.type': TypeOf(@x), 'exception.message': Inspect(@x).Message, 'exception.stacktrace': @x`. (Plain `@x.Message` does NOT work — `@x` is a scalar; rendered alone it is the full `ToString()`: outermost type first, inner exceptions chained via `--->` innermost-last, innermost stack frames printed first.) Pass the exception as the **first** argument: `Log.Error(ex, "template")`; `Log.Error(ex.Message)` silently loses it. |
| Ruby / PHP | Prefer SemanticLogger: its JSON output already separates `exception` = `{name, message, stack_trace}` and recurses the `cause` chain — zero config. ougai: pass the exception object — `logger.error("msg", ex)` — emits `err` = `{name, message, stack}` (rename the key via `logger.exc_key`; raise `formatter.trace_max_lines` above its 100-line default), but ougai never serializes `ex.cause` — log the root cause explicitly when unwrapping. Monolog: `$formatter->includeStacktraces(true)` + `['exception' => $e]` context emits a nested `context.exception` object (`class` / `message` / `trace`, causes nested under `previous`) — not top-level, frames are `file:line` only, and no built-in option can hoist or rename it. |
| Rust | tracing: `error!(error = ?err, ...)` records the anyhow/eyre cause chain (no type field). Configure `.json().flatten_event(true)` so `error` — and `message` itself — land top-level instead of nested under `fields`; then never name an event field `level` / `timestamp` / `target` (collision behavior is undefined). Frames exist only if captured: set `RUST_BACKTRACE=1` (anyhow's `backtrace` feature on pre-1.65 toolchains) and record it in a field named `backtrace`. |

This table is the documented set. Today every field — table rows included — is
stored as a plain attribute and read by the diagnose agent from the full record;
future automatic grouping will key on this bounded set, converging on the
`exception.*` triple. An undocumented field is a one-off nothing will key on.

Verify like the level contract, but throw a **nested** test exception (wrap a
cause): `kubectl logs <pod>` (or `docker logs` / the log file off k8s) must show
**one** JSON line for the record, no raw frame lines after it, the stack field
present, and the wrapped cause visible inside it — several encoders drop cause
chains silently (winston without `cause: true`). Exception: ougai never
serializes causes — verify its stack field only.

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

**Prefer the Fixter collector chart** (otel-setup SKILL.md, option B) over a generic
shipper on k8s: it parses JSON pod logs into severity + trace correlation (and glog into
severity) with no config, and auto-routes common database logs (ClickHouse, Doris,
Postgres, MySQL, Kafka) via `builtinFormats` when their container/pod names match. It
still forwards arbitrary **text** app logs severity-less — which is why your own apps
must emit JSON, using the exact `level`/`trace_id`/`span_id` field names above.

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
