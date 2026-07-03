## Getting Started with Fixter

AI-native monitoring for builders. No dashboards, no alert fatigue — just signal. This plugin gets your project instrumented and sending data to Fixter in minutes, right from Claude Code.

### Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed
- A Fixter account at [fixter.dev](https://fixter.dev)

### 1. Install the plugin

```
/install-plugin fixter-dev/fixter-skills
```

### 2. Connect the Fixter MCP server

```
/mcp add fixter https://mcp.fixter.dev/mcp --transport streamable-http
```

This lets the plugin provision API keys automatically — no copy-pasting secrets.

After adding the MCP server, reload plugins so the skills pick it up:

```
/reload-plugins
```

### 3. Run the onboarding

Use the `/onboard` command for a full guided walkthrough, or invoke individual skills directly:

| Skill | What it does |
|---|---|
| `/otel-setup` | Detects your stack and adds OpenTelemetry instrumentation (traces, logs, LLM observability) |
| `/logging-review` | Reviews your logging practices and suggests improvements for observability |
| `/alert-setup` | Configures alerting rules for your services |

### What to expect

The setup skill will detect your language, framework, and infrastructure, then configure the right OTel packages and env vars. If you have an LLM-powered app (OpenAI, Anthropic, LangChain, etc.), it also wires up LLM-specific instrumentation. At the end it verifies data is flowing into Fixter.

Your API key is provisioned via a one-time URL (24-hour expiry) — it never appears in chat or gets committed to your repo.
