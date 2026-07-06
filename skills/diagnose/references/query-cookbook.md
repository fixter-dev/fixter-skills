# Diagnose Query Cookbook

Question shape → tool sequence → example. All queries assume scope (service, environment, bounded
time window) is already fixed per SKILL.md step 1a. Prefer the cheap tool; drop to `run_sql` only
when the cheap tool can't express the query.

## Logs

| Question | Sequence |
|---|---|
| Errors in a service, last hour | `logs` with `level="ERROR"`, `service=…`, bounded `from`/`to` (ERROR only — for ERROR+FATAL use `run_sql` with `level IN ('ERROR','FATAL')`) |
| Logs mentioning a whole word (e.g. `timeout`) | `logs` with `messageContains="timeout"` (indexed, case-sensitive; use `matches()` for case-insensitive) |
| Logs containing a **substring** | `describe_schema` → `run_sql` with `matches('…')` (case-insensitive substring, not regex) |
| Logs matching a **regex / pattern** | `run_sql` with `regexp_extract(message, 'pat')` or `message ILIKE '%…%'` |
| Logs for one trace | `logs` with `traceId="…"` (or `correlate`) |
| What happened right before/after a log | `get_log_neighbors` with `logId="…"` |
| Group errors by an attribute | `describe_schema` (find the key) → `run_sql` GROUP BY |

Every example bounds its time range — an unbounded scan is exactly what the skill forbids.
`now() - 3600` = last hour (seconds); swap in explicit ISO instants if you prefer.

Example `run_sql` — error count by 5-min bucket:

    SELECT bucket(timestamp, '5m') AS t, count() AS n
    FROM logs
    WHERE service = 'checkout-api' AND level IN ('ERROR', 'FATAL')
      AND timestamp > now() - 3600
    GROUP BY t ORDER BY t

Example `run_sql` — free-text substring search (scoped + bounded):

    SELECT timestamp, service, message
    FROM logs
    WHERE service = 'checkout-api'
      AND timestamp > now() - 3600
      AND matches('connection refused')
    ORDER BY timestamp DESC LIMIT 100

Example `run_sql` — extract a status code from the message:

    SELECT regexp_extract(message, 'status=(\d+)', 1) AS status, count() AS n
    FROM logs
    WHERE service = 'checkout-api' AND timestamp > now() - 3600
    GROUP BY status ORDER BY n DESC

## Spans / root cause

| Question | Sequence |
|---|---|
| Where are errors/latency concentrated? | `aggregate_spans` (group by service, operation) |
| Is an operation bad only under one caller? | `aggregate_spans` + `parent_operation` in `groupBy` |
| Example errored spans of an operation | `spans` with `statusCode="ERROR"`, `name=…` |
| Slowest spans | `spans` with `minDurationMs=…` |
| Everything about a trace | `correlate` with `traceId="…"` |
| Just the span tree | `get_trace` with `traceId="…"` |

## Metrics

| Question | Sequence |
|---|---|
| What metrics exist? | `list_metrics` (optionally `service=…`) |
| A metric over time | `metrics` with exact `metricName`, bounded window, optional `step`/`groupBy` |
| Is this systemic saturation? | `list_metrics` → `metrics` for CPU/mem/queue-depth over the window (a metric shared across services can't be scoped by `service` in `metrics` — use `run_sql` on `metrics` for that) |

Metric-type output differs: GAUGE → avg/min/max; SUM → delta sum + rate; HISTOGRAM → p50/p90/p95/p99;
SUMMARY → count/sum/avg (no quantiles). Use `run_sql` on `metrics` for raw per-point values.

## QuerySQL quick reference

- Free-text: `matches('text')` (case-insensitive substring across message/attrs/ids/service).
- Time buckets: `bucket(timestamp, '5m')` — intervals `1m,5m,15m,30m,1h,6h,1d`.
- Aggregates: `count()`, `count_distinct(f)`, `countIf(cond)`, `avg/min/max`, `p50/p95/p99(f)`,
  `error_rate()`, `rate(f)`, `regexp_extract(f, 'pat' [, group])`.
- Nested attributes use dot notation with backticks: `` `http.response.status` ``.
- Bound recent windows with `timestamp > now() - <seconds>` (e.g. `- 3600` = last hour).
- Always constrain a time range; always scope by service (and environment, per step 1a).
