---
name: alert-setup
description: Use when setting up Fixter alert rules for a project's business flows, when configuring error rate or latency alerts, or when reviewing system-suggested rules. Requires the Fixter MCP to be connected. Triggers on "set up alerts", "create alert rules", "monitor errors", "alerting", "error rate alert", "latency alert".
---

# Alert Setup for Fixter

Set up alert rules for critical business flows via the Fixter MCP.

**Prerequisites:** Fixter MCP connected, and telemetry that has been flowing long
enough to calibrate against (see step 1 — minutes of data make bad alerts).

## Flow

### 1. Verify MCP connectivity and data maturity

Call `describe_alerting` (no params).

- **MCP not configured:** walk user through setup:

      claude mcp add --transport http fixter https://mcp.fixter.dev/mcp

  Then restart Claude Code and authenticate via `/mcp` — a browser opens; sign in
  with the same credentials as the Fixter dashboard (fixter.dev).

- **No services returned:** telemetry not flowing. Check `.fixter/onboarding-state.json`
  for OTel setup status. Tell user to deploy with OTel enabled, wait 2-3 minutes, retry.

**Then check data maturity — do NOT calibrate against minutes of data.** A thresholds
is only as good as its baseline; a 7-day lookback over 3 minutes of data is garbage.
Presence of a service (above) is not enough — check the data's *age*. Probe with
`run_sql` on the signal your rules will use (`spans`, or `logs` for a logs-only
service):

    SELECT count() AS n FROM spans WHERE timestamp < now() - 86400

- **n = 0 (no data older than 24h):** the tenant is too new to calibrate. Alert setup
  is **optional right now** — tell the user the honest tradeoff (thresholds set today
  will be guesses and likely noisy), and offer two choices via `AskUserQuestion`:
  1. **Defer (recommended)** — come back after ~a week of data for calibrated alerts.
     Write `{"alertSetup": {"deferred": true, "reason": "insufficient-data"}}` to
     `.fixter/onboarding-state.json` and stop here.
  2. **Safety-net only** — create just the rules that need **no** baseline: OOM > 1,
     unhandled-exception count > 3, DB/cache connection failures (the error-count table
     in step 6, not the rate/latency tables). Mark each **uncalibrated** and skip every
     threshold-calibrated flow rule (error-rate %, latency p95) — those require real
     data. Then go to step 4.
- **n > 0 (data spans more than 24h):** proceed to step 2 and calibrate normally. Note:
  ≥ 7 days is ideal; between 24h and 7d, calibrate but tell the user thresholds may need
  to tighten as more data accumulates.

### 2. Discover what's alertable

The `describe_alerting` response from step 1 already has everything — no second call:
- `services` → real service names
- per source (LOGS/SPANS/METRICS): `measures` (each with `fn`, `label`, `unit`, and
  `defaultMode` — THRESHOLD or ANOMALY, the mode a new rule on that measure should
  default to), plus `fields` and `comparators`

### 3. Identify business flows

Check sources in order:
1. `.fixter/onboarding-state.json` → `confirmedFlows` and `errorPatterns` from logging
   review. Ask user to confirm they're still relevant.
2. Same-session context from a prior logging-review run.
3. Fresh discovery: codebase scan + MCP error pattern query, then confirm with user.

### 4. Notification channels

Ask via `AskUserQuestion`: "Where should alert notifications go?"
- Slack (channel name or webhook URL)
- Webhook (endpoint URL)
- Both

Guide user to configure channels in Fixter dashboard (Settings → Notification Channels).
Rules evaluate without channels but won't notify until configured.

### 5. Suggest rules — tiered

**P0 (create now, max 2-3):**
- Service-level error rate
- Most critical flow error rate or burn rate

**P1 (add after P0 stable ~1 week, 2-4 rules):**
- Remaining critical flow error rates
- User-facing endpoint latency
- Specific error types (NPE, OOM, unhandled)

**P2 (optional):**
- Burn rate with SLOs
- Composite group rules
- Non-critical flow monitoring

Tell user: "Live with P0 for a week. If no false positives, add P1."

