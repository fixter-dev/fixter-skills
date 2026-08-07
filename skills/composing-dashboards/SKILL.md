---
name: composing-dashboards
description: Use when asked to visualize telemetry, chart or graph something from Fixter's ClickHouse data (spans, logs, metrics), build or share a dashboard link, or when an answer would land better as panels than as a table of numbers.
---

# Composing dashboards

A Fixter dashboard is a link: the whole definition is compressed into the URL fragment
and rendered by `/chart`. Nobody edits it after you mint it — if a panel is wrong, the
reader is stuck with it. So the work is front-loaded: **ask what question it answers,
ground every query in real rows, then choose forms and layout deliberately.**

Format contract, SQL placeholders, variables, URL params: `reference.md` in this
directory. Color, marks and chart anatomy: the bundled `dataviz` skill. This file is
the composition method.

## 1. Ask before you compose

**First: is a dashboard even the deliverable?** A question asked once is a `run_sql` and a
sentence in your reply. A dashboard is a thing somebody has to trust later — it earns its
existence only when it will be looked at more than once, by someone who is not you. Minting
a link for a one-off lookup gives them something that will quietly go stale.

A dashboard built on a guess wastes the whole minting cycle. Ask — in one batch, then
compose — whenever the request leaves any of these open:

| Unstated | Ask |
|---|---|
| Which environment | "Production, or the monitoring cluster?" — decides the host *and* the data |
| What decision it serves | "Is this a weekly review, or something you'll watch during an incident?" — sets the range and refresh |
| The breakdown that matters | "Broken down by model, by flow, by customer?" — decides series vs selectors |
| A limit worth drawing | "Is there a budget or SLO line to mark?" |

Don't ask what you can read: the fields, their cardinality, and whether a dimension
exists are all answerable with `describe_schema` and `run_sql`. Ask about intent, look
up facts.

Then let the answer to "what decision does it serve" set two things you would otherwise
pick at random:

| | Range | Refresh |
|---|---|---|
| **Watched during an incident** | `1h`–`6h` | `30000`–`60000` |
| **Reviewed on a cadence** | `7d`–`30d` | `0` — a weekly-review page that repaints under you is a distraction, and every refresh re-runs every panel |
| **Left open on a wall** | `24h` | `60000` |

**Selectors built from a static `options` list go stale.** The customer list is frozen at
whoever existed when you minted it; a new one is invisible until someone regenerates the
link. Prefer a live `query` unless you need an "All" entry — and when you do accept a static
list, say so when you hand it over.

## 2. Ground every query before it becomes a panel

Run each query through the Fixter MCP's `run_sql` and read the rows. You are
checking four things, and each one changes what you build:

- **Does it return anything at all?** An empty panel is indistinguishable from a broken one.
- **How many series?** Over ~6, fold the tail into `other` or move the dimension into a selector. Never let a legend run past 8.
- **How many instances report it?** `count_distinct(source_instance_id)`. More than one changes how you must aggregate a counter (§3), and often means the per-instance split is the panel you actually wanted.
- **Is it sparse?** Count buckets with rows against buckets in the window, per series. Gaps decide the form (§3).
- **Does the dimension exist where you think, on enough rows to filter by?** In Fixter's spans a dimension often lives on a *sibling* span, not the one carrying the measure — `flow` and `customer_id` are on `time_to_answer`, cost is on `ClaudeAgent.query`. Join them through `trace_id IN (SELECT trace_id FROM spans WHERE …)`. Measure coverage with an **aliased** `GROUP BY` — grouping by a bare dynamic attribute can silently collapse to one wrong group, and believing it is how a perfectly good `customer_id` got written off as unpopulated and its selector deleted. Cross-check the group count against `count_distinct(x)` before you trust either.

If a requested dimension genuinely isn't in the data, say so and drop the panel. A
panel answering a nearby question the reader didn't ask is worse than no panel — they
will read it as the answer.

**Panels on one dashboard get compared, so make them comparable.** A breakdown drawn
from a different source than the headline above it — spans for the total, logs for the
split — will not sum to that headline, and the reader has no way to know why. Either put
every panel on the same spine, or state the coverage difference in the panel titles
themselves. A note in your handover message does not travel with the link.

