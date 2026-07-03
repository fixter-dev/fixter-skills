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

If all three are complete, show the completion summary (step 6). Otherwise ask where to
continue.

## Step 2: OTel setup

If `otelSetup.completed` is not true, run the otel-setup skill flow.

After completion, tell the user:

"OTel setup is complete. Before continuing:
1. Deploy your instrumented application
2. Wait 2-3 minutes for telemetry to start flowing
3. Set up the Fixter MCP in your Claude Code config — add this to .mcp.json:

    {
      "fixter": {
        "type": "streamable-http",
        "url": "https://mcp.fixter.dev/mcp"
      }
    }

  Uses Auth0 — sign in with your Fixter dashboard credentials (app.fixter.dev).
  Restart Claude Code or run /mcp after adding the config.

4. Run /fixter-onboarding:onboard again to continue"

## Step 3: Logging review

If `loggingReview.completed` is not true, run the logging-review skill flow.

Logging review can run without the MCP (code-only analysis) or with it (telemetry
grounding). Recommend the MCP but don't hard-block.

## Step 4: Alert setup

If `alertSetup.completed` is not true, run the alert-setup skill flow.

This step requires the Fixter MCP. If not connected, walk the user through setup
(same instructions as step 2).

## Step 5: P1 alert expansion

If `alertSetup.completed` is true but `alertSetup.pendingRules` is non-empty, ask:
"You have P1 alerts pending. Ready to add them?" If yes, run the alert-setup skill
flow focused on the pending rules list.

## Step 6: Completion summary

When all steps are complete, assemble a summary from `.fixter/onboarding-state.json`:

    Fixter onboarding complete!

    Instrumentation:
      Service: <serviceName> (<language>/<framework>)
      Export: <exportStrategy> → ingest.fixter.dev
      Signals: traces ✓, logs ✓ (<logExportPath>), metrics ✓
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
      [• Run /fixter-onboarding:onboard to add P1 alerts]
      • Run logging-review on other services in your architecture
