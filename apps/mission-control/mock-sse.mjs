// Standalone replay of the agents app's SSE contract, for developing/demoing
// mission-control without SigNoz, WSL, Gemini or the real swarm running.
// Frame shapes are copied from apps/agents/src/orchestrator.ts — if that file's
// emit() payloads change, this must change with them.
//
//   node mock-sse.mjs            -> http://localhost:4100/events
//   PORT=4200 node mock-sse.mjs  -> use with VITE_SSE_URL=http://localhost:4200/events

import http from "http";

const PORT = Number(process.env.PORT ?? 4100);
const HEARTBEAT_MS = 15_000;
const POLL_INTERVAL_MS = 4_000;
const ALLOWED_ORIGINS = ["http://localhost:5174", "http://localhost:5173"];

const clients = new Set();
let incidentCounter = 0;
let activeIncident = null;
let recentIncidents = [];
let telemetryDegraded = false;
let notice = null;
let demoApi = { healthy: true, pid: 25976 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const traceId = () => [...Array(32)].map(() => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");

function snapshot() {
  return { activeIncident, recentIncidents, demoApi, telemetryDegraded, notice, ts: Date.now() };
}

function send(type, data) {
  const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(frame);
}

const sendSnapshot = () => send("snapshot", snapshot());
const sendIncident = (i) => send("incident", { id: i.id, phase: i.phase, failureReason: i.failureReason, ts: Date.now() });
const sendAgent = (incidentId, agent, status, summary) => send("agent", { incidentId, agent, status, summary, ts: Date.now() });
const sendTool = (incidentId, agent, tool, ok, durationMs, summary) =>
  send("tool", { incidentId, agent, tool, ok, durationMs, summary, ts: Date.now() });

async function transition(incident, phase, failureReason) {
  incident.phase = phase;
  if (failureReason) incident.failureReason = failureReason;
  sendIncident(incident);
  await sleep(200);
}

async function cleanPoll() {
  sendAgent(null, "monitor", "started");
  await sleep(250);
  sendTool(null, "monitor", "signoz_search_traces", true, 140 + Math.floor(Math.random() * 90), "0 error span(s) in window");
  await sleep(80);
  sendAgent(null, "monitor", "ok", "clean");
  await sleep(POLL_INTERVAL_MS);
}

async function degradedPoll() {
  sendAgent(null, "monitor", "started");
  await sleep(300);
  sendTool(null, "monitor", "signoz_search_traces", false, 10_012, "request timed out");
  sendAgent(null, "monitor", "failed", "telemetry_unavailable");
  telemetryDegraded = true;
  sendSnapshot();
  await sleep(POLL_INTERVAL_MS);
  telemetryDegraded = false;
  sendSnapshot();
}

async function runIncident(outcome) {
  const now = Date.now();
  const exampleTraceId = traceId();

  sendAgent(null, "monitor", "started");
  await sleep(300);
  sendTool(null, "monitor", "signoz_search_traces", true, 210, "2 error span(s) on /api/bugs/:id");
  await sleep(120);
  sendAgent(null, "monitor", "ok", "detected 2 error span(s) on /api/bugs/:id");

  const incident = {
    id: `INC-${String(++incidentCounter).padStart(3, "0")}`,
    phase: "detected",
    detectedAt: now,
    route: "/api/bugs/:id",
    errorCount: 2,
    exampleTraceId,
    firstErrorAt: now - 2_400,
    lastErrorAt: now - 900,
  };
  activeIncident = incident;
  sendSnapshot();
  await transition(incident, "detected");

  await transition(incident, "diagnosing");
  sendAgent(incident.id, "diagnosis", "started");
  await sleep(700);
  sendTool(incident.id, "diagnosis", "signoz_search_logs", true, 684, "2 ERROR log(s), stack trace captured");
  await sleep(900);
  sendTool(incident.id, "diagnosis", "signoz_get_trace_details", true, 412, "4 span(s), 2 with status ERROR");
  await sleep(1_600);
  incident.hypothesis = {
    file: "src/index.ts",
    line: 87,
    cause:
      "The application attempts to read the 'id' property of a null object. The not-found guard dereferences the row before checking it exists, so a missing id throws instead of returning 404.",
    evidence: {
      traceId: exampleTraceId,
      logSnippet:
        "TypeError: Cannot read properties of null (reading 'id')\n    at <anonymous> (C:\\...\\apps\\demo-app\\backend\\src\\index.ts:87:12)",
    },
  };
  sendAgent(incident.id, "diagnosis", "ok", `${incident.hypothesis.file}:${incident.hypothesis.line} — ${incident.hypothesis.cause}`);

  await transition(incident, "fixing");
  sendAgent(incident.id, "fix", "started");
  await sleep(500);
  sendTool(incident.id, "fix", "read_text_file", true, 96, "src/index.ts (452 lines)");
  await sleep(2_100);
  sendTool(incident.id, "fix", "write_file", true, 121, "patched src/index.ts (-4 bytes)");
  await sleep(300);

  demoApi = { healthy: false, pid: null };
  sendSnapshot();
  await sleep(900);
  demoApi = { healthy: true, pid: 20000 + Math.floor(Math.random() * 40000) };
  sendSnapshot();
  sendAgent(incident.id, "fix", "ok", "Restored the null check before the property access so a missing row returns 404 instead of throwing.");

  await transition(incident, "verifying");
  sendAgent(incident.id, "verify", "started");
  await sleep(1_200);

  if (outcome === "resolved") {
    sendTool(incident.id, "verify", "signoz_search_traces", true, 388, "6 span(s) since restart, 0 error");
    await sleep(300);
    sendAgent(incident.id, "verify", "ok", "replay 404, 6 span(s) since restart");
    await transition(incident, "resolved");
  } else {
    sendTool(incident.id, "verify", "signoz_search_traces", true, 401, "3 span(s) since restart, 2 error");
    await sleep(300);
    sendAgent(incident.id, "verify", "failed", "replay returned 500, expected 404");
    notice = { level: "warn", message: "demo-api still returning 5xx after the patch — presenter reset recommended." };
    await transition(incident, "failed", "wrong_hypothesis");
  }

  recentIncidents = [incident, ...recentIncidents].slice(0, 5);
  activeIncident = null;
  sendSnapshot();
  await sleep(POLL_INTERVAL_MS);
}

async function script() {
  for (;;) {
    for (let i = 0; i < 3; i++) await cleanPoll();
    await runIncident("resolved");
    notice = null;
    for (let i = 0; i < 2; i++) await cleanPoll();
    await runIncident("failed");
    await degradedPoll();
    notice = null;
    sendSnapshot();
    for (let i = 0; i < 3; i++) await cleanPoll();
  }
}

const server = http.createServer((req, res) => {
  const origin = req.headers.origin;
  res.setHeader("Access-Control-Allow-Origin", origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);
  if (req.method === "OPTIONS") return void res.writeHead(204).end();
  if (req.url !== "/events") return void res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
  clients.add(res);
  req.on("close", () => clients.delete(res));
});

setInterval(() => {
  for (const c of clients) c.write(": heartbeat\n\n");
}, HEARTBEAT_MS).unref();

server.listen(PORT, () => console.log(`[mock] SSE on http://localhost:${PORT}/events`));
void script();
