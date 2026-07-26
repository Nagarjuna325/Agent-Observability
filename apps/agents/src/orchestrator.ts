import { EventEmitter } from "events";
import { Span, SpanContext } from "@opentelemetry/api";
import { AgentName, AgentResult, withAgentSpan, withIncidentId } from "@agentops/otel";
import {
  AgentCtx,
  Detection,
  Hypothesis,
  initWatermark,
  jumpWatermark,
  runDiagnosis,
  runFix,
  runMonitorPoll,
  runVerify,
} from "./agents";
import { DemoApiNotice, demoApiEvents, getDemoApiState } from "./demoApi";

const POLL_INTERVAL_MS = 4_000;
const DIAGNOSIS_WINDOW_PAD_MS = 5_000;
const RECENT_INCIDENTS = 5;

export type IncidentPhase = "detected" | "diagnosing" | "fixing" | "verifying" | "resolved" | "failed";

export type IncidentState = {
  id: string;
  phase: IncidentPhase;
  failureReason?: string;
  detectedAt: number;
  route: string;
  errorCount: number;
  exampleTraceId: string;
  firstErrorAt: number;
  lastErrorAt: number;
  hypothesis?: Hypothesis;
  traceId?: string;
};

/** SSE fan-out channel; index.ts owns the HTTP framing. */
export const events = new EventEmitter();

let activeIncident: IncidentState | null = null;
let recentIncidents: IncidentState[] = [];
let telemetryDegraded = false;
let notice: DemoApiNotice | null = null;
let flush: () => Promise<void> = async () => undefined;
let timer: NodeJS.Timeout | null = null;
let stopped = false;
let incidentCounter = 0;
let rootSpan: Span | null = null;

export function snapshot(): Record<string, unknown> {
  return {
    activeIncident,
    recentIncidents,
    demoApi: getDemoApiState(),
    telemetryDegraded,
    notice,
    ts: Date.now(),
  };
}

function emit(type: "snapshot" | "incident" | "agent" | "tool", data: Record<string, unknown>): void {
  events.emit("sse", type, data);
}

function emitSnapshot(): void {
  emit("snapshot", snapshot());
}

function setTelemetryDegraded(value: boolean): void {
  if (telemetryDegraded === value) return;
  telemetryDegraded = value;
  emitSnapshot();
}

function transition(incident: IncidentState, phase: IncidentPhase): void {
  incident.phase = phase;
  rootSpan?.addEvent("incident.phase", { phase, failure_reason: incident.failureReason ?? "" });
  emit("incident", { id: incident.id, phase, failureReason: incident.failureReason, ts: Date.now() });
}

function emitAgent(incidentId: string | null, agent: AgentName, status: "started" | "ok" | "failed", summary?: string): void {
  emit("agent", { incidentId, agent, status, summary, ts: Date.now() });
}

function agentCtx(incidentId: string | null): AgentCtx {
  return {
    onTool: (e) =>
      emit("tool", {
        incidentId,
        agent: e.agent,
        tool: e.tool,
        ok: e.ok,
        durationMs: e.durationMs,
        summary: e.summary,
        ts: Date.now(),
      }),
  };
}

async function runStep<T extends AgentResult>(
  incident: IncidentState,
  agent: AgentName,
  phase: IncidentPhase,
  run: () => Promise<T>,
  describe: (r: T) => string
): Promise<T> {
  transition(incident, phase);
  emitAgent(incident.id, agent, "started");
  const result = await run();
  emitAgent(incident.id, agent, result.status === "ok" ? "ok" : "failed", describe(result));
  return result;
}

