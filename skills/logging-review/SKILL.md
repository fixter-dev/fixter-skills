---
name: logging-review
description: Use when reviewing a project's logging for observability gaps, improving log quality for debugging, or preparing structured logging for Fixter. Triggers on "review logging", "improve logs", "logging gaps", "structured logging", "log quality".
---

# Logging Review for Fixter

Review and improve project logging so logs are useful for debugging production incidents.

## Flow

### 1. Assess logging foundations

**Logging framework present?**
- Java/Kotlin: logback, log4j2, SLF4J
- Python: structlog, stdlib logging
- Node.js: pino, winston, bunyan
- PHP: Monolog
- Go: slog, zap, zerolog
- Rust: tracing crate
- Ruby: SemanticLogger, Rails logger
- C#/.NET: ILogger, Serilog, NLog

If project uses bare print statements (`System.out.println`, `console.log`, `print()`,
`echo`, `fmt.Println`, `println!`): recommend a logging framework first. Do not proceed
to flow review without one.

**Structured logging configured?** Recommend **JSON** specifically (top-level `level` /
`trace_id` / `span_id`, `message`/`msg`) — that is what the collector auto-parses. A
logfmt-style `key=value` layout is not auto-parsed; it needs an explicit `preset: logfmt`
format entry, so don't accept it as equivalent to JSON. Recommend JSON if not present.

**OTel auto-instrumentation active?** Note which signals are captured automatically.
Do NOT duplicate these with manual log lines.

**Log export configured?** Read `.fixter/onboarding-state.json` if present. If log export
is not set up, refer user to `fixter:otel-setup` skill step 4 first.

### 2. Discover business flows

Scan the project for important flows. Adapt to project type:
- **Web services:** HTTP handlers, especially POST/PUT/DELETE
- **Workers:** queue consumers, event handlers (`@RabbitListener`, `@KafkaListener`,
  SQS, Bull, Celery)
- **CLI:** command definitions, subcommand handlers
- **Scheduled:** `@Scheduled`, cron tasks, batch processors
- **Cross-cutting:** auth, payment, data import/export

If the project is part of a microservice architecture, tell the user: "I can only
review logging in this repository. Other services need separate review."

### 3. Confirm with user

Present discovered flows via `AskUserQuestion` (multiSelect): "I found these business
flows that look important. Which ones should I focus on? Select all that apply, or
describe additional ones."

### 4. Ground with telemetry (opportunistic)

If Fixter query MCP connected:
- `list_services` → verify service emits data
- `logs` / `run_sql` → check existing log coverage and error patterns
- When citing an observed error pattern as evidence, attach a self-service log link built per
  `../diagnose/references/evidence-links.md` (window from the actual query, tz detected on the
  user's machine — never hand-computed)

If no data: skip, proceed code-only. Note this step can be revisited later.

### 5. Review logging

For each confirmed flow, use the right idiom:

| Concern | Java/Kotlin | Python | Node.js | PHP | Go | Rust | Ruby | C#/.NET |
|---|---|---|---|---|---|---|---|---|
| Structured context | SLF4J MDC | structlog / extra | pino child / AsyncLocalStorage | Monolog processors | slog.With / context.Context | tracing::Span fields | SemanticLogger tagged | ILogger BeginScope |
| Correlation ID | MDC + trace ID | same | same | same | context.Context | tracing span | TaggedLogging | Activity.Current |

**Look for:**
- Silent error paths (swallowed exceptions, silent fallbacks, failing external calls)
- Missing business context at decision points (approved/declined, retry exhausted)
- Missing entity IDs in logging context (order ID, user ID, tenant ID)
- Correlation gaps across async boundaries, thread pools, queues
- Metrics smuggled into spans: a span whose start timestamp is explicitly backdated to
  an earlier business event (`setStartTimestamp(...)` / a `startTime` option anchored to
  message creation, enqueue time, order placement) so its duration measures elapsed
  business time — time-to-X, queue age, SLA clocks — instead of processing time. The
  duration is real data but it poisons trace views, latency percentiles, and
  "longest trace" queries — recommend a histogram metric or an attribute on the real
  span instead. Do not endorse or extend such spans.

**Do NOT suggest:**
- Duplicating OTel auto-instrumentation or framework request logging
- Entry/exit method logging
- Verbose logging that restates code without debugging value
- Logging in hot paths that generates noise

**NEVER suggest logging PII, credentials, or secrets.** No passwords, tokens, JWTs, card
numbers. Log entity IDs and outcomes, not contents. When reviewing auth or payment flows,
state explicitly what NOT to log.

**Calibration: 3-5 log points per flow.** Entry with key identifiers, 1-2 decision
points, error outcomes. More than 5 needs justification.

### 6. Present findings and apply

Organize by flow with file:line references. Include concrete code examples using the
project's logging framework. Apply with user approval.

### 7. Save confirmed flows

Append to `.fixter/onboarding-state.json`:

    {
      "loggingReview": {
        "completed": true,
        "confirmedFlows": [
          { "name": "<flow>", "type": "<web|worker|cli|batch>", "entrypoint": "<class.method>" }
        ],
        "errorPatterns": ["<pattern descriptions>"],
        "timestamp": "<ISO>"
      }
    }

### 8. Bridge to alerting

Tell user: "The flows and error patterns we identified are what you should alert on.
Next: set up the Fixter MCP (if not done) and run alert setup."
