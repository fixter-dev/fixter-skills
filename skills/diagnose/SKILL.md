---
name: diagnose
description: Use when querying telemetry to investigate an issue or find root cause — searching logs, explaining an error or latency spike, or tracing a failure across logs, spans, and metrics. Requires the Fixter MCP. Triggers on "query logs", "search logs", "why is X failing", "root cause", "investigate", "debug production", "what happened", "error spike", "latency spike", "slow requests".
---

# Diagnose with Fixter

Structured, read-only investigation of Fixter telemetry: query the relevant signal — logs, spans,
or metrics — to find the symptom, then (optionally) correlate across them to find root cause. All
tools are read-only.

**Prerequisites:** Fixter MCP connected, telemetry flowing.

## Flow

### 0. Verify MCP connectivity

Call `list_services`.

- **MCP not configured:** walk the user through setup:

      claude mcp add --transport http fixter https://mcp.fixter.dev/mcp

  Then restart Claude Code and authenticate via `/mcp` — a browser opens; sign in with the
  same credentials as the Fixter dashboard (fixter.dev).
- **No services returned:** telemetry isn't flowing. Point the user at the `fixter:otel-setup` skill and
  stop — there is nothing to query.

### 1. Route to the right entry point

Do NOT default to logs. Logs, spans, and metrics are peer query surfaces — pick the entry from the
evidence and the signal (step 1a):

| The user has… | Start at |
|---|---|
| a **trace id** | `correlate` (Phase B, step 5) |
| an **error / log-text symptom** | `logs` (Phase A, step 3) |
| a **latency symptom** ("slow", "timing out") | `aggregate_spans` / `spans` (Phase A, step 3) |
| a **health / RED question** for a service or operation | `aggregate_spans` (Phase A, step 3) |
| a **"why didn't X happen"** — no response, missing side effect, silent/absent output | `aggregate_spans` on the component that *should* have acted — ask "did it run, and how did it end?", NOT `logs` (Phase A, step 3) |
| a **metric / error-rate spike**, or a specific metric | `list_metrics` → `metrics` (Phase A, step 3) |
| a **symptom you can't place**, or nothing specific | `logs`, and widen from there (Phase A, step 3) |

Whatever the entry, first establish scope (step 1a).

### 1a. Scope the investigation

Establish these before querying:

