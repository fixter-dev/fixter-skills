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

**If you land on Path 2** — a log shipper, OR the Fixter collector / any DaemonSet
tailing pod stdout — **the app must emit structured JSON to stdout first.** Collectors
forward stdout verbatim, so plaintext lines arrive as opaque, un-queryable strings.
"Logs are flowing" is not the goal; queryable logs are — this is a required half of
Path 2, not a follow-up. See log-export.md ("Path 2 requires JSON logs"). Path 1 (the
bridge) structures logs itself and needs no format change.

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

**B. OTel Collector (recommended for k8s):** install the published Fixter collector
chart — do NOT hand-roll a collector config or DaemonSet. The chart ships pod-log
collection, kubelet/host metrics, and an OTLP relay for your apps, all tested and
released.

    helm install fixter-collector \
      oci://ghcr.io/fixter-dev/charts/fixter-collector \
      --namespace fixter --create-namespace \
      --set fixter.apiKey=<key> \
      --set fixter.clusterName=<cluster>   # set this when you run >1 cluster

Then point apps at the agent's Service DNS (the relay is on by default) — NOT
`localhost:4318`; the agent has no hostPort:

    OTEL_EXPORTER_OTLP_ENDPOINT=http://fixter-collector-agent.fixter.svc.cluster.local:4318
    OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
    OTEL_SERVICE_NAME=<service-name>

Installing the chart alone already gets pod logs + k8s metrics into Fixter with zero
app changes; the env vars above add your app's own traces/logs on top. If you'd
rather not run a collector, direct export (option A) works from k8s too — the app
sends straight to `https://ingest.fixter.dev`.

The collector also fills a missing `service.name` on pod telemetry from the k8s
deployment name, so pod logs appear under that name (see step 7).

**C. Docker Compose:** default to direct export — the app sends OTLP straight to
`https://ingest.fixter.dev` (same as option A). A collector is optional here (its real
value is on Kubernetes). If you do want one — e.g. for container-log collection — use
the tested example in the collector repo at `examples/docker-compose/` (compose file +
standalone config + README); apps then point at `http://fixter-collector:4318`.

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

**Credentials:** the API key must NEVER appear in conversation context or committed
files. Never echo, cat, or read a stored key back.

Check whether the `get_ingestion_credentials` tool is available (it lives on the
Fixter MCP gateway).

**If not available** → the Fixter MCP is not connected. Tell the user:

> I can't automatically provision an API key because the Fixter MCP server isn't
> connected. You can either:
>
> 1. **Add the Fixter MCP** (recommended) — run
>    `claude mcp add --transport http fixter https://mcp.fixter.dev/mcp`, then
>    restart Claude Code and authenticate via `/mcp` (browser opens; sign in with
>    your Fixter credentials — same login as fixter.dev). Then re-run this skill
>    and I'll provision the key automatically.
>
> 2. **Create a key manually** — go to fixter.dev → Settings → API Keys →
>    Generate Key, then set it as `FIXTER_API_KEY` in your environment.

Wait for the user to complete one of these before continuing. Do not proceed with
placeholder credentials.

**If available** → let the user choose where the key goes. Each credentials URL is
**single-use**, so the destination must be chosen before redeeming, and each
destination gets its own key (independently revocable — this is a feature, not
overhead).

**1. Build the option list** from the infra detected in this step:

| Option | Offer when | Recommended when |
|---|---|---|
| `.env` file in project root | Always | Local dev / docker-compose |
| GitHub Actions secret | `.github/workflows/` exists and `gh auth status` succeeds | Deploys run through GitHub Actions |
| Kubernetes Secret | k8s manifests/Helm detected and `kubectl` reaches a cluster | App runs on k8s |
| Platform secret store | Matching CLI detected (`fly secrets`, AWS SSM, Vault, ...) | App deploys to that platform |
| Manual (browser) | Always | User prefers to handle secrets themselves |

**2. Ask via `AskUserQuestion`** (multiSelect): "Where should your Fixter API key be
stored?" Put the detected-infra recommendation first. Mention that each selected
destination gets its own key.

**3. Redeem straight into each destination.** For each choice, call
`get_ingestion_credentials` with `keyTitle` set to `<service>-<destination>`
(e.g. `checkout-api-github-actions`). The `credentialsUrl` returns JSON
`{"apiKey": "..."}`. Redeem in ONE command per destination — command substitution
straight into the target, never an intermediate variable, file, or printed value:

`.env` (ensure it's gitignored first):

```bash
grep -qxF '.env' .gitignore 2>/dev/null || echo '.env' >> .gitignore
curl -sf -H 'Accept: application/json' <credentialsUrl> | python3 -c "import sys,json; print('FIXTER_API_KEY=' + json.load(sys.stdin)['apiKey'])" >> .env
```

GitHub Actions secret:

```bash
gh secret set FIXTER_API_KEY --body "$(curl -sf -H 'Accept: application/json' <credentialsUrl> | python3 -c "import sys,json; print(json.load(sys.stdin)['apiKey'])")"
```

Kubernetes Secret:

```bash
kubectl create secret generic fixter-credentials -n <namespace> --from-literal=FIXTER_API_KEY="$(curl -sf -H 'Accept: application/json' <credentialsUrl> | python3 -c "import sys,json; print(json.load(sys.stdin)['apiKey'])")"
```

> If you install the collector chart (option B), create this Secret in **`-n fixter`**
> (the chart reads its key from a Secret in its own namespace) and it drops in as
> `--set fixter.existingSecret=fixter-credentials` — the chart's default key is
> `FIXTER_API_KEY`, so no `existingSecretKey` override is needed.

Other platform stores follow the same pattern (`fly secrets set FIXTER_API_KEY="$(...)"`,
`aws ssm put-parameter --type SecureString --value "$(...)"`, ...).

**Manual:** call the tool, give the user the `credentialsUrl`, and tell them to open
it in a browser — it renders a reveal-and-copy page (single-use, 24-hour expiry).
Wait for them to confirm they've stored the key before continuing.

**4. Verify by existence only** — `grep -c '^FIXTER_API_KEY=' .env`,
`gh secret list`, `kubectl get secret fixter-credentials` — never print the value.
If a redemption curl fails (HTTP 404 = already redeemed or expired), provision a
fresh key and retry.

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

If any signal missing, diagnose:
- **spans missing** = SDK/agent issue.
- **logs missing under `<svc>`** — before concluding export is broken, check whether the
  logs arrived under a *different* service. Query `search_logs` with no service filter
  for the same time window. Pod logs shipped by the collector are tagged with the k8s
  deployment/container name (not your `OTEL_SERVICE_NAME`), and infra logs can have an
  empty service. If nothing arrives under any service, then log export (step 4) isn't
  configured.
- **correlation missing** = log bridge not active.

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
        "credentialDestinations": ["env-file", "github-actions"],
        "existingObservability": ["<if any>"],
        "dualExport": false,
        "timestamp": "<ISO>"
      }
    }
