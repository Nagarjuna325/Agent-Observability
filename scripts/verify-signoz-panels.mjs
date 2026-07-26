// Proves every panel in infra/signoz/*.json actually renders data, by rebuilding
// each widget's query the way SigNoz's own frontend does
// (frontend/src/api/v5/queryRange/prepareQueryRangePayloadV5.ts) and running it
// through /api/v5/query_range. A panel that returns an empty or all-zero series is
// a broken panel: HTTP 200 alone proves nothing here.
//
//   node scripts/verify-signoz-panels.mjs [--hours 12]

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// Values in .env contain "=" (the SigNoz API key does), so split on the FIRST "=" only.
const env = Object.fromEntries(
  readFileSync(join(repoRoot, ".env"), "utf8")
    .split(/\r?\n/)
    .filter((line) => line.includes("=") && !line.trim().startsWith("#"))
    .map((line) => [line.slice(0, line.indexOf("=")).trim(), line.slice(line.indexOf("=") + 1).trim()])
);

const BASE = env.SIGNOZ_URL || "http://localhost:8080";
const KEY = env.SIGNOZ_API_KEY;
if (!KEY) {
  console.error("SIGNOZ_API_KEY missing from repo-root .env");
  process.exit(1);
}

const hoursArg = process.argv.indexOf("--hours");
const hours = hoursArg > -1 ? Number(process.argv[hoursArg + 1]) : 12;
const end = Date.now();
const start = end - hours * 60 * 60 * 1000;

const REQUEST_TYPE_BY_PANEL = {
  graph: "time_series",
  bar: "time_series",
  table: "scalar",
  pie: "scalar",
  value: "scalar",
  trace: "trace",
  list: "raw",
  histogram: "distribution",
};

const isBlank = (v) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

function toBuilderQuery(queryData, requestType) {
  const signal = queryData.dataSource === "traces" ? "traces" : queryData.dataSource === "logs" ? "logs" : "metrics";
  const aggregations =
    signal === "metrics"
      ? [
          {
            metricName: queryData.aggregations?.[0]?.metricName,
            temporality: queryData.aggregations?.[0]?.temporality,
            timeAggregation: queryData.aggregations?.[0]?.timeAggregation,
            spaceAggregation: queryData.aggregations?.[0]?.spaceAggregation,
            reduceTo: requestType === "scalar" ? queryData.aggregations?.[0]?.reduceTo : undefined,
          },
        ]
      : queryData.aggregations?.length
        ? queryData.aggregations
        : [{ expression: "count()" }];

  return {
    type: "builder_query",
    spec: {
      name: queryData.queryName,
      signal,
      ...(signal === "metrics" ? { source: queryData.source || "" } : {}),
      stepInterval: queryData.stepInterval || undefined,
      disabled: queryData.disabled,
      filter: queryData.filter?.expression ? { expression: queryData.filter.expression } : { expression: "" },
      groupBy: queryData.groupBy?.length
        ? queryData.groupBy.map((g) => ({ name: g.key, fieldDataType: g.dataType || "", fieldContext: g.type || "" }))
        : undefined,
      order: queryData.orderBy?.length
        ? queryData.orderBy.map((o) => ({ key: { name: o.columnName }, direction: o.order }))
        : undefined,
      limit: queryData.limit || undefined,
      legend: isBlank(queryData.legend) ? undefined : queryData.legend,
      having: isBlank(queryData.having) || Array.isArray(queryData.having) ? undefined : queryData.having,
      functions: isBlank(queryData.functions) ? undefined : queryData.functions,
      aggregations,
    },
  };
}

function widgetToPayload(widget) {
  const requestType = REQUEST_TYPE_BY_PANEL[widget.panelTypes];
  const queries = widget.query.builder.queryData.map((q) => toBuilderQuery(q, requestType));
  for (const formula of widget.query.builder.queryFormulas ?? []) {
    queries.push({
      type: "builder_formula",
      spec: {
        name: formula.queryName,
        expression: formula.expression,
        disabled: formula.disabled,
        legend: isBlank(formula.legend) ? undefined : formula.legend,
        limit: formula.limit || undefined,
      },
    });
  }
  return { schemaVersion: "v1", start, end, requestType, compositeQuery: { queries } };
}

// Returns every numeric aggregation value the panel would plot, across both the
// scalar (columns/data) and time_series (aggregations/series/values) result shapes.
function extractValues(results) {
  const values = [];
  for (const result of results ?? []) {
    if (Array.isArray(result.data) && Array.isArray(result.columns)) {
      const aggIdx = result.columns.map((c, i) => (c.columnType === "aggregation" ? i : -1)).filter((i) => i > -1);
      for (const row of result.data) for (const i of aggIdx) if (typeof row[i] === "number") values.push(row[i]);
    }
    for (const agg of result.aggregations ?? []) {
      for (const series of agg.series ?? []) {
        for (const point of series.values ?? []) if (typeof point.value === "number") values.push(point.value);
      }
    }
  }
  return values;
}

async function checkPanel(dashboardTitle, widget) {
  const payload = widgetToPayload(widget);
  const res = await fetch(`${BASE}/api/v5/query_range`, {
    method: "POST",
    headers: { "SIGNOZ-API-KEY": KEY, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { dashboardTitle, widget, pass: false, detail: `HTTP ${res.status}, non-JSON body (SPA catch-all?)` };
  }
  if (res.status !== 200 || json.status !== "success") {
    return { dashboardTitle, widget, pass: false, detail: `HTTP ${res.status} ${JSON.stringify(json).slice(0, 220)}` };
  }
  const results = json.data?.data?.results;
  const values = extractValues(results);
  const nonZero = values.filter((v) => v !== 0);
  if (nonZero.length === 0) {
    return { dashboardTitle, widget, pass: false, detail: `empty/all-zero result (${values.length} points)` };
  }
  return {
    dashboardTitle,
    widget,
    pass: true,
    detail: `${values.length} pts, max ${Math.max(...nonZero).toLocaleString("en-US")}`,
  };
}

const files = ["agent-fleet-health.json", "demo-api-health.json"];
const rows = [];
for (const file of files) {
  const dashboard = JSON.parse(readFileSync(join(repoRoot, "infra", "signoz", file), "utf8"));
  for (const widget of dashboard.widgets) rows.push(await checkPanel(dashboard.title, widget));
}

const pad = (s, n) => String(s).padEnd(n);
console.log(`Window: last ${hours}h (${new Date(start).toISOString()} → ${new Date(end).toISOString()})\n`);
console.log(`${pad("PANEL", 46)} ${pad("SOURCE", 8)} ${pad("TYPE", 6)} ${pad("RESULT", 8)} DETAIL`);
console.log("-".repeat(120));
let lastDashboard = null;
for (const row of rows) {
  if (row.dashboardTitle !== lastDashboard) {
    console.log(`\n[${row.dashboardTitle}]`);
    lastDashboard = row.dashboardTitle;
  }
  const sources = [...new Set(row.widget.query.builder.queryData.map((q) => q.dataSource))].join("+");
  console.log(
    `${pad(row.widget.title, 46)} ${pad(sources, 8)} ${pad(row.widget.panelTypes, 6)} ${pad(row.pass ? "PASS" : "FAIL", 8)} ${row.detail}`
  );
}

const failed = rows.filter((r) => !r.pass);
console.log(`\n${rows.length - failed.length}/${rows.length} panels returned non-empty, non-zero data.`);
process.exit(failed.length === 0 ? 0 : 1);
