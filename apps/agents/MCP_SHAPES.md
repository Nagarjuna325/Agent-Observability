# SigNoz MCP — literal wire shapes (Phase 7, captured 2026-07-26)

Recorded from the live server against REAL `demo-api` telemetry (two seeded-bug
triggers, `GET /api/bugs/999999`). **Monitor / Diagnosis / Verify parsers are pinned
against these shapes** — don't re-derive them from the tool descriptions.

## Connection

| | |
|---|---|
| Endpoint | `http://localhost:8000/mcp` |
| Transport | **streamable-http** (`StreamableHTTPClientTransport`, NOT SSE) |
| Protocol version | `2025-06-18` |
| serverInfo | `{"name":"SigNozMCP","version":"main-f6086b3"}` |
| Session | **stateless** — server returns NO `Mcp-Session-Id` header; responses come back as plain `application/json`, not `text/event-stream` |
| Capabilities | `{logging:{}, prompts:{}, resources:{}, tools:{}}` |
| Tool count | 41 (`signoz_search_traces`, `signoz_search_logs`, `signoz_query_metrics` all present) |
| Auth | server-side only, `SIGNOZ_API_KEY` env in the container. Clients send nothing. |
| Only non-404 path | `/mcp`. `/`, `/sse`, `/messages`, `/health` all 404. |

`POST /mcp` with `Accept: application/json, text/event-stream`. Standard JSON-RPC 2.0.

## How it's run — Foundry, not a raw `docker run`

Foundry ships a first-class `mcp` component. The repo's `infra/signoz/casting.yaml`
gained:

```yaml
  mcp:
    spec:
      enabled: true
      env:
        SIGNOZ_API_KEY: <service-account key from repo-root .env>
```

then `foundryctl cast` in `~/signoz` (WSL Ubuntu). Foundry generated the compose
service itself — container `signoz-mcp`, image `signoz/signoz-mcp-server:latest`,
`restart: unless-stopped`, `8000:8000`, on `signoz-network`, with
`MCP_SERVER_PORT=8000`, `TRANSPORT_MODE=http`,
`SIGNOZ_URL=http://signoz-signoz-0:8080` (container-internal, no
`host.docker.internal` needed). The five pre-existing SigNoz containers were NOT
recreated — zero data disruption.

## Response envelope (all tools)

```jsonc
{ "jsonrpc":"2.0", "id":N, "result":{ "content":[ {"type":"text","text":"<JSON string>"}, ... ] } }
```

- `content[0].text` is a **JSON string that must be `JSON.parse`d again** — the real
  payload is one level of string-encoding down.
- Later `content[i]` blocks are **human-readable prose, not JSON** — pagination notes
  (`"note: returned 4 rows (limit 5) — all matching results returned (hasMore=false)."`)
  and, for `signoz_query_metrics`, a `[Decisions applied]` block listing auto-filled
  params. Parse `content[0]` only; treat the rest as advisory.
- Errors are NOT JSON-RPC errors — they come back `result.isError: true` with
  `content[0].text` as plain prose plus `structuredContent: {"code":"VALIDATION_FAILED"}`.
  Check `isError` before parsing `content[0].text` as JSON.

Inner payload for all three is the same SigNoz v5 query envelope:
`{status:"success", data:{ type, meta:{rowsScanned,bytesScanned,durationMs,stepIntervals}, data:{results:[...]} }}`
(key order varies between tools — go by key, not position).

---

## 1. `signoz_search_traces`

Request params used (absolute ms window — never relative, per architecture decision 5):

```json
{ "service": "demo-api", "error": true,
  "start": 1785031300000, "end": 1785031400000, "limit": 5,
  "searchContext": "<verbatim caller intent>" }
```

