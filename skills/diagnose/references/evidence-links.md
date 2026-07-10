# Self-Service Evidence Links

Every log or trace claim presented to the user should carry a clickable link into the
Fixter log explorer so they can verify the evidence themselves.

## URL template

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

| Evidence being cited | `query` | Window |
|---|---|---|
| A trace | `trace_id = '<id>'` | the records' span, padded ±2-5 min |
| An error pattern in a service | `service = '<svc>' AND level = 'ERROR'` | the query window, verbatim |
| One log line in context | `service = '<svc>'` | padded ±5 min around the line |

Attach each link inline next to the claim it supports: `[view in Fixter](<url>)`.
