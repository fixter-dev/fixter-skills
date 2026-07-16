---
description: Guided Fixter onboarding — OTel setup, logging review, alert configuration
allowed-tools: Bash, AskUserQuestion, Read, Edit, Write, WebSearch, WebFetch
---

Walk the user through the full Fixter onboarding. This command spans multiple sessions —
each step saves progress to `.fixter/onboarding-state.json`, and the command resumes
where it left off.

## Step 1: Check progress

Read `.fixter/onboarding-state.json` if it exists. Show the user their status:

    Fixter onboarding progress:
      [✓ or ○] OTel setup
      [✓ or ○] Logging review
      [✓ or ○] Alert setup

If all three are complete, show the completion summary (step 7). Otherwise ask where to
continue.

## Step 2: Connect the Fixter MCP

Check whether the Fixter MCP tools are available (e.g. `get_ingestion_credentials`).
The MCP powers automatic API key provisioning, telemetry verification, and alert
setup — connect it first, not later. If missing, tell the user:

    claude mcp add --transport http fixter https://mcp.fixter.dev/mcp

Then restart Claude Code and authenticate via /mcp — a browser opens; sign in with
your Fixter credentials (same login as fixter.dev).

If the user declines, continue anyway — the skills have manual fallbacks — but note
that alert setup (step 5) will need the MCP.

## Step 3: OTel setup

If `otelSetup.completed` is not true, run the otel-setup skill flow.

For Kubernetes projects this installs the published Fixter collector chart
(`oci://ghcr.io/fixter-dev/charts/fixter-collector`); the skill handles the details.

After completion, tell the user:

"OTel setup is complete. Before continuing:
1. Deploy your instrumented application
2. Wait 2-3 minutes for telemetry to start flowing
3. Run /fixter:onboard again to continue"

## Step 4: Logging review

If `loggingReview.completed` is not true, run the logging-review skill flow.

Logging review can run without the MCP (code-only analysis) or with it (telemetry
grounding). Recommend the MCP but don't hard-block.

## Step 5: Alert setup

If `alertSetup.completed` is not true, run the alert-setup skill flow.

This step requires the Fixter MCP. If not connected, walk the user through setup
(same instructions as step 2).

## Step 6: P1 alert expansion

If `alertSetup.completed` is true but `alertSetup.pendingRules` is non-empty, ask:
"You have P1 alerts pending. Ready to add them?" If yes, run the alert-setup skill
flow focused on the pending rules list.

## Step 7: Completion summary

When all steps are complete, assemble a summary from `.fixter/onboarding-state.json`:

    Fixter onboarding complete!

    Instrumentation:
      Service: <serviceName> (<language>/<framework>)
      Export: <exportStrategy> → ingest.fixter.dev
      Signals: traces ✓, logs ✓ (<logExportPath>)
      API key: <credentialDestinations>
      [Dual-export: also sending to <existing>]

    Logging improvements:
      <N> flows reviewed
      Flows: <confirmedFlows names>

    Active alerts (P0):
      • <rule names>

    [Pending alerts (P1):
      • <pending rule names>]

    Notifications: <channel>

    Next steps:
      • Monitor P0 alerts for 1 week
      [• Run /fixter:onboard to add P1 alerts]
      • Run logging-review on other services in your architecture
