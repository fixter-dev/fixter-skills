#!/usr/bin/env node
// Validates a dashboard definition and prints its /chart URL.
// Usage: node mint.mjs <definition.json> [--host <origin>] [--range 14d] [--refresh 0]

import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';

const COLUMNS = 24;
const KINDS = ['timeseries', 'bars', 'toplist', 'stat', 'heatmap', 'table'];
const MONEY = /(cost|spend|usd|price|charge|bill)/i;
const DURATION = /(duration|latency|elapsed|_ms$|_seconds$|took)/i;
const RAW_BYTE_UNIT = /^(b|by|byte|bytes)$/i;
const PLACEHOLDER_COLUMN = /^(n|v|x|y|c|val|value|amount|count|total)$/i;
const CHART_KINDS = ['timeseries', 'bars', 'toplist'];
const MAGNITUDE_UNIT = /^(gib|mib|kib|tib|gb|mb|kb|tb|cores?|usd)$/i;
const COUNTER = /metric_name\s*(=|IN)\s*\(?\s*'[^']*(_total|event_)/i;
const NEVER_NULL_SERIES = /\b(metric_name|service|level|type)\b/i;
const DEFAULT_HOST = 'https://app.fixter.dev';
const HOSTS = {
  fixter: DEFAULT_HOST,
  monitoring: 'https://app.monitoring.internal.fixter.dev',
  local: 'http://localhost:5173',
};

const args = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i].startsWith('--')) {
    flags[args[i].slice(2)] = args[i + 1];
    i += 1;
  } else {
    positional.push(args[i]);
  }
}
const flag = (name, fallback) => flags[name] ?? fallback;
const path = positional[0];
if (!path) {
  console.error('usage: node mint.mjs <definition.json> [--host <origin>|fixter|monitoring|local] [--range 14d] [--refresh 0]');
  process.exit(2);
}

const source = JSON.parse(readFileSync(path, 'utf8'));
const errors = [];
const warnings = [];
const fail = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

const panels = Array.isArray(source.panels) ? source.panels : [];
if (source.v !== 1) fail('definition.v must be 1');
if (panels.length === 0) fail('definition.panels must have at least one panel');

const variables = Array.isArray(source.variables) ? source.variables : [];
const variableNames = variables.map((v) => v?.name).filter((n) => typeof n === 'string');

const everyPanelIsMetrics =
  panels.length > 0 && panels.every((p) => /\bFROM\s+metrics\b/i.test(p?.sql ?? ''));

if (!variableNames.includes('env') && !everyPanelIsMetrics) {
  fail(
    'no `env` variable. Every dashboard is environment-scoped — production and monitoring ' +
      'share this ClickHouse tenant, so an unscoped panel silently blends them.',
  );
}

function bucketed(panel) {
  return Boolean(panel.bucketMs) || /\{\{\s*bucket\s*\}\}/.test(panel.sql ?? '');
}

function inferKind(panel) {
  if (panel.x && bucketed(panel)) return 'timeseries';
  if (panel.x) return 'toplist';
  if (panel.y?.length === 1) return 'stat';
  return 'table';
}

function roleError(panel, kind) {
  switch (kind) {
    case 'timeseries':
    case 'bars':
      if (!panel.x) return `as:'${kind}' needs x (the bucket column)`;
      if (!bucketed(panel)) return `as:'${kind}' needs bucketMs, or {{bucket}} in the SQL`;
      return null;
    case 'toplist':
      return panel.x ? null : "as:'toplist' needs x (the category column)";
    case 'stat':
      return panel.y?.length === 1 ? null : `as:'stat' needs exactly one y, got ${panel.y?.length ?? 0}`;
    case 'heatmap':
      if (!panel.x || !bucketed(panel)) return "as:'heatmap' needs x and a bucket width";
      return panel.series ? null : "as:'heatmap' needs series";
    default:
      return null;
  }
}

