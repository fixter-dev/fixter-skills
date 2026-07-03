## Getting Started with Fixter

Fixter is an observability platform for traces, logs, and metrics. This plugin adds guided onboarding skills to Claude Code so you can instrument your project in minutes — no manual config.

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