- **Signal:** errors / latency / specific behavior / unknown.
- **Service — infer first, don't ask by default.** In order, stopping at the first hit:
  1. `.fixter/onboarding-state.json` → `otelSetup.serviceName` (this project's own service).
  2. Project config: `OTEL_SERVICE_NAME`, or `service.name` in `OTEL_RESOURCE_ATTRIBUTES`
     (`.env`, `docker-compose*.yml`, k8s manifests, otel config).
  3. `list_services` — if it returns exactly one service, use it; if a name inferred in (1)/(2)
     matches one it lists, use that.

  Only `AskUserQuestion` when it's genuinely ambiguous (several services, none matching) — and
  present the inferred candidate as the default. When inference is confident, state the choice in
  one line ("Investigating `<svc>` — from your project config; tell me if you mean another") and
  proceed. Don't block on a question you can answer from the project.
- **Environment — the safety gate. Infer first:** read `deployment.environment` from
  `.fixter/onboarding-state.json` or `OTEL_RESOURCE_ATTRIBUTES` — this usually resolves scope with
  no schema call. Only if project context is silent, resolve via the tenant (the convention varies
  and may not be in telemetry at all) to one of three outcomes:
  1. **Env attribute present** — probe `describe_schema` for `deployment.environment`, `env`,
     `environment`, or similar. If found, require it as a filter and **confirm the value with the
     user.** Attribute filters are `run_sql`-only (the `logs`/`spans` tools can't filter on them).
  2. **Env in service names** (e.g. `checkout-prod` vs `checkout-staging`) — scope by `service`.
  3. **Env not distinguishable in telemetry** — say so plainly. Do NOT imply a scoping that isn't
     real. Ask the user which services map to which environment and scope by `service`.

  **Never silently query prod** — state the inferred (or chosen) environment before querying so the
  user can correct it. Inferring from the project's own config is a visible basis, not a guess.
- **Time window:** always bounded — open windows are unbounded scans. Default to the last 1h;
  confirm or adjust with the user. Build the `from`/`to` ISO instants from the current system
  clock; in `run_sql`, prefer a relative bound like `timestamp > now() - 3600` (seconds).

### 2. Discover schema — only when you need it

Skip this for a plain `logs`/`spans`/`metrics` query; those use fixed fields and need no probe.
Reach for it only when building a `run_sql` query, or resolving an env attribute you couldn't get
from project context (step 1a):

- `describe_schema` (source `logs`, `spans`, or `metrics`) — returns the tenant's actual fields
  and dynamic/resource attributes (flattened dot-keys, e.g. `service.version`, `host.name`) plus
  the available QuerySQL functions. This is `describe_schema`, NOT `describe_telemetry_schema`
  (that one is for alert rules).
- `list_metrics` before any `metrics` call — `metrics` needs an exact `metricName`.
- To focus the search, reuse `.fixter/onboarding-state.json` `confirmedFlows` / `errorPatterns`
  from a prior logging review (already read for scope in step 1a).

### 3. Phase A — Query the relevant signal(s)

Logs, spans, and metrics are peer query surfaces — query whichever the signal points to (you may
need more than one). For each: cheap tool first, `describe_schema` before any `run_sql`, always
scoped and bounded (step 1a).

**Logs** — errors, messages, anything textual:

1. `logs` — indexed filters only: `service`, `level`, `messageContains` (whole-word token, case
   sensitive — for case-insensitive or substring matches use `run_sql` `matches()`), `traceId`,
   plus a bounded `from`/`to`. Caps at 100 results (max 1000; page with `next_cursor`) and exposes
   NO attribute filtering. `level` is a single value — `level="ERROR"` excludes `FATAL`; for both,
   use `run_sql` with `level IN ('ERROR', 'FATAL')`.
2. `run_sql` — for a substring match (`matches('text')`, case-insensitive), a regex
   (`regexp_extract`), aggregation, OR any attribute filter (env keys, `http_method`, resource
   attrs — all `run_sql`-only). Bound the range (e.g. `timestamp > now() - 3600`). If the env gate
   resolved to an attribute filter, log queries start here, not at `logs`.
3. `get_log_neighbors` (by `logId`, a log record's id from the `logs` results) — what happened
   right before/after a key line; `sameSource` defaults true (same pod), set false for cross-pod.

**Spans** — latency, errors by operation, "where is it bad?":

1. `aggregate_spans` — RED metrics (request count, error rate, throughput, latency
   p50/p90/p95/p99) to find **where** errors/latency concentrate. Cheap over wide windows (reads a
   rollup). Add `parent_operation` to `groupBy` to catch "bad only under one caller" — keep it
   scoped (tight `from`/`to` + `service`/`name`). Filters only on `service`/`name`: if the env gate
   resolved to an attribute (outcome 1), scope via `run_sql` on `spans` instead, or split by
   service and confirm the environment per service before trusting the numbers.
2. `spans` — raw drill-down once you have a hot (service, operation): `statusCode="ERROR"`, or
   `minDurationMs` for slow spans, `name=` for one operation.
3. `run_sql` on `spans` — attribute filters, regex, or aggregation the tools can't express.

**Metrics** — saturation, throughput, counters over time:

1. `list_metrics` (optionally `service=…`) to find the exact `metricName`.
2. `metrics` — the series over a bounded window, optional `step`/`groupBy`. Mind the metric type:
   GAUGE → avg/min/max; SUM → delta+rate; HISTOGRAM → percentiles. `metrics` filters/`groupBy` see
   only data-point attributes, NOT resource attributes like `service` — it cannot scope a shared
   metric to one service or environment.
3. `run_sql` on `metrics` — when you must scope by `service` (which `run_sql` exposes) or need raw
   per-point values.

Carry forward: the matched logs/spans/metrics, the pattern, and candidate `trace_id`s for
correlation. See `references/query-cookbook.md` for recipes.

### 4. Triage fork

- User only wanted the data → summarize findings and stop.
- User wants "why" / root cause → confirm, then continue to Phase B.

### 5. Phase B — Correlate across signals (root cause)

You have a lead from Phase A (a `trace_id`, a hot operation, a metric spike). Tie the signals
together into one causal story.

1. Pick exemplar trace(s): a `trace_id` from a log line, an errored/slow span (`spans` with
   `statusCode="ERROR"` or `minDurationMs`), or a metric exemplar.
2. `correlate` (by `traceId`) — one-shot spans + logs + metric exemplars for that trace. The
   primary cross-signal pivot. Use `get_trace` instead only when you need the span tree alone.
3. Confirm it's representative, not a one-off: re-run the relevant Phase-A query around the incident
   window (e.g. `aggregate_spans` error rate for the operation, or a saturation `metric`) so the
   single trace's story holds at the population level.

### 6. Synthesize and deliver

Present in chat:

- **Timeline:** first error → propagation → root span.
- **Evidence:** trace ids, span names, metric deltas, representative log lines.
- **Root-cause hypothesis** with an explicit **confidence** level.
- **Remediation** suggestions.
- If evidence is thin, say what further query would confirm it — do not fabricate a cause.

Then **offer** (don't auto-write) to save a structured RCA to
`.fixter/investigations/YYYY-MM-DD-<topic>.md`. Before writing the first one, ensure
`.fixter/investigations/` is gitignored in the user's project (RCA files quote real log/trace
contents that may include PII or secrets). Template sections: Summary, Scope (service/env/window),
Timeline, Evidence, Root cause, Confidence, Remediation.

## Guardrails

- **Read-only:** every tool queries, never mutates — but still scope every query to the confirmed
  environment.
- **Environment safety:** never conflate environments or query the wrong one; confirm before
  touching prod.
- **Cost discipline:** bounded time windows always; `logs` before `run_sql`; `aggregate_spans`
  before raw `spans`; `describe_schema` / `list_metrics` before `run_sql` / `metrics`.
- **Evidence-only:** claim only what the data shows; state confidence; say what further query would
  confirm a thin hypothesis rather than inventing one.
- **Absence ≠ proof.** A zero-row result only proves something didn't happen if that component
  emits that signal there. Subprocess / agent / worker services often emit **spans but few or no
  logs** — an empty `logs` query for one is the *wrong signal*, not evidence it never ran. Before
  concluding "X never happened," check the peer signal (`aggregate_spans` / `spans` for the
  service) and, if unsure what a service emits, `describe_schema` (lists services with per-signal
  volumes). Relatedly, a specific id you're handed (thread / request / order) is a search **seed,
  not a fence**: pivot to the entity (user, customer, resource) and search correlated records —
  retries, mirrors, and re-homed ids mean the downstream work may not carry the id you started with.
- **Sensitive data:** logs and traces may contain PII, credentials, or secrets. Be mindful when
  quoting them in chat and the RCA file; don't echo obvious secrets/tokens verbatim.
