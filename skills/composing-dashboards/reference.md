# Chart-link reference

A dashboard has no database row and no editor: the whole definition is
deflate-compressed into the URL fragment and rendered by `/chart`.

`mint.mjs` targets `https://app.fixter.dev` by default. Pass `--host` for any other
deployment:

| `--host` | Renders at |
|---|---|
| *(omitted)* | `https://app.fixter.dev` |
| `<origin>` | that origin, e.g. a self-hosted or internal deployment |
| `local` | `http://localhost:5173` |

A link only works against the backend that holds its data, so name the host when you
hand the link over.

## Definition schema

```ts
interface ChartDefinition {
  v: 1;                       // required
  title?: string;
  range?: { rel: '24h' } | { from: string; to: string };   // rel is <n>m|h|d
  refreshMs?: number;         // 0 = off
  targetPoints?: number;      // default 300; drives {{bucket}} width
  variables?: ChartVariable[];
  panels: ChartPanel[];       // at least one
}

interface ChartPanel {
  title: string;              // required
  sql: string;                // required
  y: string[];                // required, at least one measure column
  x?: string;                 // bucket column (time panels) or category column (toplist)
  series?: string;            // column whose values split the rows into series
  bucketMs?: number;          // bucket width; omit when the SQL uses {{bucket}}
  as?: PanelKind;             // declare it — see Roles
  unit?: string;              // 'USD' | 'ms' | '%' | 'req/s' | …
  section?: string;           // panels sharing a section render under one heading
  thresholds?: { value: number; label?: string; kind?: 'limit' | 'warning' }[];
  compare?: 'previous';       // stat tiles ONLY — a no-op that still costs a query elsewhere
  improve?: 'lower' | 'higher'; // which direction of a compare delta is good; unset renders it uncoloured

  // consumed by mint.mjs, stripped before encoding:
  w?: number;                 // width in columns, 4..24
  h?: number;                 // height in px, 120..800
}
```

`PanelKind` = `timeseries` | `bars` | `toplist` | `stat` | `heatmap` | `table`.

## Roles — what each kind requires

The renderer resolves a panel's kind from *declared* roles, never from guessing at the
data. A panel that cannot satisfy its declared kind renders as a plain table with the
reason printed on it — that is the designed failure, not a bug.

| `as` | Requires | Reads |
|---|---|---|
| `timeseries` | `x` + bucket width | one line per `series` value (or per `y` column) |
| `bars` | `x` + bucket width | stacked columns, same shape as `timeseries` |
| `toplist` | `x` | horizontal bars, one row per `x` value |
| `stat` | exactly one `y` | the single value, big |
| `heatmap` | `x` + bucket width + `series` | density grid |
| `table` | — | rows |

Bucket width means `bucketMs`, or `{{bucket}}` somewhere in the SQL.

With `as` omitted the kind is *inferred*: `x` + bucket → `timeseries`; `x` alone →
`toplist`; one row and one `y` → `stat`; otherwise `table`. Inference is a fallback for
hand-written links, not a feature to lean on — an inferred panel silently changes shape
when the query returns something unexpected.

## SQL

QuerySQL over ClickHouse, MySQL-ish. Sources: `spans`, `logs`, `metrics`. Run every
query through the Fixter MCP's `run_sql` before it goes in a panel; discover
fields with `describe_schema`.

Placeholders, substituted per render:

| Placeholder | Becomes |
|---|---|
| `{{from}}` / `{{to}}` | the selected window's timestamp literals, quoted |
| `{{bucket}}` | the chosen interval string, e.g. `'1h'` |
| `$name` | the selected value of variable `name`, single-quotes escaped |

```sql
SELECT bucket(timestamp, {{bucket}}) AS bucket,
       `llm.model_name`              AS model,
       sum(cast(`llm.cost.total` AS DOUBLE)) AS cost
FROM spans
WHERE timestamp >= {{from}} AND timestamp < {{to}}
  AND resource.deployment.environment = '$env'
  AND `llm.cost.total` IS NOT NULL
GROUP BY 1, 2
ORDER BY 1
```

Gotchas that cost real time:

- **Attributes are strings.** `sum(x)` on an attribute concatenates or errors — always `cast(x AS DOUBLE)`.
- **Resource attributes need the prefix**: `resource.deployment.environment`, `resource.service.name`. Span attributes do not: `flow`, `customer_id`, `llm.cost.total`.
- **Reserved words need backticks.** `day` and `name` produce a syntax error that points at the wrong column.
- **Missing attributes read as NULL** — a `GROUP BY` on one yields a `null` series unless you filter it out.
- **Alias a dynamic attribute before you GROUP BY it.** Grouping by the bare name can silently collapse to one wrong group: on the same `time_to_answer` rows, `GROUP BY customer_id` returned 1 row where `SELECT customer_id AS value … GROUP BY value` returned 6. It is not universal — `GROUP BY flow` is fine — so you cannot tell by looking. Always alias, then cross-check the group count against `count_distinct(x)`.
- **`countIf(x IS NOT NULL)` is not a coverage measure** — it returned 776 where the real count was 6. Use `count_distinct` plus an aliased `GROUP BY`.
- **`describe_schema` coverage counts are sampled**, not totals — treat them as "does this exist", then confirm the real shape with a `GROUP BY`.
- **No `UNION`** — only plain `SELECT`. There is no way to synthesize an "All" row, so selectors are single-value (see Variables).
- **No derived tables / subqueries in `FROM`.** `SELECT … FROM (SELECT …)` fails with "no FROM source". Two-metric arithmetic goes through conditional aggregation instead: `avg(if(metric_name = 'a', value, NULL)) / avg(if(metric_name = 'b', value, NULL))`.
- **`IN (…)` does not work on every dynamic attribute** — on the metrics `type` column it fails with "Illegal type in expression", while `=` and `!=` are fine. `IN` on real columns (`service`, `metric_name`) is fine.
- **A dotted attribute in `WHERE` needs to appear in `SELECT`/`GROUP BY` when the SELECT is aggregate-only.** `SELECT count_distinct(k8s.pod.name) AS n … WHERE k8s.namespace.name = 'prod'` is a syntax error; adding `k8s.namespace.name AS ns … GROUP BY ns` fixes it, and a stat panel still reads the first row.
- **There is no `now() - 14d` literal.** Bound time with `{{from}}`/`{{to}}`, or explicit quoted timestamps when probing by hand.
- Cross-signal joins go through `trace_id IN (SELECT trace_id FROM spans WHERE …)`.
- **`rate()` is not a per-bucket delta.** On `doris_be_compaction_bytes_total` it climbed monotonically across buckets, same as the raw counter. Use `max(value) - min(value)` grouped by bucket.
- **Backtick an alias that contains spaces**: ``round(avg(value), 2) AS `Queries per second` ``. That alias is what the legend shows on a single-series panel.
- On the `metrics` source, pod identity may be `source_instance_id` rather than `k8s.pod.name` — the k8s.pod.* metrics carry a NULL `k8s.pod.name` for the ClickHouse pods. Check which one is populated before grouping by it.

## Variables (selectors)

```json
{
  "name": "env",
  "label": "Environment",
  "query": "SELECT resource.deployment.environment AS value, count() AS n FROM spans WHERE timestamp >= {{from}} AND timestamp < {{to}} GROUP BY value ORDER BY n DESC"
}
```

- `name` must match `[A-Za-z][A-Za-z0-9_]*`; panels reference it as `$name`.
- Either `options` (a fixed list of strings or `{label, value}`) or `query` (options fetched live) — one is required.
- **Chaining**: a variable's `query` may reference an earlier variable, e.g. `WHERE resource.deployment.environment = '$env'`. Changing the parent re-fetches the child and resets it to the child's first option. Declare variables parent-first.
- Option queries want the same `{{from}}`/`{{to}}` bounds as panels; without them they scan all retained data and offer values that are dead in the selected window.
- `{label, value}` is how a UUID becomes a name — `{"label": "Acme", "value": "8f3c…"}`.
- **Single-value only.** There is no "All": every selector always filters. QuerySQL has no `UNION`, so an `all` sentinel cannot be injected into an option query. A dimension that must stay unfiltered belongs in a panel's `series`, not in a variable.
- Before shipping a selector, `GROUP BY` its column and check the option list is non-empty and the values are ones a reader recognises.

## URL

`<host>/chart?title=…&range=14d&refresh=0&size=12x260,12x260#z.<base64url>`

| Param | Effect |
|---|---|
| `title` | overrides `definition.title` |
| `range` | `<n>m\|h\|d` relative window; or `from`+`to` as ISO-8601 for a pinned one |
| `refresh` | ms between auto-refreshes; `0` off |
| `size` | `<widthPct>x<heightPx>` per panel, in panel order |
| `order` | panel indices (`0,3,1,2`) — reorders without re-minting |
| `var-<name>` | preselects a variable's value |

The fragment (after `#`) is `z.` + base64url of the deflate-raw'd JSON. It stays out of
the query string on purpose: CloudFront access logs record query strings, and a panel's
SQL can carry customer identifiers.

`mint.mjs` in this skill directory does the encoding, converts `w`/`h` into `size`, and
refuses to mint a definition that would render broken.

```
node ~/.claude/skills/composing-dashboards/mint.mjs my-dashboard.json --host monitoring
```

## Rendering facts worth knowing before you design around them

- **No log scale.** The y-axis is linear, always; there is no option to change it.
- **Axes and tooltips format through `formatMeasure`**: compact notation past a thousand, and the unit promotes (`mcores`→`cores`, `MiB`→`GiB`→`TiB`, `ms`→`s`). `USD` renders as a `$` prefix, `%` as a suffix.
- **A `%` panel is scaled 0–100 by default**, widening only if the data exceeds 100.
- Stat tiles format separately (`toLocaleString` + the raw unit suffix), so a stat shows the unit you declared without promotion.
- **Under 992px every panel becomes full width**, in definition order — the 24-column grid is a desktop-only argument.
- **Thresholds draw on `timeseries` and `bars` only**; on any other kind they are dropped silently.
- **`compare: 'previous'` renders on `stat` only**; elsewhere it costs a query per refresh and shows nothing.

## What the reader can do without a new link

Worth knowing, because it decides what you do *not* need to build in:

- Drag a panel edge to resize (snaps to the 24-column grid), drag its header to reorder.
- Click a legend entry to isolate that series; shift-click to toggle one on or off.
- Drag across a time panel to zoom into that window.
- Open a panel's SQL from its menu — shown with the time predicate stripped, ready to paste into `run_sql`.
- Change the range, hit refresh, or edit `var-*` in the URL.

Layout and selection changes live in the reader's URL. They do not travel back to you.