## 3. Choose the form from the measure, not from habit

| The measure | Form | Why |
|---|---|---|
| A sum or count over each interval (spend/day, runs/hour, errors/day) | `bars` | A count only means something across a window, and a bar *has* width. Lines imply a continuous value that was never measured. |
| Anything sparse — a series that skips buckets | `bars` | Lines interpolate straight through the gaps, inventing a trend and hiding the real peaks. This is what "the lines look chopped up" means. |
| An instantaneous value sampled continuously (latency, queue depth, utilization, live count) | `timeseries` | Real continuity, so a line is honest. |
| One headline number | `stat` | Never a one-bar chart. |
| Ranking a dimension over the whole window | `toplist` | Sorted magnitude beats a legend. |
| One metric across many entities (per-host, per-customer) | `heatmap` | Lines past ~8 entities are unreadable noise. |
| Several measures per row that are read together | `table` | Not a fallback — the right form when the reader compares numbers, not shapes. |

Three shapes worth having by heart:

```sql
-- Latency: percentiles together on one linear axis. Never stack them — they do not sum.
SELECT bucket(timestamp, {{bucket}}) AS bucket, 'p50' AS series, p50(duration_ms) AS ms FROM spans …
-- one panel, series = p50/p95/p99 via a UNION-free trick: three y columns, no series key
SELECT bucket(timestamp, {{bucket}}) AS bucket, p50(duration_ms) AS `p50`,
       p95(duration_ms) AS `p95`, p99(duration_ms) AS `p99` FROM spans … GROUP BY bucket
-- y: ['p50','p95','p99'], no series — each y column becomes its own line and its own legend entry.

-- Error rate: a ratio of two counts, already scaled to a percentage.
SELECT bucket(timestamp, {{bucket}}) AS bucket,
       round(100 * countIf(status_code = 'ERROR') / count(), 2) AS `Error rate` FROM spans …

-- Heatmap: x = bucket, series = the entity, y = the value. Use it the moment a line chart
-- would need more than ~8 lines; the colour carries density instead of the eye tracing lines.
SELECT bucket(timestamp, {{bucket}}) AS bucket, service AS series, p95(duration_ms) AS ms FROM spans …
-- as: 'heatmap', x: 'bucket', series: 'series', y: ['ms']
```

Multiple `y` columns with no `series` key is the way to put several named measures on one
panel — the legend takes the column names, which is why they must be aliased properly.

**A cumulative counter is not a chart.** Anything ending `_total`, or any `event_*` metric,
only ever climbs — charting `avg`/`max`/`sum` of it draws a staircase that says nothing about
what happened when. Difference it per bucket with `max(value) - min(value)`, and draw that as
`bars`: it is now a per-interval sum, which is what the reader wanted. **`rate()` does not do
this** — measured on `doris_be_compaction_bytes_total`, `rate(value)` still rose monotonically
across buckets. Gauges (a level sampled over time: queue depth, heap used, CPU, replica delay)
need no differencing and belong on a line.

**Difference each reporting instance separately.** `max(value) - min(value)` is only a delta
when the rows in the group come from *one* counter. Two backends reporting the same metric put
two independent counters in the group, and max-minus-min then measures the gap between the two
pods rather than either one's growth. Measured on `doris_be_compaction_bytes_total` over the
same hour: grouped per backend it is **0.376 GiB**; ungrouped across the pair it reads
**16.3 GiB** — a 43× overstatement that looks entirely plausible on the chart. So put the
instance in the grouping: make it the `series` (which also shows you the per-node split), or
pin the panel to one instance in the `WHERE`. `count_distinct(source_instance_id)` tells you
whether you need to. Gauges are unaffected — `avg`/`max` across instances is a real number.

**A per-bucket delta is only meaningful if the bucket is fixed.** `{{bucket}}` is chosen
from the time range — 5m at 24h, 1h at 7d — so the same "volume per interval" panel changes
its bar heights twelvefold when the reader zooms out, with nothing on screen saying why. For
any differenced counter, **pin `bucketMs` and the matching literal interval** (`bucket(timestamp, '1h')`
with `bucketMs: 3600000`) and put the period in the title: "Compaction volume per hour".
Floating buckets are fine for gauges, where the value does not depend on the window.

