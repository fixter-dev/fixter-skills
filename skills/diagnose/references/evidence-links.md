# Self-Service Evidence Links

Every log or trace claim presented to the user should carry a clickable link into the
Fixter UI so they can verify the evidence themselves. Two link types exist:

- **Trace view** — the claim is about a trace or its spans (a failing call chain, a slow
  span, an error inside a request): link the trace page directly.
- **Log explorer** — the claim is about log lines (an error pattern, a specific message,
  logs around an event): a log-explorer URL.

## Use the response's own link first

MCP responses carry ready-made links: `get_trace` and `correlate` return `traceUrl`, and
`logs` pages return `explorerUrl` — built server-side from the exact query that produced
the evidence. When the response you are citing has one, copy it verbatim; if the user's
timezone is known (stated in session, or detected as below), append `&tz=<zone>` to an
`explorerUrl` — that is the only edit to make. Do not rebuild a URL the response already
gave you.

The recipes below are the fallback for evidence with no response link: `run_sql` results,
a window or predicate different from the query you ran, or an older server.

## Trace links

    https://app.fixter.dev/traces/<trace_id>

The trace id is the path — lowercase hex, copied verbatim from the MCP result
(`get_trace`, `correlate`, a span's `traceId`, a log's `trace_id`). No query params, no
time window, no timezone; nothing to compute or encode:

    [view trace in Fixter](https://app.fixter.dev/traces/9f31aa0c…)

## Log-explorer URL template

    https://app.fixter.dev/logs?query=…&from=…&to=…&tz=…&columns=…&language=query

| Param | Example | Rules |
|---|---|---|
| `query` | `trace_id = '9f31aa0c…'` | QuerySQL predicate — same syntax as a `run_sql` WHERE clause: snake_case fields (`trace_id`, `service`, `level`), single-quoted values, `AND` to combine, `'*'` as wildcard. Keep it to 1-2 equality filters; the time window does the rest. |
| `from` / `to` | `2026-07-10T07:35:12.249Z` | ISO-8601 UTC instants with milliseconds and `Z` — see Dates. |
| `tz` | `Europe/Tallinn` | The user's IANA zone, **detected, never guessed** — see Timezone. |
| `columns` | `timestamp:254,level:80,service:160,trace_id:289,message` | Fixed constant, copy verbatim. |
| `language` | `query` | Fixed constant. |

## Timezone — run the detection, don't reuse one you saw

`tz` sets how the UI displays timestamps. A zone copied from an example link, another
user's URL, or inferred from locale/language/name is a guess — and a visibly wrong one
discredits the finding. Detect it on the user's machine every time:

    tz=$(timedatectl show -p Timezone --value 2>/dev/null)
    [ -z "$tz" ] && tz=$(readlink /etc/localtime 2>/dev/null | sed 's|.*zoneinfo/||')
    [ -z "$tz" ] && tz="${TZ:-UTC}"

If the user has stated their timezone in the session, that wins. Otherwise the
detected zone — even when the detection honestly lands on `UTC`.

## Dates — timestamps come from tools, not from your head

A link whose window misses the evidence shows "no results" and breaks trust.

- Copy `from`/`to` verbatim from the MCP query that produced the evidence, or bracket
  the specific records you're citing (padded a few minutes each side).
- MCP log records carry **epoch-second** timestamps. Any conversion, "now", relative
  bound, or padding is computed in the shell, never mentally:

      date -u '+%Y-%m-%dT%H:%M:%S.%3NZ'                        # now
      date -u -d '1 hour ago' '+%Y-%m-%dT%H:%M:%S.%3NZ'        # relative bound
      date -u -d '@1783660351.442' '+%Y-%m-%dT%H:%M:%S.%3NZ'   # epoch → ISO
      date -u -d '2026-07-10T05:12:31Z - 2 minutes' '+%Y-%m-%dT%H:%M:%S.%3NZ'  # pad

## Build the URL in one command

    python3 -c '
    import sys, urllib.parse as u
    q, frm, to, tz = sys.argv[1:5]
    print("https://app.fixter.dev/logs?" + u.urlencode({
        "query": q, "from": frm, "to": to, "tz": tz,
        "columns": "timestamp:254,level:80,service:160,trace_id:289,message",
        "language": "query"}))
    ' "service = 'checkout-api' AND level = 'ERROR'" \
      "2026-07-10T05:00:00.000Z" "2026-07-10T06:00:00.000Z" "$tz"

`urlencode`'s default `+`-for-space form is what the UI expects; don't hand-encode.

## What to link

| Evidence being cited | Link | Window |
|---|---|---|
| A trace / its spans | `https://app.fixter.dev/traces/<id>` | none — the trace page scopes itself |
| The logs of a trace | log explorer, `query` = `trace_id = '<id>'` | the records' span, padded ±2-5 min |
| An error pattern in a service | log explorer, `query` = `service = '<svc>' AND level = 'ERROR'` | the query window, verbatim |
| One log line in context | log explorer, `query` = `service = '<svc>'` | padded ±5 min around the line |

A trace claim gets the trace link; add the logs-of-a-trace link alongside it only when the
cited evidence is in the log lines (a message body, a stack trace) rather than the spans.

Attach each link inline next to the claim it supports: `[view in Fixter](<url>)`.
