# OpenTelemetry Version Reference

Last verified: 2026-07-03

Before using these versions, verify against the official package registries linked
below. OTel releases frequently; these constraints capture compatibility rules that
change less often than version numbers.

---

## Java / Kotlin

Registry: https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases

| Runtime | OTel Agent | OTel SDK | Notes |
|---|---|---|---|
| Java 8+ | 2.28.1 | 1.62.0 | All published artifacts support Java 8+ |
| Java 11+ | 2.28.1 | 1.62.0 | Full support |
| Java 17+ | 2.28.1 | 1.62.0 | Recommended minimum |

**Approaches:**

1. Java agent (recommended for most apps):
   Add `-javaagent:opentelemetry-javaagent.jar` to JVM args. Auto-instruments
   Spring Boot, JDBC, HTTP clients, gRPC, Kafka, etc. No code changes.

2. Spring Boot starter (for Spring Boot apps wanting programmatic control):
   Add `io.opentelemetry.instrumentation:opentelemetry-spring-boot-starter`
   to dependencies. Version aligns with the agent release (2.28.1).

3. SDK-only (manual instrumentation):
   Add `io.opentelemetry:opentelemetry-sdk:1.62.0` + exporter. Wire manually.

**Minimal env vars (all approaches):**

```
OTEL_EXPORTER_OTLP_ENDPOINT=<endpoint>
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer ${FIXTER_API_KEY}
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_SERVICE_NAME=<service-name>
OTEL_RESOURCE_ATTRIBUTES=deployment.environment=<env>,service.version=<ver>
```

---

## Python

Registry: https://pypi.org/project/opentelemetry-sdk/

| Runtime | OTel SDK | OTel Distro | Notes |
|---|---|---|---|
| Python 3.8-3.9 | not supported | not supported | Dropped; use older SDK versions if stuck |
| Python 3.10+ | 1.43.0 | 0.62b1 | Full support |
| Python 3.12+ | 1.43.0 | 0.62b1 | Recommended minimum |

**Approaches:**

1. Distro + auto-instrumentation (recommended):
   `pip install opentelemetry-distro opentelemetry-exporter-otlp`
   then `opentelemetry-bootstrap -a install` to detect and install
   instrumentation packages for installed libraries (Flask, Django,
   requests, psycopg2, etc.).

2. SDK-only (manual instrumentation):
   `pip install opentelemetry-sdk opentelemetry-exporter-otlp-proto-http`
   Wire `TracerProvider` and `LoggerProvider` manually.

**Minimal env vars (all approaches):**

```
OTEL_EXPORTER_OTLP_ENDPOINT=<endpoint>
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer ${FIXTER_API_KEY}
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_SERVICE_NAME=<service-name>
OTEL_RESOURCE_ATTRIBUTES=deployment.environment=<env>,service.version=<ver>
```

Run with: `opentelemetry-instrument python app.py`

---

## JavaScript / TypeScript

Registry: https://www.npmjs.com/package/@opentelemetry/sdk-node

| Runtime | @opentelemetry/api | @opentelemetry/sdk-node | Notes |
|---|---|---|---|
| Node.js < 18.19 | not supported | not supported | Dropped in SDK 2.0 |
| Node.js ^18.19.0 | 1.9.1 | 0.219.0 | Minimum supported |
| Node.js >= 20.6.0 | 1.9.1 | 0.219.0 | Recommended minimum |

**Approaches:**

1. Auto-instrumentation (recommended):
   `npm install @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node@0.77.0 @opentelemetry/exporter-trace-otlp-proto`
   Create a `tracing.js` init file and `--require` it before the app.

2. SDK-only (manual instrumentation):
   `npm install @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-proto`
   Register individual instrumentations manually.

**Minimal env vars (all approaches):**

```
OTEL_EXPORTER_OTLP_ENDPOINT=<endpoint>
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer ${FIXTER_API_KEY}
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_SERVICE_NAME=<service-name>
OTEL_RESOURCE_ATTRIBUTES=deployment.environment=<env>,service.version=<ver>
```

Run with: `node --require ./tracing.js app.js`

### Edge / isolate runtimes (Cloudflare Workers, Vercel, Deno)