**When one series dwarfs the others, a stack hides them.** There is no log scale — the y-axis
is linear, always. Sonnet at $1,813 stacked against Opus at $1.74 makes Opus sub-pixel: present
in the legend, invisible in the chart. Past roughly 50×, the absolute stack answers "what does
this cost in total" and nothing else. Pair it with a **normalized** panel — per run, per request,
per 1k tokens — where the series are comparable again, or rank them in a `toplist` where a
1000× ratio is still readable. Do not solve this by dropping the small series; they are usually
the interesting ones.

**Drop series that are all zero.** A series flat at 0 for every bucket takes a colour, a legend
slot and a line, and carries nothing. Your grounding query already told you — if `full` is `0.0`
in every row, filter it out rather than shipping a legend entry that never moves.

**Stack only what sums.** `bars` with a `series` stacks. Cost by model sums to total
cost, so stacking is the point. Latency percentiles, rates and percentages do not sum —
2 ms + 2 ms is not 4 ms — so split them into separate panels or drop the series.

**Never two y-scales in one panel.** Two measures of different magnitude are two panels.

Declare `as` on every panel. Omitted, the renderer infers a kind from the columns, and
a query that returns an unexpected shape silently redraws itself instead of failing.

## 4. Layout: a grid, not a collage

Width is **whole columns out of 24** (`w`), height is pixels (`h`). Both live on the
panel; `mint.mjs` turns them into the `size` param.

- **Every row sums to exactly 24.** 12+12, 8+8+8, 6+6+6+6, 16+8, 18+6, or a single 24. Percentages that "add to 100" do not survive the grid snap — 34/33/33 is how a row silently wraps a panel onto its own line. A row that stops short leaves its remaining columns as dead space beside the last panel.
- **One height per row.** Mixed heights stagger the bottom edges and the row reads as a mistake. This is the single most common way a dashboard looks ugly.
- **Stat tiles get their own row.** 4×6 columns at `h: 140`. A stat stretched to chart height is a box of whitespace.
- **Charts are 260–320px.** Below ~240 the axis labels crowd the plot.
- **Reading order is the argument**: headline stats → the trend over time → the breakdowns → the detail table. The reader's eye lands top-left; put the number that matters there.
- **Keep the first two rows above the fold** — a stat row plus one chart row is about 520px and survives a laptop. Everything below is opt-in reading, so nothing that must be seen belongs in row four.
- Use `section` to title a band of rows once the panel count passes ~6.
- **Below 992px every panel goes full width** and the grid collapses to a single column, in definition order. That is also the order someone reads on a phone, so a layout that only makes sense side-by-side will not survive the trip.
- `order` in the URL (`?order=0,3,1,2`) reorders panels without re-minting — useful when handing the same dashboard to someone who cares about a different panel first.

**How many panels depends on what kind of dashboard it is:**

| Kind | Cap | Why |
|---|---|---|
| **Answers one question** ("did the fix reduce cost?") | ~9 | Past that the answer is buried in its own supporting evidence. A second question is a second link. |
| **System health** (a database, a service) | ~14, in 3–4 named sections of ≤6 | The reader scans to the section they suspect. The cap is per section, not per page — this is the one case where a longer page beats two links, because the point is to see the subsystems together. |

Start from one of these rather than inventing a layout:

| Shape | Rows |
|---|---|
| **Overview** (the default) | `6+6+6+6` stats @140 · one `24` trend @300 · `12+12` breakdowns @280 |
| Two measures compared | `12+12` @300 |
| Chart plus its ranking | `16+8` @300 — chart left, `toplist` right |
| Fleet / many dimensions | `8+8+8` @260 |
| One thing, in detail | `24` @320, repeated |

## 5. Every panel answers "compared to what?"

A number with nothing to measure it against is not an observation. `4.23 GiB` prompts
"out of how much?"; `0.37 cores` prompts "of what allocation?"; `1,798 parts` prompts
"is that a lot?". The reader cannot answer any of them, and a panel they cannot act on
is decoration.

