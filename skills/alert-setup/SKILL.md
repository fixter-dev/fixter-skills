---
name: alert-setup
description: Use when setting up Fixter alert rules for a project's business flows, when configuring error rate or latency alerts, or when reviewing system-suggested rules. Requires the Fixter MCP to be connected. Triggers on "set up alerts", "create alert rules", "monitor errors", "alerting", "error rate alert", "latency alert".
---

# Alert Setup for Fixter

Set up alert rules for critical business flows via the Fixter MCP.

**Prerequisites:** Fixter MCP connected, telemetry flowing.

## Flow

### 1. Verify MCP connectivity

Call `list_services`.

- **MCP not configured:** walk user through setup:

      claude mcp add --transport http fixter https://mcp.fixter.dev/mcp

  Then restart Claude Code and authenticate via `/mcp` — a browser opens; sign in
  with the same credentials as the Fixter dashboard (fixter.dev).

- **No services returned:** telemetry not flowing. Check `.fixter/onboarding-state.json`
  for OTel setup status. Tell user to deploy with OTel enabled, wait 2-3 minutes, retry.

### 2. Discover what's alertable

- `list_services` → real service names
- `describe_telemetry_schema` for LOGS and SPANS → fields, aggregates, comparators

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

Draft each candidate as a full rule spec (QuerySQL + gate) — steps 6-7 calibrate it
against real data BEFORE anything is shown to the user.

### 6. Ground thresholds in real data

**The default tables below are starting points, never the final answer.** Classify
each flow by code analysis (payment? LLM-backed? CRUD?), pick the matching default,
then calibrate:

1. Run `preview_alert_rule` with the candidate query, the default threshold, and a
   7-day lookback. The response includes the observed p95 and max per series —
   that is your baseline; there is no excuse to guess when a service reports data.
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

Call `preview_alert_rule` for each rule before presenting it:
- `totalWouldFire = 0` → likely too strict — compare the threshold to the observed max
- Fires every window → too noisy: tighten or add `consecutiveWindows`
- A few fires → well-calibrated; note the fire timestamps so the user can check
  whether they line up with real incidents

Iterate until each rule is right. A rule that was never backtested must not be
presented (except the explicitly-marked uncalibrated ones from step 6).

### 8. Present rules with their gates, then create

Present every rule in this format — never a bare name list:

    <rule name> [P0]
      Query:    SELECT error_rate() AS value FROM spans WHERE service = 'checkout-api'
      Gate:     fires when value > 0.05 for 2 consecutive 5-min windows
      Backtest: 7d — would have fired 3x; observed p95 0.021, max 0.093
      Why:      payment-adjacent flow; threshold = 3x observed baseline

The gate line must spell out threshold, comparator, window length, and consecutive
windows. The backtest line shows the evidence behind the threshold — or says
"uncalibrated (no data yet)".

After user approval, call `create_alert_rule` per rule. Confirm with rule IDs and
the same gate summaries.

### 9. System-suggested rules

Call `list_suggested_rules`. Treat suggestions exactly like your own candidates:
backtest each via `preview_alert_rule` and present in the step 8 format. Offer
`activate_suggested_rule` / `dismiss_suggested_rule` per rule.

### 10. Save state

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
