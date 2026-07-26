import { ChildProcess, spawn } from "child_process";
import { EventEmitter } from "events";
import * as path from "path";

export const DEMO_API_PORT = 3000;
export const HEALTH_URL = `http://localhost:${DEMO_API_PORT}/api/health`;
const BACKEND_DIR = path.resolve(__dirname, "../../demo-app/backend");
const SECOND_DEATH_WINDOW_MS = 30_000;
const KILL_EXIT_CAP_MS = 5_000;
const KILL_SETTLE_MS = 250;
const STDERR_TAIL_CHARS = 4_000;

// Verified launch recipe (apps/demo-app/CLAUDE.md). NODE_OPTIONS paths are
// cwd-relative because the repo path contains a space; the loader hook is
// mandatory for the ESM backend, and NODE_NO_WARNINGS stops Node's loader
// deprecation notice from becoming an ERROR LogRecord on every boot.
const CHILD_ENV: Record<string, string> = {
  OTEL_SERVICE_NAME: "demo-api",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
  OTEL_BSP_SCHEDULE_DELAY: "1000",
  OTEL_BLRP_SCHEDULE_DELAY: "1000",
  OTEL_LOG_LEVEL: "error",
  NODE_NO_WARNINGS: "1",
  NODE_OPTIONS:
    "--require ../../../packages/otel/dist/preload.cjs --experimental-loader ../../../node_modules/@opentelemetry/instrumentation/hook.mjs",
};

export type DemoApiNotice = { level: "warn" | "alert"; message: string };

export const demoApiEvents = new EventEmitter();

let child: ChildProcess | null = null;
let healthy = false;
let controlledKill = false;
let managedRestart = false;
let lastSurpriseDeathAt = 0;
let stayDown = false;
let lastExit: { code: number | null; signal: string | null; stderr: string } | null = null;

/** Restart audit trail — Fix and Verify correlate their patch/verify windows against these. */
export const restarts: Array<{ at: number; pid: number | undefined; reason: string }> = [];

export function getDemoApiState(): { healthy: boolean; pid: number | null } {
  return { healthy, pid: child?.pid ?? null };
}

/**
 * While the Fix agent owns the child (patch → restart → rollback), a death is an
 * expected part of that sequence, not a surprise. Without this the supervisor would
 * respawn the broken build underneath Fix and both would fight over the port.
 */
export function setManagedRestart(active: boolean): void {
  managedRestart = active;
}

/** A patched child that never bound the port is a port-release race, not a bad patch. */
export function lastExitWasAddrInUse(): boolean {
  return lastExit !== null && lastExit.stderr.includes("EADDRINUSE");
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function pollHealth(capMs: number): Promise<boolean> {
  const deadline = Date.now() + capMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(HEALTH_URL);
      if (res.ok) return true;
    } catch {
      // not listening yet
    }
    await delay(250);
  }
  return false;
}

export async function startDemoApi(reason: string, healthCapMs = 20_000): Promise<boolean> {
  const proc = spawn("node", ["../node_modules/tsx/dist/cli.mjs", "src/index.ts"], {
    cwd: BACKEND_DIR,
    env: { ...process.env, ...CHILD_ENV },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child = proc;
  // Cleared per spawn so a stale EADDRINUSE can't make a later restart retry itself.
  lastExit = null;
  let stderrTail = "";
  restarts.push({ at: Date.now(), pid: proc.pid, reason });
  proc.stdout?.on("data", (d: Buffer) => process.stdout.write(`[demo-api] ${d}`));
  proc.stderr?.on("data", (d: Buffer) => {
    stderrTail = (stderrTail + d.toString()).slice(-STDERR_TAIL_CHARS);
    process.stderr.write(`[demo-api] ${d}`);
  });
  proc.on("exit", (code, signal) => onChildExit(proc, code, signal, stderrTail));

  healthy = await pollHealth(healthCapMs);
  demoApiEvents.emit("state");
  return healthy;
}

function onChildExit(proc: ChildProcess, code: number | null, signal: string | null, stderr: string): void {
  if (proc !== child) return;
  healthy = false;
  child = null;
  lastExit = { code, signal, stderr };
  const wasControlled = controlledKill;
  controlledKill = false;
  demoApiEvents.emit("state");
  if (wasControlled || managedRestart) return;

  const now = Date.now();
  const secondDeath = now - lastSurpriseDeathAt < SECOND_DEATH_WINDOW_MS;
  lastSurpriseDeathAt = now;
  if (secondDeath || stayDown) {
    stayDown = true;
    demoApiEvents.emit("notice", {
      level: "alert",
      message: `demo-api died again (code=${code} signal=${signal}) within ${SECOND_DEATH_WINDOW_MS / 1000}s — staying down. Presenter must restart manually.`,
    } satisfies DemoApiNotice);
    return;
  }
  demoApiEvents.emit("notice", {
    level: "warn",
    message: `demo-api exited unexpectedly (code=${code} signal=${signal}) — one supervised respawn`,
  } satisfies DemoApiNotice);
  void startDemoApi("supervised_respawn").then((ok) => {
    if (!ok) {
      demoApiEvents.emit("notice", {
        level: "alert",
        message: "supervised respawn did not become healthy — demo-api is down",
      } satisfies DemoApiNotice);
    }
  });
}

/** Controlled shutdown: flag first so the exit handler doesn't treat it as a surprise. */
export async function stopDemoApi(): Promise<void> {
  const proc = child;
  if (!proc) return;
  controlledKill = true;
  const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
  proc.kill();
  const timedOut = await Promise.race([exited.then(() => false), delay(KILL_EXIT_CAP_MS).then(() => true)]);
  if (timedOut && proc.pid) {
    try {
      process.kill(proc.pid, "SIGKILL");
    } catch {
      // already gone
    }
    await exited;
  }
  // Windows does not release the listening socket the instant the process exits.
  await delay(KILL_SETTLE_MS);
}
