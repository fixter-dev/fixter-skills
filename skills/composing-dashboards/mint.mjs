#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';

const COLUMNS = 24;
const DEFAULT_HEIGHT = 220;
const MIN_COLUMNS = 4;
const MIN_HEIGHT = 120;
const MAX_HEIGHT = 800;
const KINDS = ['timeseries', 'bars', 'toplist', 'stat', 'heatmap', 'table'];
const CHART_KINDS = ['timeseries', 'bars', 'toplist'];
const THRESHOLD_KINDS = ['timeseries', 'bars'];
const MONEY = /(cost|spend|usd|price|charge|bill)/i;
const DURATION = /(duration|latency|elapsed|_ms$|_seconds$|took)/i;
const RAW_BYTE_UNIT = /^(b|by|byte|bytes)$/i;
const PLACEHOLDER_COLUMN = /^(n|v|x|y|c|val|value|amount|count|total)$/i;
const MAGNITUDE_UNIT = /^(gib|mib|kib|tib|gb|mb|kb|tb|cores?|usd)$/i;
const COUNTER = /metric_name\s*(=|IN)\s*\(?\s*'[^']*(_total|event_)/i;
const NEVER_NULL_SERIES = /\b(metric_name|service|level|type)\b/i;
const FROM_METRICS = /\bFROM\s+metrics\b/i;
const BUCKET_PLACEHOLDER = /\{\{\s*bucket\s*\}\}/;
const FROM_PLACEHOLDER = /\{\{\s*from\s*\}\}/;
const TO_PLACEHOLDER = /\{\{\s*to\s*\}\}/;
const DELTA = /max\s*\([^)]*\)\s*-\s*min\s*\(/i;
const INSTANCE_IN_QUERY = /source_instance_id|\binstance\b|hostname|\baddress\b|pod\.name/i;
const NULL_GUARD = /IS\s+NOT\s+NULL|coalesce\s*\(/i;
const SCALED_TO_PERCENT = /100\s*\*|\*\s*100|error_rate\s*\(/i;
const METRICS_SCOPE = /\b(service|k8s\.namespace\.name)\s*(=|IN\s*\()/i;
const LEVEL_AGGREGATE = /\b(avg|max|sum)\s*\(\s*value\s*\)/i;
const DOTTED_ATTRIBUTE = /\w+\.\w+/;
const HOST_ENV_VAR = 'FIXTER_HOST';
const DEFAULT_HOST = 'https://app.fixter.dev';
const USAGE =
  'usage: node mint.mjs <definition.json> [--host <origin>|local] [--range 14d] [--refresh 0]\n' +
  `       host: --host, then $${HOST_ENV_VAR}, then ${DEFAULT_HOST}`;
const HOSTS = {
  fixter: DEFAULT_HOST,
  local: 'http://localhost:5173',
};

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      flags[argv[i].slice(2)] = argv[i + 1];
      i += 1;
    } else {
      positional.push(argv[i]);
    }
  }
  return { path: positional[0], flags };
}

function createReport() {
  const errors = [];
  const warnings = [];
  return {
    errors,
    warnings,
    fail(message) {
      errors.push(message);
    },
    warn(message) {
      warnings.push(message);
    },
  };
}

function panelLabel(panel, index) {
  const title = panel?.title ? `"${panel.title}"` : '';
  return `panel[${index}] ${title}`.trim();
}

function isBucketed(panel) {
  return Boolean(panel.bucketMs) || BUCKET_PLACEHOLDER.test(panel.sql ?? '');
}

function inferKind(panel) {
  if (panel.x && isBucketed(panel)) {
    return 'timeseries';
  }
  if (panel.x) {
    return 'toplist';
  }
  if (panel.y?.length === 1) {
    return 'stat';
  }
  return 'table';
}

function roleError(panel, kind) {
  switch (kind) {
    case 'timeseries':
    case 'bars':
      if (!panel.x) {
        return `as:'${kind}' needs x (the bucket column)`;
      }
      if (!isBucketed(panel)) {
        return `as:'${kind}' needs bucketMs, or {{bucket}} in the SQL`;
      }
      return null;
    case 'toplist':
      return panel.x ? null : "as:'toplist' needs x (the category column)";
    case 'stat':
      return panel.y?.length === 1
        ? null
        : `as:'stat' needs exactly one y, got ${panel.y?.length ?? 0}`;
    case 'heatmap':
      if (!panel.x || !isBucketed(panel)) {
        return "as:'heatmap' needs x and a bucket width";
      }
      return panel.series ? null : "as:'heatmap' needs series";
    default:
      return null;
  }
}

function seriesExpression(panel) {
  const match = new RegExp(`,\\s*([^,]+?)\\s+AS\\s+${panel.series}\\b`, 'i').exec(panel.sql ?? '');
  return match?.[1] ?? '';
}

function seriesAlwaysSet(panel) {
  const expression = seriesExpression(panel);
  return NEVER_NULL_SERIES.test(expression) && !DOTTED_ATTRIBUTE.test(expression);
}

function checkRequiredFields(panel, at, report) {
  if (typeof panel?.title !== 'string' || panel.title.trim() === '') {
    report.fail(`${at}: title is required`);
  }
  if (typeof panel?.sql !== 'string' || panel.sql.trim() === '') {
    report.fail(`${at}: sql is required`);
  }
  if (!Array.isArray(panel?.y) || panel.y.length === 0) {
    report.fail(`${at}: y must list at least one measure column`);
  }
}

function checkKind(panel, at, kind, report) {
  if (!KINDS.includes(kind)) {
    report.fail(`${at}: as:'${kind}' is not a panel kind (${KINDS.join(', ')})`);
  }
  if (!panel.as) {
    report.warn(
      `${at}: no as: — the renderer would infer '${kind}' from the columns. Declare it, so a query that returns an unexpected shape fails loudly instead of redrawing itself.`,
    );
  }
  const role = roleError(panel, kind);
  if (role) {
    report.fail(`${at}: ${role} — it would fall back to a plain table`);
  }
}

function checkTimeBounds(sql, at, report) {
  if (!FROM_PLACEHOLDER.test(sql) || !TO_PLACEHOLDER.test(sql)) {
    report.fail(
      `${at}: sql has no {{from}}/{{to}} bounds — the panel would ignore the dashboard's time range`,
    );
  }
}

function checkScoping(sql, at, fromMetrics, report) {
  const scoped = fromMetrics
    ? METRICS_SCOPE.test(sql)
    : sql.includes('$env') || sql.includes('deployment.environment');
  if (scoped) {
    return;
  }
  report.fail(
    fromMetrics
      ? `${at}: sql is not scoped — the metrics source carries no resource attributes, so pin it with service = '…' or k8s.namespace.name = '…'`
      : `${at}: sql is not environment-scoped — filter on resource.deployment.environment = '$env'`,
  );
}

function checkVariableReferences(sql, at, variableNames, report) {
  for (const reference of sql.match(/\$[A-Za-z][A-Za-z0-9_]*/g) ?? []) {
    if (!variableNames.includes(reference.slice(1))) {
      report.fail(`${at}: sql references ${reference}, which no variable declares`);
    }
  }
}

function checkMoneyCast(panel, sql, at, report) {
  if (!/\bcast\(/i.test(sql) && MONEY.test(panel.y?.[0] ?? '')) {
    report.warn(
      `${at}: a money measure with no cast(... AS DOUBLE) — attributes are strings and sum as text`,
    );
  }
}

function checkThresholdSupport(panel, at, kind, report) {
  if (panel.thresholds?.length && !THRESHOLD_KINDS.includes(kind)) {
    report.fail(
      `${at}: thresholds are drawn only on timeseries and bars — on as:'${kind}' they are silently dropped`,
    );
  }
}

function checkLegendLabel(panel, at, kind, report) {
  const placeholder = panel.y?.some((column) => {
    return PLACEHOLDER_COLUMN.test(column);
  });
  if (!panel.series && CHART_KINDS.includes(kind) && placeholder) {
    report.fail(
      `${at}: y is [${panel.y.join(', ')}] and the panel has no series — a single-series legend is labelled with ` +
        'the y column name, so this renders a legend reading "n". Alias the measure to the label the reader should see.',
    );
  }
}

function checkSeriesNullGuard(panel, sql, at, report) {
  if (panel.series && !seriesAlwaysSet(panel) && !NULL_GUARD.test(sql)) {
    report.warn(
      `${at}: series column with no NULL guard — a row where ${panel.series} is NULL becomes a legend entry ` +
        'reading "null". Filter it out, or coalesce it to a real label.',
    );
  }
}

function checkComparisonReference(panel, at, kind, report) {
  const bare =
    MAGNITUDE_UNIT.test(panel.unit ?? '') &&
    CHART_KINDS.includes(kind) &&
    !panel.thresholds?.length &&
    !panel.series &&
    panel.compare !== 'previous';
  if (bare) {
    report.warn(
      `${at}: a bare ${panel.unit} measure with nothing to compare it against — the reader cannot tell whether ` +
        'it is high. Add the limit as a threshold, express it as a % of capacity, split by peers, or set compare.',
    );
  }
}

function checkCompare(panel, at, kind, report) {
  if (panel.compare === 'previous' && kind !== 'stat') {
    report.fail(
      `${at}: compare:'previous' only renders on as:'stat' — on a ${kind} it fires a second query every ` +
        'refresh and draws nothing. Remove it, or make this a stat.',
    );
  }
  if (panel.compare === 'previous' && !panel.improve) {
    report.warn(
      `${at}: compare with no improve — the delta renders uncoloured. Declare improve:'lower' or 'higher'.`,
    );
  }
}

function checkPercentScaling(panel, sql, at, report) {
  if (panel.unit === '%' && !SCALED_TO_PERCENT.test(sql)) {
    report.warn(
      `${at}: unit:'%' but the SQL never multiplies by 100 — a ratio of 0.093 renders as "0.093 %". ` +
        'Scale it, or the panel is wrong by 100x in a way that looks plausible.',
    );
  }
}

function checkCounterDelta(panel, sql, at, report) {
  const differenced = DELTA.test(sql);
  if (differenced && !INSTANCE_IN_QUERY.test(sql)) {
    report.warn(
      `${at}: a counter delta with no instance in the grouping — if more than one instance reports this ` +
        'metric, max-min measures the gap between their counters, not growth. Check count_distinct(source_instance_id).',
    );
  }
  if (differenced && BUCKET_PLACEHOLDER.test(sql) && !panel.bucketMs) {
    report.warn(
      `${at}: a per-bucket delta on a floating {{bucket}} — the bar heights change meaning when the reader ` +
        'changes the range. Pin bucketMs and the matching literal interval, and say the period in the title.',
    );
  }
}

function checkByteUnit(panel, at, report) {
  if (RAW_BYTE_UNIT.test(panel.unit ?? '')) {
    report.fail(
      `${at}: unit:'${panel.unit}' renders raw bytes — unit is a suffix, not a formatter, so this prints ` +
        '31146979346 B. Scale in the SQL (/1048576, /1073741824) and label the scaled unit (MiB, GiB).',
    );
  }
}

function checkCounterAsLevel(sql, at, kind, report) {
  const chartedAsLevel =
    kind !== 'stat' && COUNTER.test(sql) && !DELTA.test(sql) && LEVEL_AGGREGATE.test(sql);
  if (chartedAsLevel) {
    report.warn(
      `${at}: this looks like a cumulative counter charted as a level — it will only ever climb. ` +
        'Take a per-bucket delta with max(value) - min(value) and draw it as bars. rate() does not do this.',
    );
  }
}

function checkMissingUnit(panel, at, report) {
  const measures = panel.y?.join(' ') ?? '';
  if (!panel.unit && MONEY.test(measures)) {
    report.warn(`${at}: money measure with no unit — set unit:'USD'`);
  }
  if (!panel.unit && DURATION.test(measures)) {
    report.warn(`${at}: duration measure with no unit — set unit:'ms'`);
  }
}

function checkSparseForm(panel, at, kind, fromMetrics, report) {
  if (kind === 'timeseries' && panel.series && !fromMetrics) {
    report.warn(
      `${at}: as:'timeseries' with a series split over event data — if any series skips buckets, lines interpolate across the gaps; prefer as:'bars'`,
    );
  }
}

function checkHeight(panel, at, report) {
  const invalid =
    panel.h !== undefined &&
    (!Number.isInteger(panel.h) || panel.h < MIN_HEIGHT || panel.h > MAX_HEIGHT);
  if (invalid) {
    report.fail(
      `${at}: h must be a whole number of pixels, ${MIN_HEIGHT}..${MAX_HEIGHT} (got ${panel.h})`,
    );
  }
}

function checkPanel(panel, index, context, report) {
  const at = panelLabel(panel, index);
  const sql = panel.sql ?? '';
  const kind = panel.as ?? inferKind(panel);
  const fromMetrics = FROM_METRICS.test(sql);

  checkRequiredFields(panel, at, report);
  checkKind(panel, at, kind, report);
  checkTimeBounds(sql, at, report);
  checkScoping(sql, at, fromMetrics, report);
  checkVariableReferences(sql, at, context.variableNames, report);
  checkMoneyCast(panel, sql, at, report);
  checkThresholdSupport(panel, at, kind, report);
  checkLegendLabel(panel, at, kind, report);
  checkSeriesNullGuard(panel, sql, at, report);
  checkComparisonReference(panel, at, kind, report);
  checkCompare(panel, at, kind, report);
  checkPercentScaling(panel, sql, at, report);
  checkCounterDelta(panel, sql, at, report);
  checkByteUnit(panel, at, report);
  checkCounterAsLevel(sql, at, kind, report);
  checkMissingUnit(panel, at, report);
  checkSparseForm(panel, at, kind, fromMetrics, report);

  return { at, kind };
}

function layOutRows(panels, report) {
  const rows = [];
  let row = { cols: 0, panels: [] };

  panels.forEach((panel, index) => {
    const { at, kind } = checkPanel(panel, index, report.context, report);
    const width = panel.w ?? COLUMNS;

    if (!Number.isInteger(width) || width < MIN_COLUMNS || width > COLUMNS) {
      report.fail(
        `${at}: w must be a whole number of columns, ${MIN_COLUMNS}..${COLUMNS} (got ${panel.w})`,
      );
    } else {
      if (row.cols + width > COLUMNS) {
        rows.push(row);
        row = { cols: 0, panels: [] };
      }
      row.cols += width;
      row.panels.push({ at, h: panel.h ?? DEFAULT_HEIGHT, kind });
    }

    checkHeight(panel, at, report);
  });

  rows.push(row);
  return rows;
}

function checkRows(rows, report) {
  rows.forEach((row, index) => {
    if (row.cols !== COLUMNS) {
      report.fail(
        `row ${index + 1} sums to ${row.cols} of ${COLUMNS} columns — every row must sum to exactly ${COLUMNS}, ` +
          'or the leftover columns show as dead space beside the last panel',
      );
    }
    const heights = [
      ...new Set(
        row.panels.map((panel) => {
          return panel.h;
        }),
      ),
    ];
    if (heights.length > 1) {
      report.fail(
        `row ${index + 1} mixes panel heights (${heights.join(', ')}px) — side-by-side panels must share one height, ` +
          'or their bottom edges stagger and the row reads as a mistake',
      );
    }
    const kinds = new Set(
      row.panels.map((panel) => {
        return panel.kind;
      }),
    );
    if (kinds.size > 1 && kinds.has('stat')) {
      report.warn(
        `row ${index + 1} puts a stat tile beside a chart — a stat stretched to chart height is mostly empty space. ` +
          'Give the stat tiles their own row.',
      );
    }
  });
}

function checkDefinition(source, panels, variableNames, report) {
  if (source.v !== 1) {
    report.fail('definition.v must be 1');
  }
  if (panels.length === 0) {
    report.fail('definition.panels must have at least one panel');
  }
  const everyPanelIsMetrics =
    panels.length > 0 &&
    panels.every((panel) => {
      return FROM_METRICS.test(panel?.sql ?? '');
    });
  if (!variableNames.includes('env') && !everyPanelIsMetrics) {
    report.fail(
      'no `env` variable. Every dashboard is environment-scoped — all environments share one ' +
        'tenant, so an unscoped panel silently blends them.',
    );
  }
}

function checkVariables(variables, report) {
  for (const variable of variables) {
    if (variable.query && !FROM_PLACEHOLDER.test(variable.query)) {
      report.warn(
        `variable "${variable.name}": its option query has no {{from}}/{{to}} bounds — it will scan all retained data`,
      );
    }
  }
}

function sizeParam(panels) {
  return panels
    .map((panel) => {
      const raw = (panel.w ?? COLUMNS) * (100 / COLUMNS);
      const pct = Math.floor(raw * 100) / 100;
      return `${pct >= 100 ? 100 : pct}x${panel.h ?? DEFAULT_HEIGHT}`;
    })
    .join(',');
}

function encodeDefinition(source, panels) {
  const definition = {
    ...source,
    panels: panels.map(({ w, h, ...panel }) => {
      return panel;
    }),
  };
  delete definition.__notes;
  const json = JSON.stringify(definition);
  return {
    definition,
    packed: `z.${zlib.deflateRawSync(json, { level: 9 }).toString('base64url')}`,
  };
}

function resolveOrigin(hostFlag) {
  const requested = hostFlag ?? process.env[HOST_ENV_VAR] ?? 'fixter';
  return HOSTS[requested] ?? requested;
}

function buildUrl(definition, packed, panels, flags) {
  const flag = (name, fallback) => {
    return flags[name] ?? fallback;
  };
  const origin = resolveOrigin(flags.host);
  const query = new URLSearchParams();
  if (definition.title) {
    query.set('title', definition.title);
  }
  query.set('range', flag('range', definition.range?.rel ?? '24h'));
  query.set('refresh', flag('refresh', String(definition.refreshMs ?? 0)));
  query.set('size', sizeParam(panels));
  const search = query.toString().replace(/%2C/g, ',').replace(/%3A/g, ':');
  return `${origin}/chart?${search}#${packed}`;
}

function main() {
  const { path, flags } = parseArgs(process.argv.slice(2));
  if (!path) {
    console.error(USAGE);
    process.exit(2);
  }

  const source = JSON.parse(readFileSync(path, 'utf8'));
  const panels = Array.isArray(source.panels) ? source.panels : [];
  const variables = Array.isArray(source.variables) ? source.variables : [];
  const variableNames = variables
    .map((variable) => {
      return variable?.name;
    })
    .filter((name) => {
      return typeof name === 'string';
    });

  const report = createReport();
  report.context = { variableNames };

  checkDefinition(source, panels, variableNames, report);
  const rows = layOutRows(panels, report);
  checkRows(rows, report);
  checkVariables(variables, report);

  if (report.warnings.length > 0) {
    console.error(
      report.warnings
        .map((warning) => {
          return `warn: ${warning}`;
        })
        .join('\n'),
    );
  }
  if (report.errors.length > 0) {
    console.error(
      report.errors
        .map((error) => {
          return `error: ${error}`;
        })
        .join('\n'),
    );
    process.exit(1);
  }

  const { definition, packed } = encodeDefinition(source, panels);
  console.error(`${panels.length} panels, ${rows.length} rows, ${variables.length} variables`);
  console.log(buildUrl(definition, packed, panels, flags));
}

main();