`@opentelemetry/sdk-node` (the Node auto-instrumentation SDK) does NOT run on V8-isolate /
edge runtimes — it needs Node-only APIs (`async_hooks`, `process`, `--require`) and a
long-lived process to flush spans, none of which exist in a request-scoped isolate. But
**each platform has its own OTel path** — use the one below, never `sdk-node`. A
platform-specific in-code SDK (e.g. Vercel's `@vercel/otel`) is fine; a generic Node
auto-SDK is not.

Detect: `wrangler.toml` / `@cloudflare/workers-types` → Cloudflare Workers; `@vercel/otel`,
`vercel.json`, or Next.js deployed on Vercel → Vercel; `deno.json`/`deno.jsonc` or Deno
Deploy → Deno.

#### Cloudflare Workers → native platform export (zero code)

Traces and logs are configured
**separately** — each needs its own `[observability.*]` block AND its own dashboard
destination. One block does not cover both; omit the logs block and logs are silently
dropped.

Cloudflare wants a **full signal-specific URL** per destination (not a base URL). In the
dashboard, create two telemetry destinations, both with header
`Authorization: Bearer <FIXTER_API_KEY>`:

| Destination name | Endpoint URL |
|---|---|
| `fixter-traces` | `https://ingest.fixter.dev/v1/traces` |
| `fixter-logs` | `https://ingest.fixter.dev/v1/logs` |

Then reference each **by name** in `wrangler.toml`:

```toml
[observability.traces]
enabled = true
destinations = ["fixter-traces"]   # the dashboard destination NAME, not a URL
head_sampling_rate = 1              # capture all; lower under high volume (see Sampling in SKILL.md)

[observability.logs]
enabled = true
destinations = ["fixter-logs"]     # captures console.log + system logs
```

- With both blocks, spans and `console.log`/system logs reach Fixter and trace↔log
  correlation works. Metrics are not yet supported.
- `service.name` derives from the Worker script name — **name the Worker after the
  service** so Fixter groups it correctly.
- **The key lives ONLY in the dashboard destination header.** The platform exports the
  telemetry, so the Worker never reads the key — do NOT create a `wrangler secret`, an env
  var, or a `wrangler.toml` entry for it (a `wrangler secret` here would sit unused). For
  the skill's credentials step (§5), the storage destination is **Manual (browser)**:
  reveal the key once and paste it into the `Authorization` header of both destinations.
- Status: beta; billing begins 2026-03-01 ($0.05 / M events beyond 10M/mo included).
- Timing caveat: the runtime fuzzes sub-request timing (Spectre mitigation), so span
  durations are approximate.

#### Vercel (Node + Edge) → `@vercel/otel`

Vercel's supported path is the in-code `@vercel/otel` package (NOT `sdk-node`):

```
npm i @opentelemetry/api @vercel/otel
```

Create `instrumentation.ts` in the project root (or `src/` on Next.js):

```ts
import { registerOTel } from '@vercel/otel'

export function register() {
  registerOTel({ serviceName: '<service-name>' })
}
```

Point it at Fixter with the standard OTLP env vars, set as Vercel **project env vars**
(`@vercel/otel` defers to the OpenTelemetry env-var spec):

```
OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.fixter.dev
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer ${FIXTER_API_KEY}
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
```

- Exports **traces (+ metrics), NOT logs.**
- **Traces, zero-code alternative:** a Vercel **Trace Drain** emits OpenTelemetry-format
  traces — point one at `https://ingest.fixter.dev/v1/traces` instead of (or alongside)
  `@vercel/otel`.
- **Logs are a separate, non-trivial problem.** `@vercel/otel` does not ship logs, and
  Vercel **Log Drains deliver Vercel's own `log` v1 JSON, NOT OTLP** — so a drain cannot be
  pointed straight at Fixter's OTLP `/v1/logs`. Route the Log Drain through an OTel
  Collector (or similar) that converts it to OTLP, or treat Vercel logs as a known gap.
  (Drains require a Vercel Pro/Enterprise plan.)
- **Edge runtime:** auto-instrumentation works, but **custom spans are not supported on
  the Edge runtime** (Vercel limitation) — add manual spans only in Node functions.
- `service.name` comes from `registerOTel({ serviceName })`.
- The app reads the key here (unlike Cloudflare's native export) — store `FIXTER_API_KEY`
  as a Vercel env var / secret.

#### Deno / Deno Deploy → native runtime OTel (zero code)

Deno ships built-in OpenTelemetry (stable) — no install. Enable it and point at Fixter
via env vars:

```
OTEL_DENO=true
OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.fixter.dev
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer ${FIXTER_API_KEY}
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_SERVICE_NAME=<service-name>
```

- Exports **traces, metrics, AND logs** in one shot — `console.*` calls become OTLP log
  records automatically, so trace↔log correlation works with no extra config.
- Defaults if unset: protocol `http/protobuf`, endpoint `http://localhost:4318`.

---

## PHP

Registry: https://packagist.org/packages/open-telemetry/sdk

| Runtime | OTel SDK | OTel API | Notes |
|---|---|---|---|
| PHP < 8.1 | not supported | not supported | Requires PHP 8.1+ |
| PHP 8.1+ | 1.14.0 | 1.14.0 | Full support |
| PHP 8.3+ | 1.14.0 | 1.14.0 | Recommended minimum |

**Approaches:**

1. Auto-instrumentation via PECL extension (recommended):
   Install the `opentelemetry` PECL extension, then
   `composer require open-telemetry/sdk open-telemetry/exporter-otlp`
   plus instrumentation packages for your framework (Laravel, Symfony, etc.).

2. SDK-only (manual instrumentation):
   `composer require open-telemetry/sdk open-telemetry/exporter-otlp`
   Wire `TracerProvider` and `LoggerProvider` manually.

**Minimal env vars (all approaches):**

```
OTEL_EXPORTER_OTLP_ENDPOINT=<endpoint>
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer ${FIXTER_API_KEY}
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_SERVICE_NAME=<service-name>
OTEL_RESOURCE_ATTRIBUTES=deployment.environment=<env>,service.version=<ver>
OTEL_PHP_AUTOLOAD_ENABLED=true
```

---

## Go

Registry: https://pkg.go.dev/go.opentelemetry.io/otel

| Runtime | OTel API/SDK | OTel Contrib | Notes |
|---|---|---|---|
| Go < 1.22 | not supported | not supported | Follows Go's two-release support policy |
| Go 1.22+ | v1.43.0 | latest | Full support |
| Go 1.23+ | v1.43.0 | latest | Recommended minimum |

**Approaches:**

Go has no auto-instrumentation agent. Instrumentation is always via SDK +
contrib middleware/interceptors.

1. SDK + contrib middleware (standard approach):
   ```
   go get go.opentelemetry.io/otel@v1.43.0
   go get go.opentelemetry.io/otel/sdk@v1.43.0
   go get go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp
   ```
   Add contrib middleware for your framework:
   `go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp` for net/http,
   `go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc` for gRPC,
   `go.opentelemetry.io/contrib/instrumentation/github.com/gin-gonic/gin/otelgin` for Gin.

**Minimal env vars:**

```
OTEL_EXPORTER_OTLP_ENDPOINT=<endpoint>
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer ${FIXTER_API_KEY}
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_SERVICE_NAME=<service-name>
OTEL_RESOURCE_ATTRIBUTES=deployment.environment=<env>,service.version=<ver>
```

---

## Rust

Registry: https://crates.io/crates/opentelemetry

| Runtime | opentelemetry | opentelemetry_sdk | Notes |
|---|---|---|---|
| Rust < 1.75.0 | not supported | not supported | MSRV is 1.75.0 |
| Rust 1.75.0+ | 0.32.0 | 0.32.0 | Full support |
| Rust stable (latest) | 0.32.0 | 0.32.0 | Recommended |

**Approaches:**

Rust has no auto-instrumentation agent. Instrumentation is via SDK + the
`tracing` ecosystem.

1. SDK + tracing-opentelemetry (standard approach):
   ```toml
   [dependencies]
   opentelemetry = "0.32"
   opentelemetry_sdk = { version = "0.32", features = ["rt-tokio"] }
   opentelemetry-otlp = { version = "0.32", features = ["http-proto"] }
   tracing = "0.1"
   tracing-opentelemetry = "0.33"
   ```

2. SDK-only (without tracing integration):
   Use `opentelemetry` + `opentelemetry_sdk` + `opentelemetry-otlp` directly
   without the `tracing` bridge.

**Minimal env vars:**

```
OTEL_EXPORTER_OTLP_ENDPOINT=<endpoint>
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer ${FIXTER_API_KEY}
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_SERVICE_NAME=<service-name>
OTEL_RESOURCE_ATTRIBUTES=deployment.environment=<env>,service.version=<ver>
```

---

## Ruby

Registry: https://rubygems.org/gems/opentelemetry-sdk

| Runtime | OTel SDK | Exporter OTLP | Notes |
|---|---|---|---|
| Ruby < 3.1 | not supported | not supported | Requires CRuby >= 3.1 |
| CRuby 3.1+ | 1.11.0 | 0.34.0 | Full support |
| JRuby 9.3.2+ | 1.11.0 | 0.34.0 | Full support |
| TruffleRuby 22.1+ | 1.11.0 | 0.34.0 | Full support |

**Approaches:**

1. SDK + auto-instrumentation (recommended):
   ```ruby
   gem 'opentelemetry-sdk', '~> 1.11'
   gem 'opentelemetry-exporter-otlp', '~> 0.34'
   gem 'opentelemetry-instrumentation-all', '~> 0.69'
   ```
   Call `OpenTelemetry::SDK.configure` with `use_all()` to auto-detect
   installed libraries (Rails, Sinatra, Rack, Faraday, pg, etc.).

2. SDK-only (manual instrumentation):
   Install `opentelemetry-sdk` + `opentelemetry-exporter-otlp` and register
   individual instrumentations.

**Minimal env vars:**

```
OTEL_EXPORTER_OTLP_ENDPOINT=<endpoint>
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer ${FIXTER_API_KEY}
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_SERVICE_NAME=<service-name>
OTEL_RESOURCE_ATTRIBUTES=deployment.environment=<env>,service.version=<ver>
```

---

## C# / .NET

Registry: https://www.nuget.org/packages/OpenTelemetry

| Runtime | OpenTelemetry SDK | Notes |
|---|---|---|
| .NET Framework 4.6.2+ | 1.16.0 | Via .NET Standard 2.0 target |
| .NET 6.0 | 1.16.0 | Supported via netstandard2.0 |
| .NET 8.0+ | 1.16.0 | Recommended minimum; native net8.0 target |

**Approaches:**

1. ASP.NET Core auto-instrumentation (recommended for web apps):
   ```
   dotnet add package OpenTelemetry.Extensions.Hosting --version 1.16.0
   dotnet add package OpenTelemetry.Instrumentation.AspNetCore --version 1.16.0
   dotnet add package OpenTelemetry.Exporter.OpenTelemetryProtocol --version 1.16.0
   ```
   Wire in `Program.cs` via `builder.Services.AddOpenTelemetry()`.

2. Console / worker service:
   ```
   dotnet add package OpenTelemetry --version 1.16.0
   dotnet add package OpenTelemetry.Exporter.OpenTelemetryProtocol --version 1.16.0
   ```
   Build `TracerProvider` and `LoggerProvider` manually.

3. .NET zero-code instrumentation (preview):
   Use the `OpenTelemetry.AutoInstrumentation` NuGet package to instrument
   without code changes via .NET startup hooks.

**Minimal env vars (all approaches):**

```
OTEL_EXPORTER_OTLP_ENDPOINT=<endpoint>
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer ${FIXTER_API_KEY}
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_SERVICE_NAME=<service-name>
OTEL_RESOURCE_ATTRIBUTES=deployment.environment=<env>,service.version=<ver>
```

---

## LLM Observability Libraries

These instrument LLM client calls (model name, token counts, prompts, completions)
as OTel spans. Choose based on which LLM SDK the project uses.

### OpenInference (Arize AI)

| Package | Registry | Version | Instruments |
|---|---|---|---|
| `@arizeai/openinference-instrumentation-claude-agent-sdk` | npm | 0.2.8 | Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) |
| `openinference-instrumentation-openai` | PyPI | 0.1.52 | OpenAI Python SDK |
| `openinference-instrumentation-anthropic` | PyPI | 1.0.6 | Anthropic Python SDK |
| `openinference-instrumentation-langchain` | PyPI | 0.1.67 | LangChain |

**Claude Agent SDK (Node.js):**

```
npm install @arizeai/openinference-instrumentation-claude-agent-sdk@^0.2.8
```

Emits AGENT + TOOL spans per `query()` call. Must be wired after the OTel tracer
provider is registered. See the `manuallyInstrument` export.

**Python (OpenAI / Anthropic / LangChain):**

```
pip install openinference-instrumentation-openai>=0.1.52
pip install openinference-instrumentation-anthropic>=1.0.6
pip install openinference-instrumentation-langchain>=0.1.67
```

### OpenLLMetry (Traceloop)

| Package | Registry | Version | Notes |
|---|---|---|---|
| `@traceloop/node-server-sdk` | npm | 0.27.0 | Node.js — auto-instruments OpenAI, Anthropic, LangChain, etc. |
| `traceloop-sdk` | PyPI | 0.62.1 | Python — auto-instruments OpenAI, Anthropic, LangChain, LiteLLM, etc. |

**Node.js:**

```
npm install @traceloop/node-server-sdk@^0.27.0
```

**Python:**

```
pip install traceloop-sdk>=0.62.1
```

OpenLLMetry auto-detects installed LLM libraries. Does NOT support the Claude
Agent SDK (`@anthropic-ai/claude-agent-sdk`) — use OpenInference for that.