**Consumption is never shown without its limit.** Memory, CPU, disk, connection pools,
quotas, budgets, token allowances — anything drawn from a finite allocation ships with
that allocation visible in the same panel, as a percentage of it or as a line across it.
This is not a preference; a consumption figure without its ceiling cannot answer the only
question anyone asks of it, which is "how much room is left". If you cannot find the
limit, that is a research task, not a reason to ship the bare number — Kubernetes
publishes `k8s.container.cpu_limit` and `k8s.container.memory_limit`, pods report
`memory.available` alongside `memory.working_set`, disks come in `Free`/`Total` pairs, a
JVM reports its own `max`, and a connection pool reports `idle` beside `used`. Only when
the limit genuinely does not exist do you say so in the title.

Before you ship a panel, name its reference. In order of preference:

| Reference | How | Use when |
|---|---|---|
| **Express it as a share of capacity** | compute the ratio in SQL, `unit: '%'` | a capacity exists and is itself uninteresting — disk, quota, budget |
| **Draw the limit as a line** | `thresholds: [{ value, label, kind: 'limit' }]` | the absolute number matters *and* there's a ceiling — memory vs pod limit, spend vs budget |
| **Put the ceiling in as a series** | include it in the `series` split | the ceiling itself moves — JVM `used` / `committed` / `max` on one chart |
| **Compare to the previous window** | `compare: 'previous'` + `improve` | **stat tiles only** — see below |
| **Compare peers to each other** | split by node, pod, model, customer | no ceiling and no history — an outlier among peers is the signal |

**`compare: 'previous'` works on `as: 'stat'` and nowhere else.** On a chart it fetches
the prior window on every refresh and renders nothing at all. Pair it with
`improve: 'lower' | 'higher'`, which says which direction is good: cost rising is bad,
throughput rising is good, and without it the delta renders uncoloured rather than
guessing. Never leave the reader to infer that a red `+12%` on "Investigations" means
trouble.

Go and find the ceiling; do not assume there isn't one. Kubernetes publishes
`k8s.container.memory_limit` and `k8s.container.cpu_limit` per container, disk metrics
come in `Free`/`Total` pairs, and a JVM reports its own `max`. Two joined in one query
give you a percentage without a subquery:

```sql
round(100 * (1 - sum(if(metric_name = '…DiskFreeBytes', value, 0))
                / sum(if(metric_name = '…DiskTotalBytes', value, 0))), 1) AS `Disk used`
```

When there genuinely is no ceiling — a pod with no CPU limit set — **say so in the
title** ("CPU by node (no CPU limit set)") rather than leaving the reader to wonder.
That absence is itself information.

## 6. Label so the panel survives being screenshotted

