---
name: otel-setup
description: Use when a project needs OpenTelemetry instrumentation for Fixter, when verifying an existing OTel setup points to Fixter, or when adding LLM observability. Triggers on "add observability", "set up tracing", "instrument", "connect to Fixter", "OpenTelemetry", "OTLP".
---

# OpenTelemetry Setup for Fixter

Add or verify OpenTelemetry instrumentation so traces, logs, and metrics flow to Fixter.

## Flow

### 1. Detect project stack

Scan for build files:
- `pom.xml` / `build.gradle(.kts)` → Java/Kotlin
- `package.json` → JavaScript/TypeScript
- `requirements.txt` / `pyproject.toml` → Python
- `composer.json` → PHP
- `go.mod` → Go
- `Cargo.toml` → Rust
- `Gemfile` → Ruby
- `*.csproj` / `*.sln` → C#/.NET

Check for existing OTel: dependencies, agent jars, `OTEL_EXPORTER_*` env vars, collector
configs. Also check for existing observability (Datadog `dd-trace-*`, New Relic
`newrelic-*`, Dynatrace, Elastic APM).

### 2. If OTel already present

Verify config points to Fixter:
- Endpoint is `https://ingest.fixter.dev` (or a collector that forwards there)
- Auth header configured
- Resource attributes set: `service.name`, `deployment.environment`, `service.version`
- Log export configured (check step 4 below)

Fix misconfigurations. Skip to step 5 (LLM observability).

### 3. Add OTel (traces + spans)

Read `references/otel-versions.md` for the correct packages and version constraints for
the detected runtime. Use versions logical to the project — do not give a Java 8 project
the latest agent that requires Java 11.

### 4. Configure log export

Read `references/log-export.md`. Logs require separate configuration from traces.

Check for existing log shippers (`fluent.conf`, `fluent-bit.conf`, `vector.toml`,
`logstash.conf`, `filebeat.yml`).

**Prefer OTel log bridge** (Path 1) when the language supports it. **Fall back to log
shipper** (Path 2) when no stable bridge exists or the project already uses a shipper.

### 5. Detect infrastructure + configure export

Detect infra:
- `Chart.yaml` / `kustomization.yaml` / k8s manifests → Kubernetes
- `docker-compose.yml` → Docker Compose
- `serverless.yml` / SAM template / CDK → Serverless
- `fly.toml` / `Procfile` / `railway.json` → Managed platform
- None → bare metal / VM / local dev

**A. Direct export (non-k8s default):**

    OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.fixter.dev
    OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer ${FIXTER_API_KEY}
    OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
    OTEL_SERVICE_NAME=<service-name>
    OTEL_RESOURCE_ATTRIBUTES=deployment.environment=<env>,service.version=<ver>

**B. OTel Collector (recommended for k8s):** apps send to `http://localhost:4318`,
collector forwards to Fixter. Provide minimal collector config, DaemonSet guidance,
and app-side env vars.

**C. OTel Collector for Docker Compose:** add collector service, apps point by name.

**Resource attributes to configure:**

| Attribute | Required | Why |
|---|---|---|
| `service.name` | Yes | Primary grouping key |
| `deployment.environment` | Yes | Filter by environment |
| `service.version` | Yes | Correlate deploys with errors |
| `service.namespace` | If multi-service | Group related services |
| `service.instance.id` | Recommended | Distinguish instances |

**Dual-export:** if existing observability detected, ask the user: add Fixter alongside
(recommended) or replace? Configure multi-export if alongside.

**Credentials:** the API key must NEVER appear in conversation context or committed files.

Check whether the `get_ingestion_credentials` tool is available (it lives on the
Fixter MCP gateway).

**If available** → call `get_ingestion_credentials` (accepts an optional `keyTitle`
string to label the key). Returns endpoint + protocol + `credentialsUrl` (one-time,
24-hour expiry). The credentials URL returns JSON: `{"apiKey": "..."}`.

Automate the key retrieval. First, ensure `.env` is gitignored so the key can never
be committed accidentally:

```bash
grep -qxF '.env' .gitignore 2>/dev/null || echo '.env' >> .gitignore
```

Then run a single bash command that curls the URL, extracts the key, and appends it
to `.env` — without ever printing the key to stdout or storing it in a variable that
would appear in conversation context:

```bash
curl -sf <credentialsUrl> | python3 -c "import sys,json; print('FIXTER_API_KEY=' + json.load(sys.stdin)['apiKey'])" >> .env
```

After running, confirm `.env` contains the `FIXTER_API_KEY=` line (check existence, do
NOT read or print the value). If the curl fails (token already redeemed or expired),
tell the user and offer to provision a new key.

**If not available** → the Fixter MCP is not connected. Tell the user:

> I can't automatically provision an API key because the Fixter MCP server isn't
> connected. You can either:
>
> 1. **Add the Fixter MCP** (recommended) — run `/mcp add fixter` and set the URL to
>    `https://mcp.fixter.dev/mcp` (type: `streamable-http`). After authenticating,
>    re-run this skill and I'll provision the key automatically.
>
> 2. **Create a key manually** — go to app.fixter.dev → Settings → API Keys →
>    Generate Key, then set it as `FIXTER_API_KEY` in your environment.

Wait for the user to complete one of these before continuing. Do not proceed with
placeholder credentials.

All config references `${FIXTER_API_KEY}`.

**Sampling:** if >1000 req/s, recommend head-based sampling
(`OTEL_TRACES_SAMPLER=parentbased_traceidratio`, `OTEL_TRACES_SAMPLER_ARG=0.1`).
Do not sample logs — address log volume via log level config instead.

### 6. LLM observability

Scan for LLM client libraries (`openai`, `anthropic`, `langchain`, `litellm`,
`@anthropic-ai/sdk`, `@anthropic-ai/claude-agent-sdk`, `google-generativeai`,
`cohere`, `mistralai`).

Choose the instrumentation library based on the detected SDK:

- **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) → use **OpenInference**
  (`@arizeai/openinference-instrumentation-claude-agent-sdk`). OpenLLMetry does not
  support the Agent SDK. OpenInference emits AGENT + TOOL spans per `query()` call.
- **Other LLM SDKs** (`openai`, `anthropic`, `langchain`, `litellm`, etc.) → default
  to **OpenLLMetry** (`traceloop-sdk`). Research current coverage at runtime
  (WebSearch the package registry / changelog) before recommending. Only suggest
  OpenInference if OpenLLMetry has an actual gap for the user's provider.

### 7. Verify the full pipeline

If Fixter MCP connected, verify each signal:
- **Spans:** `query_sql` → `SELECT count() AS value FROM spans WHERE service = '<svc>'`
- **Logs:** `search_logs` → `service=<svc>`
- **Correlation:** check `trace_id` populated in returned logs
- **Attributes:** verify `service.name`, `deployment.environment`, `service.version`

If any signal missing, diagnose: spans missing = SDK/agent issue; logs missing = log
export (step 4) not configured; correlation missing = log bridge not active.

If no MCP: provide a manual verification checklist for the Fixter dashboard.

### 8. Save onboarding state

Write `.fixter/onboarding-state.json` (add `.fixter/` to `.gitignore`):

    {
      "otelSetup": {
        "completed": true,
        "language": "<detected>",
        "framework": "<detected>",
        "exportStrategy": "direct|collector",
        "logExportPath": "otel-bridge|shipper|none",
        "serviceName": "<configured>",
        "existingObservability": ["<if any>"],
        "dualExport": false,
        "timestamp": "<ISO>"
      }
    }