`content[0].text` parsed → `data.data.results[0].rows[]`, each row `{data:{...}, timestamp}`.
Representative row (the seeded bug's server span, truncated):

```jsonc
{"data":{
  "service.name":"demo-api",
  "name":"GET /api/bugs/:id",
  "http.route":"/api/bugs/:id",
  "url.path":"/api/bugs/999999",
  "http.request.method":"GET",
  "http.response.status_code":500,
  "response_status_code":"500",          // string duplicate of the above
  "has_error":true,
  "status_code":2, "status_code_string":"Error",
  "status_message":"",                    // EMPTY on the Server span
  "kind":2, "kind_string":"Server",
  "duration_nano":2437400,
  "trace_id":"bbe372e10fdecdae4f5473f632e6fce4",
  "span_id":"a8651fd6636deaac", "parent_span_id":"",
  "timestamp":"2026-07-26T02:02:19.985Z",
  "host.name":"BollaNagarjuna",
  "webUrl":"http://signoz-signoz-0:8080/trace/bbe372e10fdecdae4f5473f632e6fce4",
  "client.address":"::1", "db.system":null, "k8s.pod.name":null /* ...many nulls... */
},"timestamp":"2026-07-26T02:02:19.985Z"}
```

**The message Diagnosis needs is on the CHILD span, not the Server span.** Each
trigger produces TWO error spans sharing a `trace_id`:

- `kind_string:"Server"`, name `GET /api/bugs/:id` → has the 500, `status_message:""`
- `kind_string:"Internal"`, name `request handler - /api/bugs/:id`,
  `parent_span_id` = the server span → **`status_message":"Cannot read properties of
  null (reading 'id')"`**, but `http.*` and `url.*` are all `null`

So 2 triggers → 4 rows. Every attribute key exists on every row; absent ones are
`null`. Note the dotted OTel keys (`http.route`) sit alongside legacy underscore ones
(`http_method`, `http_url`, both `""` here).

Second content block: `"note: returned 4 rows (limit 5) — all matching results returned (hasMore=false)."`

## 2. `signoz_search_logs`

```json
{ "service": "demo-api", "severity": "ERROR",
  "start": 1785031300000, "end": 1785031400000, "limit": 3,
  "searchContext": "<verbatim caller intent>" }
```

`content[0].text` parsed → `data.data.results[0].rows[]`. Representative row:

```jsonc
{"data":{
  "body":"TypeError: Cannot read properties of null (reading 'id')\n    at <anonymous> (C:\\Users\\nagar\\Downloads\\Hackathon Project\\apps\\demo-app\\backend\\src\\index.ts:87:12)\n    at Layer.handle [as handle_request] (...express\\lib\\router\\layer.js:95:5)\n    at next (...)\n ...",
  "severity_text":"ERROR", "severity_number":17,
  "scope_name":"console-capture",
  "trace_id":"bbe372e10fdecdae4f5473f632e6fce4",   // correlates to the span above
  "span_id":"a8651fd6636deaac",
  "trace_flags":1,
  "timestamp":1785031339990000000,                  // NANOSECONDS (int) in .data
  "id":"0lGiy8FWnoFrepXb5CUE9LIEWFN",
  "attributes_string":{}, "attributes_number":{}, "attributes_bool":{},
  "resources_string":{"service.name":"demo-api","host.name":"BollaNagarjuna",
    "process.pid":"25036","process.runtime.version":"20.19.6",
    "process.command":"...backend\\src\\index.ts", "process.command_args":"[...]",
    "telemetry.sdk.name":"opentelemetry","telemetry.sdk.version":"2.10.0", ...}
},"timestamp":"2026-07-26T02:02:19.99Z"}             // ISO string on the WRAPPER
```

Parser notes:
- **`file:line` for Diagnosis lives in `body`**, first stack frame:
  `at <anonymous> (<abs path>\backend\src\index.ts:87:12)`. Windows paths, `\n`-joined,
  backslashes; the path contains a space. Frames 2+ are `express`/`@opentelemetry`
  internals — Diagnosis must take the first frame under `apps/demo-app/backend`.
- Two different timestamp units in one row: `.data.timestamp` is unix **ns** integer,
  the sibling `.timestamp` is an ISO string.
- `service.name` is under `resources_string`, not top level. The `service` param does
  work on this workspace (the tool description warns it can fail elsewhere).
- No `attributes_*` content — the console-capture pipeline emits body + severity only.

## 2b. `signoz_get_trace_details` (added Phase 8, 2026-07-26)

```json
{ "traceId": "bbe372e10fdecdae4f5473f632e6fce4", "includeSpans": true,
  "start": <ms>, "end": <ms>, "searchContext": "<verbatim caller intent>" }
```

**Same envelope as `signoz_search_traces`** — `content[0].text` parsed →
`data.data.results[0].rows[]`, one row per span with the identical `.data` key set
(`name`, `kind_string`, `status_code_string`, `status_message`, `duration_nano`,
`http.response.status_code`, `parent_span_id`, …). Differences from `search_traces`:

- Returns **one content block only** (no pagination-note prose block).
- Returns **every** span in the trace, not just error spans — a single seeded-bug
  trigger yields 6 rows (Server + 5 express middleware/handler Internal spans), and
  the non-error ones have `status_code_string: "Unset"`, `status_message: ""`.
- `results[0]` also carries `nextCursor` (empty string when complete).

So one `rows()` accessor serves `signoz_search_traces` and `signoz_get_trace_details`
alike. Diagnosis caps the reduction at 20 spans.

## 3. `signoz_query_metrics`

### Label names (biggest trap)
`signoz_calls_total` labels on this SigNoz (v0.134.0) are **dotted**, not the older
underscore form. `service_name` / `status_code` silently return empty group values
with a nonzero aggregate. Confirmed via `signoz_get_field_keys`:

`service.name`, `service.namespace`, `operation`, `span.kind`, `status.code`,
`http.status_code` (number), `deployment.environment`, `signoz.collector.id`,
`resource_signoz.collector.id` — all `fieldContext: "attribute"`.

Available metrics on this stack (from `signoz_list_metrics`, 14 total):
`signoz_calls_total` (sum/delta/monotonic), `signoz_latency.{bucket,count,sum}`,
`http.server.request.duration.{bucket,count,sum,min,max}`, and the `http.client.*` set.

`signoz_calls_total` is a **monotonic delta counter** → `timeAggregation` must be
`rate` or `increase`; `sum` hard-fails validation. The tool's own default is `rate`,
which yields an empty result set for sparse demo traffic — **pass `increase`
explicitly**.

### scalar
```json
{ "metricName": "signoz_calls_total",
  "filter": "service.name = 'demo-api'",
  "groupBy": ["http.status_code", "operation"],
  "start": <ms>, "end": <ms>,
  "requestType": "scalar", "timeAggregation": "increase", "reduceTo": "sum",
  "searchContext": "<verbatim caller intent>" }
```
```jsonc
{"status":"success","data":{"type":"scalar",
 "meta":{"rowsScanned":4613,"bytesScanned":1537453,"durationMs":29,"stepIntervals":{"A":60}},
 "data":{"results":[{"queryName":"A",
   "columns":[{"name":"http.status_code","columnType":"group", ...},
              {"name":"operation","columnType":"group", ...},
              {"name":"__result_0","columnType":"aggregation", ...}],
   // rows are POSITIONAL ARRAYS aligned to columns[], not objects:
   "data":[["","middleware - expressInit",25],
           ["200","GET /api/bugs",10],
           ["200","GET /api/bugs/:id",5],
           ["500","GET /api/bugs/:id",3],     // <-- the seeded bug
           ["404","PUT",1],["401","POST /api/login",1], ...]}]}}}
```
Non-HTTP spans (middleware/handler internals) come back with `http.status_code: ""`
— filter them out rather than treating `""` as a status.

### time_series (the default requestType — different shape)
```json
{ "metricName": "signoz_calls_total",
  "filter": "service.name = 'demo-api' AND http.status_code = '500'",
  "start": <ms>, "end": <ms>,
  "requestType": "time_series", "timeAggregation": "increase",
  "searchContext": "..." }
```
```jsonc
{"status":"success","data":{"type":"time_series",
 "meta":{...,"stepIntervals":{"A":60}},
 "data":{"results":[{"queryName":"A",
   "aggregations":[{"index":0,"alias":"__result_0","meta":{},
     "series":[{"values":[{"timestamp":1785031320000,"value":2}]}]}]}]}}}
```
`results[].aggregations[].series[].values[]` — **no `columns`/`data` here**; branch on
`data.type` (`"scalar"` vs `"time_series"`). `value: 2` = exactly the two triggers.
Buckets are 60s (`stepIntervals`), so a sub-minute incident lands in ONE bucket.

## Cross-cutting gotchas

- **`webUrl` deep links are unusable from the host browser** — the server builds them
  from its container-internal `SIGNOZ_URL`, i.e.
  `http://signoz-signoz-0:8080/trace/<id>`. Rewrite the host to `localhost:8080`
  before showing one in mission-control.
- Absolute `start`/`end` in unix **milliseconds** override `timeRange` on all three
  tools. Always pass them (architecture decision 5: SigNoz history holds 500s from
  prior rehearsals, so relative windows are unsafe).
- `searchContext` is in every tool's schema and is meant to carry the caller's request
  verbatim — pass something meaningful; it shows up in the server's own telemetry.
- Metric-value gotcha: the counts above include earlier Phase 6 CRUD traffic in the
  same 15-min window. Narrow the window, don't assume a clean workspace.