- **Title states the measure and the split**: "Cost by model", not "Costs". No units in the title — that is what `unit` is for.
- **Set `unit` on every measure that has one.** `USD`, `ms`, `%`, `req/s`. It is appended to the axis ticks, the tooltip and the stat value. It does not reformat the number — only stat tiles get thousands separators, so a chart axis will happily read `127000000`. Scale big counts in SQL (`/1e6`, unit `M tokens`) rather than hoping the axis tidies them.
- **`unit: '%'` means the value is already 0–100.** Nothing multiplies for you: a ratio of `0.093` with `unit: '%'` renders `0.093 %`, which is wrong by 100× and looks entirely plausible. Write `round(100 * a / b, 1)`.
- **Durations don't scale by thousands.** Pick from the time ladder by magnitude, not habit: sub-second work in `ms`, request latency in `ms` up to ~10s, anything measured in minutes (agent runs, job durations) in `s` or `min`. `1200000 ms` is a 20-minute run nobody can read.
- **`unit` is a suffix, not a formatter — it does not scale.** `unit: 'B'` on 31146979346 renders `31146979346 B`, which nobody can read. Divide in the SQL (`/1048576`, `/1073741824`) and name the scaled unit: `MiB`, `GiB`, `s`. Only `USD` gets special treatment (a `$` prefix).
- **The axis promotes your unit, so declare the one that fits the small end.** `mcores` becomes `cores` past 1000, `MiB` becomes `GiB` past 1024, `ms` becomes `s` — on the tick and in the tooltip. So pick the unit that keeps the *typical* value readable and let the peaks promote themselves.
- **A `%` panel is drawn on the full 0–100 scale** whether or not the data reaches it, because 4% of a limit should look like 4%. It still widens past 100 for a ratio that can exceed its nominal maximum.
- **Pick the unit from the measured magnitude, not from the raw one.** Your grounding query already told you the typical value — choose the scale that puts it in roughly **0.1 to 1000** and give it 1–2 decimals. `6000 MiB` is as unreadable as the raw bytes were; it is 5.9 GiB. Do this per panel: on the same dashboard, JVM heap belongs in MiB (113–1024) while network volume belongs in GiB (~45 per hour). A unit that needs a thousands separator to read is the wrong unit.
- **A limit is a line, not a panel.** `thresholds: [{ value: 250, label: '$250/day budget', kind: 'limit' }]` on the chart it constrains. A separate "days over budget" stat makes the reader do the join themselves. Thresholds draw on `timeseries` and `bars` only — set on any other kind they are silently dropped.
- **The legend is built from your column names, so name them.** With a `series` column the legend shows its *values*; without one it shows the **y column name** — so `SELECT count() AS n` produces a legend that reads `n`. Alias the measure to the label the reader should see: ``round(avg(value), 2) AS `Queries per second` `` (backticks quote an identifier with spaces).
- **A NULL in the series column becomes a legend entry reading `null`.** Filter it (`AND type IS NOT NULL`) or `coalesce` it to a real label. This is usually a sign the series expression is wrong for these rows, not that the data is dirty — a `regexp_extract` against a field that is NULL on every row yields one `null` series covering everything.
- **Map ids to names in SQL or in the variable**, not in the reader's head. A UUID legend is unreadable; use a variable's `{label, value}` options, or a `CASE` in the query.
- Don't label every point. The axis, the legend and the hover carry values; the dataviz skill covers when a direct label earns its place.

## 7. Scope every panel to one environment

**Every dashboard declares an `env` variable, and every panel's SQL filters on it.**

Every environment you send telemetry from lands in one tenant. An unscoped panel blends
them into one number that is wrong in a way nobody can see — no error, no empty panel,
just a total that is quietly the sum of staging and production. `mint.mjs` refuses to
mint without it.

```json
{ "name": "env", "label": "Environment",
  "query": "SELECT resource.deployment.environment AS value, count() AS n FROM spans WHERE timestamp >= {{from}} AND timestamp < {{to}} GROUP BY value ORDER BY n DESC" }
```

Then chain the rest off it — a `flow` or `customer` selector whose own query filters on
`resource.deployment.environment = '$env'`, so changing environment never leaves a
stale selection behind. Declare variables parent-first.

**`FROM metrics` is the exception, and only this one:** that source exposes no resource
attributes at all, so there is no `deployment.environment` to filter on. Pin those panels
to the emitter instead — `service = 'doris-be'`, `k8s.namespace.name = 'clickhouse'` —
and name the cluster in the dashboard title. A metrics panel with neither is unscoped,
and `mint.mjs` rejects it the same way.

## 8. Mint, then look at it

```
node <skill-dir>/mint.mjs my-dashboard.json            # https://app.fixter.dev
node <skill-dir>/mint.mjs my-dashboard.json --host <origin>   # any other deployment
```

It validates roles, grid rows, row heights, time bounds, variable references and
environment scoping, and refuses to mint what would render broken. Fix errors; read
warnings and decide.

Structure is all it checks. Empty panels, a legend of twelve near-identical model
names, a stat reading `NaN` — all of these mint cleanly. So verify the content too:

- If you can render the page, open it and look at it. Locally that means a dev server on a port Auth0 already allows as a callback (5173/5174), proxied at the right backend — `API_PROXY_TARGET=https://api.monitoring.internal.fixter.dev npx vite --port 5174`. A fresh port fails the callback check, and a preview-mode server serves mock rows that look plausible and are not your data.
- If you can't, run every panel's SQL through `run_sql` with `{{from}}`/`{{to}}`/`{{bucket}}` and each `$var` substituted by hand, and confirm each returns rows carrying the exact `x`, `series` and `y` column names the panel declares. Say in your handover that you verified the queries, not the render.

