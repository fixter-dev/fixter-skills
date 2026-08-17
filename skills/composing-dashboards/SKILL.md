---
name: composing-dashboards
description: Use when asked to visualize telemetry, chart or graph something from Fixter's ClickHouse data (spans, logs, metrics), build or share a dashboard link, or when an answer would land better as panels than as a table of numbers.
---

# Composing dashboards

Dashboard composition lives in the Fixter MCP server, not in this skill.

1. Call `describe_dashboards` once — it is the composition method and the format contract.
2. Ground your panel queries with `run_sql` while composing; the guide tells you what to check.
3. Call `mint_dashboard` with the definition JSON. It validates the structure, executes every
   panel against live data, and returns the link. Errors block the link and tell you what to
   fix; warnings ship with it and belong in your handover message.

Deliver the returned URL exactly as-is — a retyped link decodes as damaged.