Draft each candidate as a structured rule spec — steps 6-7 calibrate it against real
data BEFORE anything is shown to the user. A rule's measurement is `source` (LOGS/SPANS/METRICS)
+ optional `filter` + a `measure` (a catalog fn like `p95`, `request_count`, `error_rate`,
`rate`, with optional `arg`/`params`) + optional `groupBy` + `windowMinutes` — not a
hand-written query. Pick the measure from `describe_alerting`'s per-source `measures`
list; its `defaultMode` tells you whether the flow calls for a static tier or an anomaly
condition — error rate and latency on well-understood flows are usually THRESHOLD;
request-count and other volume-shape signals without a natural fixed ceiling are usually
ANOMALY. The condition is tiered: a static condition has a `warning` tier and optional
`critical` tier, each with its own threshold/comparator and a `consecutiveWindows` sustain;
an anomaly condition instead carries a `zScoreThreshold` and `direction`.

If a candidate started life as a raw query (e.g. copied from a diagnose session), pass it
to `preview_alert_rule` as `fromQuerySql` instead of hand-building the spec — it parses
the query into a measurement draft you then refine with the guidance below.

### 6. Ground thresholds in real data

**The default tables below are starting points, never the final answer.** Classify
each flow by code analysis (payment? LLM-backed? CRUD?), pick the matching default,
then calibrate:

1. Run `preview_alert_rule` with the candidate spec, the default threshold, and a
   7-day lookback. The response's `backtest` includes the observed p95 and max per
   series — that is your baseline; there is no excuse to guess when a service reports data.
2. Error rate: 3-5x observed baseline or the table floor, whichever is higher.
   Latency: 2-3x observed p95.
3. Only fall back to raw defaults when the service has no data at all — then mark
   the rule **uncalibrated** in the presentation and tell the user to re-run alert
   setup after a week of data.
4. **Check that duration means processing time.** An operation whose observed p95/max
   dwarfs the service's request latency (hours vs minutes) may be a measurement span
   with a backdated start timestamp — duration anchored to an earlier business event
   (message creation, enqueue time, order placement), not to work done, so it measures
   elapsed business time (time-to-X, queue age, SLA clocks). Verify before excluding:
   pull a few raw
   spans of the operation and check for a child whose start precedes its parent's —
   that is the giveaway. Aggregate stats alone prove nothing (operations legitimately
   differ by orders of magnitude); if raw spans are unavailable, ask the user what the
   span measures instead of asserting a bug. Confirmed measurement spans are excluded
   from latency rules and from any service-wide pooled percentile — a threshold
   derived from 2-3x their p95 is meaningless. Flag the instrumentation to the user
   (it belongs in a histogram metric); if the business duration matters, alert on it
   as a separate explicitly-labeled rule with a threshold from the business
   expectation confirmed with the user, never calibrated from the span's own
   observed percentiles.

**Flow-aware defaults:**

Error rate:

| Flow type | Threshold | Window |
|---|---|---|
| Payment / billing | > 1% | 5 min |
| Auth / login | > 1% | 5 min |
| Standard CRUD | > 5% | 5 min |
| Batch / import | > 10% | 15 min |
| Webhooks / consumers | > 5% | 5 min |

Error count:

| Error type | Threshold | Window |
|---|---|---|
| NPE / ClassCast / TypeError / panic | > 3 | 5 min |
| OOM / resource exhaustion | > 1 | 5 min |
| Unhandled exceptions | > 3 | 5 min |
| Connection failures (DB, cache) | > 5, consecutive 2 | 5 min |

Latency (p95):

| Flow type | Threshold | Window |
|---|---|---|
| Simple CRUD / reads | > 500ms | 5 min |
| Standard writes | > 2s | 5 min |
| LLM-backed requests | > 45s | 5 min |
| External API orchestration | > 10s | 5 min |
| File upload / media | > 30s | 5 min |
| Background / batch | > 60s | 15 min |

Burn rate:

| SLO tier | Budget | Threshold | Window |
|---|---|---|---|
| Critical (payment, auth) | 0.001 (99.9%) | > 6x | 60 min |
| Standard API | 0.005 (99.5%) | > 6x | 60 min |
| Fast-burn | same | > 14x | 5 min |

### 7. Backtest — every rule, no exceptions

Call `preview_alert_rule` for each rule before presenting it. It never throws — the
flow is **preview → fix problems → save**:
- `problems[]` non-empty → fix the spec and preview again before looking at the backtest
- `problems[]` empty → read `backtest`:
  - `totalWouldFire = 0` → likely too strict — compare the threshold to the observed max
  - Fires every window → too noisy: tighten or add `consecutiveWindows`
  - A few fires → well-calibrated; note the fire timestamps so the user can check
    whether they line up with real incidents — for log-based rules, give each fire a
    self-service log link (the rule's filter as the query, window = the fired window,
    built per `../diagnose/references/evidence-links.md`)

Iterate until each rule is right. A rule that was never backtested must not be
presented (except the explicitly-marked uncalibrated ones from step 6).

### 8. Present rules with their gates, then create

Present every rule in this format — never a bare name list:

    <rule name> [P0]
      Measure:   error_rate() on SPANS where service = 'checkout-api'
      Condition: warning > 0.05 for 2 consecutive 5-min windows
      Backtest:  7d — would have fired 3x; observed p95 0.021, max 0.093
      Why:       payment-adjacent flow; threshold = 3x observed baseline
      Evidence:  [view logs](https://app.fixter.dev/logs?…) — for log-based rules, the
                 offending logs in a fired window (built per
                 ../diagnose/references/evidence-links.md); omit when there is no log evidence

The condition line must spell out tier (warning/critical), threshold, comparator,
window length, and consecutive windows — or, for anomaly rules, the z-score threshold
and direction. The backtest line shows the evidence behind the threshold — or says
"uncalibrated (no data yet)".

After user approval, call `save_alert_rule` per rule (omit `ruleId` to create). It
re-validates server-side: if it returns `problems[]` instead of the saved rule, fix
the spec and resave. Confirm with rule IDs and the same gate summaries.

### 8a. Visual elicitation is the exception, not the routine

Three things are easy to conflate — keep them distinct:

- **`preview_alert_rule`** is a *data* call (validate + backtest), not a page. It is the
  **mandatory** gate on every rule and never involves the user visiting anything. Always run it.
- **Text approval** (present the rule + backtest in chat, get a go) is the normal confirmation.
  It is just a message — always do it before `save_alert_rule`.
- **Visual elicitation** — opening the interactive editor page (`elicitation/create`) — is
  **optional** and must NOT fire on every setup. Most clients don't even implement it, so the
  `describe → preview → present → save` loop must always stand on its own.

**Only escalate to the visual editor in genuinely hard moments:**
1. **Ambiguous intent** you cannot resolve from context, where the choice materially changes the
   rule (several plausible services/SLOs/measures, no clear winner).
2. **High blast radius** — a paging/critical tier on a core flow, or a filter broad enough to
   risk a cardinality blow-up.
3. **Backtest contradicts stated intent** — the user said "rare" but it would fire every window,
   or zero fires over the lookback for a rule they consider important.
4. **No data to calibrate** — an uncalibrated threshold you had to guess; confirm it visually
   rather than saving silently.
5. **Destructive edits** — replacing or deleting a rule others may depend on.

For the common case — one clear target, clean backtest, a fresh rule, a threshold in a sane band —
do **not** open the page: preview → present in chat → save. When in doubt, prefer the chat flow;
reserve the visual handoff for when the stakes or the ambiguity actually justify the interruption.

### 9. Save state

Append to `.fixter/onboarding-state.json`:

    {
      "alertSetup": {
        "completed": true,
        "rulesCreated": [{ "id": "<uuid>", "name": "<name>", "tier": "P0" }],
        "pendingRules": [{ "name": "<name>", "tier": "P1" }],
        "notificationChannel": "<channel>",
        "timestamp": "<ISO>"
      }
    }
