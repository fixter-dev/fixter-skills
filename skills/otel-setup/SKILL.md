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
- Auth header configured — this only proves the header *exists*, not that the key behind
  it is valid. A configured `${FIXTER_API_KEY}` holding a revoked, stale, placeholder, or
  wrong-tenant value passes this check and still 401s at ingest. Key validity is proven
  only by telemetry actually arriving (step 7), never by inspecting the key's shape.
- Resource attributes set: `service.name`, `deployment.environment`, `service.version`
- Log export configured (check step 4 below)

Fix misconfigurations, then go to step 6 (LLM observability) and step 7 (verify). Do
**not** treat an already-present setup as done just because the config reads correctly —
that is exactly where a stale or wrong-tenant key hides. If step 7 shows nothing
arriving, follow its auth-failure branch (re-provision, don't chase the SDK).

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

**A. Direct export — the default for everything non-k8s** (serverless, managed platform,
bare metal / VM, local dev — every infra above except Kubernetes and Docker Compose). The
app's SDK sends OTLP straight to Fixter:

    OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.fixter.dev
    OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer ${FIXTER_API_KEY}
    OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
    OTEL_SERVICE_NAME=<service-name>
    OTEL_RESOURCE_ATTRIBUTES=deployment.environment=<env>,service.version=<ver>

This ships the app's **own** signals — traces, metrics, and (with a log bridge, step 4)
logs. It does NOT collect **host metrics** (the VM's CPU/mem/disk) or **system logs the
app doesn't emit itself** (journald, other processes' files): unlike the k8s collector
chart, direct export runs no host-level agent. A single host that also needs those
requires a collector running on the host — this default does not set one up, so call it
out rather than letting the user assume host telemetry is covered.

**B. OTel Collector (recommended for k8s):** install the published Fixter collector
chart — do NOT hand-roll a collector config or DaemonSet. The chart ships pod-log
collection, kubelet/host metrics, and an OTLP relay for your apps, all tested and
released.

**Preflight:** run `helm version` and `kubectl config current-context` — confirm helm
is installed and you are pointed at the intended cluster before installing anything.

**Install order matters** — but first confirm an imperative install is even the right
mechanism here (see *"is Helm already managed?"* just below; on a GitOps/IaC-managed
cluster you add the collector there instead). When it is, the chart reads its API key
from a Secret in its own namespace, so the namespace and Secret must exist *before* the
install:

1. Create the namespace: `kubectl create namespace fixter`.
2. Create the `fixter-credentials` Secret **in `-n fixter`** — use the Kubernetes
   Secret destination in the Credentials subsection below, and create it before step 3.
3. Install the chart, pointing it at that Secret:

       helm install fixter-collector \
         oci://ghcr.io/fixter-dev/charts/fixter-collector \
         --namespace fixter \
         --set fixter.existingSecret=fixter-credentials \
         --set fixter.clusterName=<cluster>   # set this when you run >1 cluster

Use `--set fixter.existingSecret=...`, **not** `--set fixter.apiKey=<key>`: a key on
the command line lands in shell history and the pod's process list, and there is no
way to fill that placeholder that's consistent with the single-use credential
redemption below.

**Before installing: is Helm already managed here?** The imperative `helm install` above
is right ONLY when nothing else owns Helm releases on this cluster. Two systems make it
wrong — an imperative release then drifts or gets reverted — and neither is fully visible
from the app repo:

- **In-cluster CD (Flux / ArgoCD)** — probe the live cluster:
  `kubectl get crd | grep -Eq 'fluxcd|argoproj' && echo GITOPS`  (or `kubectl get helmreleases,applications -A`).
- **Client-side IaC (Terraform `helm_release`, Pulumi, helmfile)** — invisible to that
  probe: it tracks releases in state (CI/a laptop), not the cluster. Scan the repo for
  `*.tf` with a `helm_release` / a `helm` provider, or `helmfile.yaml`.

The infra config usually lives in a **separate repo**, so a clean app repo plus an empty
probe still proves nothing. If both come back empty, **ask the user how Helm releases are
managed on this cluster before you install** — don't assume imperative. If any system
manages them, add the collector to *that* system (Flux `HelmRelease`, ArgoCD
`Application`, Terraform `helm_release`, helmfile entry) with the same
`fixter.existingSecret` / `fixter.clusterName` values, referencing the
`fixter-credentials` Secret, committed to its repo (ask where it is if not this one). Run
the imperative `helm install` only once you've confirmed nothing manages releases.

Then point apps at the agent's Service DNS (the relay is on by default) — NOT
`localhost:4318`; the agent has no hostPort:

    OTEL_EXPORTER_OTLP_ENDPOINT=http://fixter-collector-agent.fixter.svc.cluster.local:4318
    OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
    OTEL_SERVICE_NAME=<service-name>

These are **container env vars** — set them in each workload's Deployment/StatefulSet
`spec.template.spec.containers[].env` (or your app Helm chart's values) and redeploy.
They are not shell exports; a pod won't pick them up otherwise.

Installing the chart alone already gets pod logs + k8s metrics into Fixter with zero
app changes; the env vars above add your app's own traces/logs on top. If you'd
rather not run a collector, direct export (option A) works from k8s too — the app
sends straight to `https://ingest.fixter.dev`.

The collector also fills a missing `service.name` on pod telemetry from the k8s
deployment name, so pod logs appear under that name (see step 7).

**What the collector parses by default:** JSON pod logs get severity **and**
`trace_id`/`span_id` correlation automatically (see the field-name contract in
log-export.md); glog (klog) logs get severity but no trace correlation. Common database
logs (ClickHouse, Doris, Postgres, MySQL, Kafka) are auto-routed by the chart's
`builtinFormats` — but the routing keys on the **container/pod name** (e.g. a container
named `clickhouse`, a pod `doris-fe-*`), so a differently-named deployment (Bitnami's
`postgresql` container, a Doris cluster whose FE pods aren't `doris-fe-*`) is NOT matched.
Verify against `kubectl logs`; if a DB's levels are missing, add an `agent.logs.formats`
entry pointing the matching preset at that workload's pod paths. Everything else is
arbitrary **text**, which the collector deliberately does NOT guess a severity for — so
your own apps should emit **JSON** (step 4), not a plaintext layout.

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
# Drop any existing key line first, so re-provisioning replaces rather than appending a
# duplicate the app might read instead. No-op on first-time setup.
[ -f .env ] && sed -i.bak '/^FIXTER_API_KEY=/d' .env && rm -f .env.bak
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
> (the chart reads its key from a Secret in its own namespace), **after
> `kubectl create namespace fixter` and before `helm install`** — this is step 2 of
> option B's install order. It drops in as
> `--set fixter.existingSecret=fixter-credentials`; the chart's default key is
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
- **Spans:** `run_sql` → `SELECT count() AS value FROM spans WHERE service = '<svc>'`
- **Logs:** `logs` with `service=<svc>` (indexed filter)
- **Correlation:** check `trace_id` populated in returned logs
- **Attributes:** verify `service.name`, `deployment.environment`, `service.version`

If any signal missing, diagnose:
- **nothing at all arriving (spans AND logs both absent)** — suspect the key before the
  SDK. A direct probe of `https://ingest.fixter.dev/v1/traces` returning `401`/`403` (or
  simply nothing landing despite config that points correctly at Fixter) means the key is
  being **rejected** — revoked, never activated, still a placeholder, or from a different
  tenant — **not** that the SDK/agent is broken. On first-time setup a well-formed,
  non-placeholder key already sitting in `.env` is **not** evidence of a valid credential;
  validity is proven only by telemetry landing here. Whenever the Fixter MCP is connected,
  provisioning is automatic — re-provision via the Credentials flow (§5):
  `get_ingestion_credentials` → redeem into the **same** destination, replacing the stale
  value → redeploy → re-verify. Never tell the user "there's no provisioning tool" or send
  them to fixter.dev to make a key by hand while the MCP is connected; the tool is
  `get_ingestion_credentials`.
- **spans missing but logs arriving** = SDK/agent issue (auth is fine — logs got through).
- **logs missing under `<svc>`** — before concluding export is broken, check whether the
  logs arrived under a *different* service. Call `list_services` to see what did arrive,
  then `logs` filtered to that name. Pod logs shipped by the collector are tagged with the
  k8s deployment/container name (not your `OTEL_SERVICE_NAME`), and infra logs can have an
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