const rows = [];
let row = { cols: 0, panels: [] };
panels.forEach((panel, i) => {
  const at = `panel[${i}] ${panel?.title ? `"${panel.title}"` : ''}`.trim();
  if (typeof panel?.title !== 'string' || panel.title.trim() === '') fail(`${at}: title is required`);
  if (typeof panel?.sql !== 'string' || panel.sql.trim() === '') fail(`${at}: sql is required`);
  if (!Array.isArray(panel?.y) || panel.y.length === 0) fail(`${at}: y must list at least one measure column`);

  const kind = panel.as ?? inferKind(panel);
  if (!KINDS.includes(kind)) fail(`${at}: as:'${kind}' is not a panel kind (${KINDS.join(', ')})`);
  if (!panel.as) {
    warn(`${at}: no as: — the renderer would infer '${kind}' from the columns. Declare it, so a query that returns an unexpected shape fails loudly instead of redrawing itself.`);
  }
  const role = roleError(panel, kind);
  if (role) fail(`${at}: ${role} — it would fall back to a plain table`);

  const sql = panel.sql ?? '';
  if (!/\{\{\s*from\s*\}\}/.test(sql) || !/\{\{\s*to\s*\}\}/.test(sql)) {
    fail(`${at}: sql has no {{from}}/{{to}} bounds — the panel would ignore the dashboard's time range`);
  }
  const fromMetrics = /\bFROM\s+metrics\b/i.test(sql);
  const scoped = fromMetrics
    ? /\b(service|k8s\.namespace\.name)\s*(=|IN\s*\()/i.test(sql)
    : sql.includes('$env') || sql.includes('deployment.environment');
  if (!scoped) {
    fail(
      fromMetrics
        ? `${at}: sql is not scoped — the metrics source carries no resource attributes, so pin it with service = '…' or k8s.namespace.name = '…'`
        : `${at}: sql is not environment-scoped — filter on resource.deployment.environment = '$env'`,
    );
  }
  for (const ref of sql.match(/\$[A-Za-z][A-Za-z0-9_]*/g) ?? []) {
    if (!variableNames.includes(ref.slice(1))) fail(`${at}: sql references ${ref}, which no variable declares`);
  }
  if (/\bcast\(/i.test(sql) === false && MONEY.test(panel.y?.[0] ?? '')) {
    warn(`${at}: a money measure with no cast(... AS DOUBLE) — attributes are strings and sum as text`);
  }
  if (panel.thresholds?.length && kind !== 'timeseries' && kind !== 'bars') {
    fail(`${at}: thresholds are drawn only on timeseries and bars — on as:'${kind}' they are silently dropped`);
  }
  if (!panel.series && CHART_KINDS.includes(kind) && panel.y?.some((c) => PLACEHOLDER_COLUMN.test(c))) {
    fail(
      `${at}: y is [${panel.y.join(', ')}] and the panel has no series — a single-series legend is labelled with ` +
        'the y column name, so this renders a legend reading "n". Alias the measure to the label the reader should see.',
    );
  }
  const seriesExpr = new RegExp(`,\\s*([^,]+?)\\s+AS\\s+${panel.series}\\b`, 'i').exec(sql)?.[1] ?? '';
  // A column that is always present stays safe through replace()/substring(); a dotted
  // attribute in the expression means it can be missing, and missing renders as "null".
  const seriesAlwaysSet = NEVER_NULL_SERIES.test(seriesExpr) && !/\w+\.\w+/.test(seriesExpr);
  if (panel.series && !seriesAlwaysSet && !/IS\s+NOT\s+NULL|coalesce\s*\(/i.test(sql)) {
    warn(
      `${at}: series column with no NULL guard — a row where ${panel.series} is NULL becomes a legend entry ` +
        'reading "null". Filter it out, or coalesce it to a real label.',
    );
  }
  if (
    MAGNITUDE_UNIT.test(panel.unit ?? '') &&
    CHART_KINDS.includes(kind) &&
    !panel.thresholds?.length &&
    !panel.series &&
    panel.compare !== 'previous'
  ) {
    warn(
      `${at}: a bare ${panel.unit} measure with nothing to compare it against — the reader cannot tell whether ` +
        'it is high. Add the limit as a threshold, express it as a % of capacity, split by peers, or set compare.',
    );
  }
  if (panel.compare === 'previous' && kind !== 'stat') {
    fail(
      `${at}: compare:'previous' only renders on as:'stat' — on a ${kind} it fires a second query every ` +
        'refresh and draws nothing. Remove it, or make this a stat.',
    );
  }
  if (panel.compare === 'previous' && !panel.improve) {
    warn(`${at}: compare with no improve — the delta renders uncoloured. Declare improve:'lower' or 'higher'.`);
  }
  if (panel.unit === '%' && !/100\s*\*|\*\s*100|error_rate\s*\(/i.test(sql)) {
    warn(
      `${at}: unit:'%' but the SQL never multiplies by 100 — a ratio of 0.093 renders as "0.093 %". ` +
        'Scale it, or the panel is wrong by 100x in a way that looks plausible.',
    );
  }
  const differenced = /max\s*\([^)]*\)\s*-\s*min\s*\(/i.test(sql);
  if (differenced && !/source_instance_id|\binstance\b|hostname|\baddress\b|pod\.name/i.test(sql)) {
    warn(
      `${at}: a counter delta with no instance in the grouping — if more than one instance reports this ` +
        'metric, max-min measures the gap between their counters, not growth. Check count_distinct(source_instance_id).',
    );
  }
  if (differenced && /\{\{\s*bucket\s*\}\}/.test(sql) && !panel.bucketMs) {
    warn(
      `${at}: a per-bucket delta on a floating {{bucket}} — the bar heights change meaning when the reader ` +
        'changes the range. Pin bucketMs and the matching literal interval, and say the period in the title.',
    );
  }
  if (RAW_BYTE_UNIT.test(panel.unit ?? '')) {
    fail(
      `${at}: unit:'${panel.unit}' renders raw bytes — unit is a suffix, not a formatter, so this prints ` +
        '31146979346 B. Scale in the SQL (/1048576, /1073741824) and label the scaled unit (MiB, GiB).',
    );
  }
  if (
    kind !== 'stat' &&
    COUNTER.test(sql) &&
    !/max\s*\([^)]*\)\s*-\s*min\s*\(/i.test(sql) &&
    /\b(avg|max|sum)\s*\(\s*value\s*\)/i.test(sql)
  ) {
    warn(
      `${at}: this looks like a cumulative counter charted as a level — it will only ever climb. ` +
        'Take a per-bucket delta with max(value) - min(value) and draw it as bars. rate() does not do this.',
    );
  }
  if (!panel.unit && MONEY.test(panel.y?.join(' ') ?? '')) warn(`${at}: money measure with no unit — set unit:'USD'`);
  if (!panel.unit && DURATION.test(panel.y?.join(' ') ?? '')) warn(`${at}: duration measure with no unit — set unit:'ms'`);
  if (kind === 'timeseries' && panel.series && !fromMetrics) {
    warn(`${at}: as:'timeseries' with a series split over event data — if any series skips buckets, lines interpolate across the gaps; prefer as:'bars'`);
  }

  const w = panel.w ?? COLUMNS;
  if (!Number.isInteger(w) || w < 4 || w > COLUMNS) {
    fail(`${at}: w must be a whole number of columns, 4..${COLUMNS} (got ${panel.w})`);
  } else {
    if (row.cols + w > COLUMNS) {
      rows.push(row);
      row = { cols: 0, panels: [] };
    }
    row.cols += w;
    row.panels.push({ at, h: panel.h ?? 220, kind });
  }
  if (panel.h !== undefined && (!Number.isInteger(panel.h) || panel.h < 120 || panel.h > 800)) {
    fail(`${at}: h must be a whole number of pixels, 120..800 (got ${panel.h})`);
  }
});
rows.push(row);
rows.forEach((r, i) => {
  if (r.cols !== COLUMNS) {
    fail(
      `row ${i + 1} sums to ${r.cols} of ${COLUMNS} columns — every row must sum to exactly ${COLUMNS}, ` +
        'or the leftover columns show as dead space beside the last panel',
    );
  }
  const heights = [...new Set(r.panels.map((p) => p.h))];
  if (heights.length > 1) {
    fail(
      `row ${i + 1} mixes panel heights (${heights.join(', ')}px) — side-by-side panels must share one height, ` +
        'or their bottom edges stagger and the row reads as a mistake',
    );
  }
  const kinds = new Set(r.panels.map((p) => p.kind));
  if (kinds.size > 1 && kinds.has('stat')) {
    warn(
      `row ${i + 1} puts a stat tile beside a chart — a stat stretched to chart height is mostly empty space. ` +
        'Give the stat tiles their own row.',
    );
  }
});

for (const variable of variables) {
  if (variable.query && !/\{\{\s*from\s*\}\}/.test(variable.query)) {
    warn(`variable "${variable.name}": its option query has no {{from}}/{{to}} bounds — it will scan all retained data`);
  }
}

if (warnings.length > 0) console.error(warnings.map((w) => `warn: ${w}`).join('\n'));
if (errors.length > 0) {
  console.error(errors.map((e) => `error: ${e}`).join('\n'));
  process.exit(1);
}

const definition = {
  ...source,
  panels: panels.map(({ w, h, ...panel }) => panel),
};
delete definition.__notes;

const sizes = panels
  .map((p) => {
    const pct = Math.floor(((p.w ?? COLUMNS) * (100 / COLUMNS)) * 100) / 100;
    return `${pct >= 100 ? 100 : pct}x${p.h ?? 220}`;
  })
  .join(',');

const hostArg = flag('host', 'fixter');
const origin = HOSTS[hostArg] ?? hostArg;
const packed = 'z.' + zlib.deflateRawSync(JSON.stringify(definition), { level: 9 }).toString('base64url');
const query = new URLSearchParams();
if (definition.title) query.set('title', definition.title);
query.set('range', flag('range', definition.range?.rel ?? '24h'));
query.set('refresh', flag('refresh', String(definition.refreshMs ?? 0)));
query.set('size', sizes);

console.error(`${panels.length} panels, ${rows.length} rows, ${variables.length} variables`);
console.log(`${origin}/chart?${query.toString().replace(/%2C/g, ',').replace(/%3A/g, ':')}#${packed}`);
