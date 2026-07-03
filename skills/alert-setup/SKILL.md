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

### 6. Threshold strategy

**With real data:** query via `preview_alert_rule` with 7-day lookback. Error rate:
3-5x baseline or absolute floor, whichever higher. Latency: 2-3x normal p95.

**Without data — flow-aware defaults:**

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

Classify each flow by code analysis (LLM calls? Payment? CRUD?) and apply matching
defaults.

### 7. Backtest

For each rule, call `preview_alert_rule`:
- `totalWouldFire = 0` → too strict, loosen
- Fires constantly → too noisy, tighten or add `consecutiveWindows`
- Few fires → well-calibrated, confirm

Iterate until each rule is right.

### 8. Create rules

Call `create_alert_rule` per approved rule. Present summary with IDs.

### 9. System-suggested rules

Call `list_suggested_rules`. Present to user; offer to activate or dismiss.

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