Hand over the host name with the link — it only works against the backend holding its data.

**Never retype the URL.** A minted link is ~1000 characters of base64, and a single wrong
character decodes to "This chart link is damaged and could not be read" — the same
message a genuinely corrupt definition produces, so it sends the reader back to you with
a bug that is not in the dashboard. Redirect `mint.mjs` straight to a file and deliver
that file, or paste from it programmatically. Reproducing the string from memory is how
a correct dashboard arrives broken.

## Rationalizations

| Excuse | Reality |
|---|---|
| "There's only one environment in this data anyway" | True until it isn't, and the failure is silent. The selector costs one variable; the wrong total costs a decision. |
| "A selector would only apply to some of the panels, so I'll skip it" | Then the unscoped panels are the bug. Scope them, or say in their titles what they cover. |
| "The absolute usage is the number they asked for" | Nobody wants 4.23 GiB. They want to know how close to the ceiling it is. Ship the ceiling with it. |
| "I couldn't find the limit metric" | Look harder — `*_limit`, `*.available` beside `*.usage`, `Free`/`Total` pairs, JVM `max`, pool `idle`. Absence has to be proven, then stated in the title. |
| "A line chart is the normal way to show a trend" | A line asserts the value existed between the points. For a per-day sum it did not. Bars. |
| "The dimension isn't in the data, so I'll use the closest thing" | A proxy panel gets read as the real answer. Report the gap; drop the panel. |
| "34+33+33 = 100, that's a valid row" | The grid is 24 columns. Non-grid widths wrap unpredictably. |
| "The panels are different sizes because they need different space" | Different heights *within a row* is never that reason. Vary heights between rows. |
| "I'll let the renderer infer the panel kind" | Inference is a fallback for hand-edited links. Declared roles fail loudly; inferred ones redraw themselves. |
| "I ran one query, the schema is clear" | One query tells you a field exists, not its cardinality or sparseness — the two things that pick the form. |
| "I'll add a stat tile for the budget breaches too" | That's the threshold line's job. Two panels for one fact makes the reader do the join. |
| "`unit: 'B'` will render the bytes nicely" | It renders `31146979346 B`. Scale in SQL; the unit is only a suffix. |
| "MiB is the standard unit, I'll use it everywhere" | `6000 MiB` is not readable. Scale per panel, from the magnitude you measured, so values land near 0.1–1000. |
| "`unit: '%'` will turn the ratio into a percentage" | It appends a sign. `0.093 %` is wrong by 100× and looks fine. Multiply in SQL. |
| "I'll add `compare` so the chart shows the trend" | `compare` renders on stat tiles only. On a chart it is a wasted query and a blank. |
| "The delta is red, so the reader knows it's bad" | Only if you declared `improve`. Undeclared, a rise in throughput would read as a problem. |
| "The small series is in the legend, so it's visible" | At 1000× it is sub-pixel. Add a normalized panel or a toplist. |
| "Per-interval is fine, the bucket adapts to the range" | Which is the problem: the same bars mean twelve different things at twelve ranges. Pin `bucketMs`. |
| "It's one metric, so max−min is the delta" | Only if one instance reports it. Two pods in the group and you are charting the distance between their counters. Check `count_distinct(source_instance_id)`. |
| "`rate()` will turn this counter into a rate" | It did not. Difference it yourself with `max(value) - min(value)`. |
| "`AS n` is fine, the title says what it is" | The title is not the legend. A single-series legend reads the y column name back to the reader. |

## Red flags

- A panel whose SQL you never ran.
- `as` omitted, or `w` in percentages.
- A `timeseries` whose series is a `sum()` or `count()` per bucket.
- A consumption measure — memory, CPU, disk, pool, quota — with no limit in the panel.
- A legend with more than 8 entries, or one series more than ~50× another in a stack.
- A differenced counter on a floating `{{bucket}}`, or one whose group can hold more than one reporting instance.
- `unit: '%'` with no `100 *` in the SQL.
- `compare` on anything that isn't a stat, or without `improve`.
- No `env` variable.
- Handing over a link you have not opened.