async function runIncident(detection: Detection, pollSpanContext: SpanContext): Promise<void> {
  const incident: IncidentState = {
    id: `INC-${String(++incidentCounter).padStart(3, "0")}`,
    phase: "detected",
    detectedAt: Date.now(),
    route: detection.route,
    errorCount: detection.errorCount,
    exampleTraceId: detection.exampleTraceId,
    firstErrorAt: detection.firstErrorAt,
    lastErrorAt: detection.lastErrorAt,
  };
  activeIncident = incident;
  emitSnapshot();

  await withIncidentId(incident.id, () => withAgentSpan("orchestrator", "incident", async (span) => {
    rootSpan = span;
    incident.traceId = span.spanContext().traceId;
    // Caused-by, not parented-by: the detecting Monitor poll is its own root trace.
    span.addLink({ context: pollSpanContext });
    span.setAttributes({
      "incident.id": incident.id,
      "incident.route": incident.route,
      "incident.error_count": incident.errorCount,
      "incident.example_trace_id": incident.exampleTraceId,
      "incident.detected_by_trace_id": pollSpanContext.traceId,
      "incident.detected_by_span_id": pollSpanContext.spanId,
    });
    transition(incident, "detected");

    const ctx = agentCtx(incident.id);
    const diagnosis = await runStep(
      incident,
      "diagnosis",
      "diagnosing",
      () =>
        runDiagnosis(
          {
            windowStart: detection.firstErrorAt - DIAGNOSIS_WINDOW_PAD_MS,
            windowEnd: detection.lastErrorAt + DIAGNOSIS_WINDOW_PAD_MS,
            exampleTraceId: detection.exampleTraceId,
            route: detection.route,
            errorCount: detection.errorCount,
          },
          ctx
        ),
      (r) => (r.hypothesis ? `${r.hypothesis.file}:${r.hypothesis.line} — ${r.hypothesis.cause}` : (r.failureReason ?? ""))
    );
    if (diagnosis.status !== "ok" || !diagnosis.hypothesis) return close(incident, "failed", diagnosis.failureReason);
    incident.hypothesis = diagnosis.hypothesis;
    // Push it now, not at close: mission-control shows the file:line the moment
    // Diagnosis lands, and without this the only mid-incident carrier is the
    // human-formatted agent summary, which the UI would have to parse back apart.
    emitSnapshot();

    const fix = await runStep(
      incident,
      "fix",
      "fixing",
      () => runFix(diagnosis.hypothesis!, ctx),
      (r) => r.failureReason ?? r.rationale ?? ""
    );
    if (fix.status !== "ok" || !fix.restart) return close(incident, "failed", fix.failureReason);

    const verify = await runStep(
      incident,
      "verify",
      "verifying",
      () => runVerify(fix.restart!, ctx),
      (r) => r.summary ?? r.failureReason ?? ""
    );
    if (verify.status !== "ok") return close(incident, "failed", verify.failureReason);

    return close(incident, "resolved");
  }));

  rootSpan = null;
  // Watermark past everything this incident covered, so the resumed Monitor loop
  // cannot re-detect the same 500s.
  jumpWatermark(Math.max(Date.now(), incident.lastErrorAt) + 1);
  activeIncident = null;
  recentIncidents = [incident, ...recentIncidents].slice(0, RECENT_INCIDENTS);
  emitSnapshot();
  await flush();
}

/** The orchestrator is the sole writer of incident.failure_reason. */
function close(incident: IncidentState, phase: "resolved" | "failed", failureReason?: string): AgentResult {
  incident.failureReason = failureReason;
  transition(incident, phase);
  return phase === "resolved" ? { status: "ok" } : { status: "failed", failureReason };
}

async function tick(): Promise<void> {
  if (stopped) return;
  emitAgent(null, "monitor", "started");
  const poll = await runMonitorPoll(agentCtx(null));
  emitAgent(
    null,
    "monitor",
    poll.status === "ok" ? "ok" : "failed",
    poll.detection ? `detected ${poll.detection.errorCount} error span(s) on ${poll.detection.route}` : (poll.failureReason ?? "clean")
  );
  if (poll.status !== "ok") {
    setTelemetryDegraded(true);
  } else {
    setTelemetryDegraded(false);
    if (poll.detection && poll.pollSpanContext) await runIncident(poll.detection, poll.pollSpanContext);
  }
  if (!stopped) timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
}

export function start(forceFlush: () => Promise<void>): void {
  flush = forceFlush;
  initWatermark(Date.now());
  demoApiEvents.on("state", () => emitSnapshot());
  demoApiEvents.on("notice", (n: DemoApiNotice) => {
    notice = n;
    console.error(`[supervisor] ${n.level}: ${n.message}`);
    emitSnapshot();
  });
  timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
}

export function stop(): void {
  stopped = true;
  if (timer) clearTimeout(timer);
}
