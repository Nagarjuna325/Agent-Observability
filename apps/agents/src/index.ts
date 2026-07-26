import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import * as path from "path";
import { initTracing } from "@agentops/otel";
import { connectMcp, disconnectMcp, MCP_URL } from "./mcp";
import { connectFsMcp, disconnectFsMcp, FIX_ROOT } from "./fsMcp";
import { DEMO_API_PORT, startDemoApi, stopDemoApi } from "./demoApi";
import { events, snapshot, start as startOrchestrator, stop as stopOrchestrator } from "./orchestrator";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const SSE_PORT = 4100;
const HEARTBEAT_MS = 15_000;
const ALLOWED_ORIGINS = ["http://localhost:5174", "http://localhost:5173"];

function loadDotEnv(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    // No host: bind the same dual-stack `::` BuggyBoard's express does. Probing
    // 0.0.0.0 instead succeeds alongside an existing `::` listener on Windows,
    // which would let an orphan demo-api slip past this check.
    probe.listen(port);
  });
}

async function mcpReachable(): Promise<boolean> {
  try {
    const res = await fetch(MCP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "agentops-preflight", version: "0.1.0" } },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function preflight(): Promise<void> {
  const failures: string[] = [];
  // AGENTS_GATE_SKIP_LLM_CHECK exists ONLY so Phase 8's key-independent gate (Part A)
  // could exercise startup before the LLM key was provisioned. It bypasses this one
  // check and nothing else; without it the key is mandatory.
  if (!process.env.GEMINI_API_KEY && process.env.AGENTS_GATE_SKIP_LLM_CHECK !== "1") {
    failures.push("GEMINI_API_KEY is not set (repo-root .env)");
  }
  if (!process.env.SIGNOZ_API_KEY) failures.push("SIGNOZ_API_KEY is not set (repo-root .env)");
  if (!(await mcpReachable())) failures.push(`SigNoz MCP server did not answer initialize at ${MCP_URL}`);
  if (!(await portIsFree(DEMO_API_PORT))) {
    failures.push(
      `port ${DEMO_API_PORT} is already in use — an orphaned demo-api owns it. Kill it first ` +
        `(netstat -ano | findstr :${DEMO_API_PORT}, then taskkill /PID <pid> /F); this process must own the child it restarts.`
    );
  }
  if (failures.length > 0) {
    console.error("Startup refused:\n" + failures.map((f) => `  - ${f}`).join("\n"));
    process.exit(1);
  }
}

function startSseServer(): http.Server {
  const clients = new Set<http.ServerResponse>();

  const server = http.createServer((req, res) => {
    const origin = req.headers.origin;
    res.setHeader("Access-Control-Allow-Origin", origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    if (req.url !== "/events") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
  });

  events.on("sse", (type: string, data: unknown) => {
    const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(frame);
  });
  setInterval(() => {
    for (const c of clients) c.write(": heartbeat\n\n");
  }, HEARTBEAT_MS).unref();

  server.listen(SSE_PORT, () => console.log(`[agents] SSE on http://localhost:${SSE_PORT}/events`));
  return server;
}

async function main(): Promise<void> {
  loadDotEnv(path.join(REPO_ROOT, ".env"));
  await preflight();

  process.env.OTEL_SERVICE_NAME = "sdlc-agents";
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??= "http://localhost:4318";
  process.env.OTEL_BSP_SCHEDULE_DELAY ??= "1000";
  process.env.OTEL_LOG_LEVEL ??= "error";
  const tracing = initTracing();

  const server = startSseServer();

  if (!(await startDemoApi("initial_start"))) {
    console.error("Startup refused: demo-api child never became healthy");
    await stopDemoApi();
    process.exit(1);
  }
  console.log("[agents] demo-api healthy");

  await connectMcp();
  console.log("[agents] MCP connected");

  try {
    await connectFsMcp();
  } catch (err) {
    console.error(`Startup refused: filesystem MCP server would not start — ${(err as Error).message}`);
    await stopDemoApi();
    process.exit(1);
  }
  console.log(`[agents] filesystem MCP connected (root: ${FIX_ROOT})`);

  startOrchestrator(tracing.forceFlush);
  console.log("[agents] monitor loop running");

  const shutdown = async () => {
    stopOrchestrator();
    server.close();
    await stopDemoApi();
    await disconnectMcp();
    await disconnectFsMcp();
    await tracing.shutdown().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

void main();
