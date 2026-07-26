export type AgentName = "monitor" | "diagnosis" | "fix" | "verify";
export type IncidentPhase = "detected" | "diagnosing" | "fixing" | "verifying" | "resolved" | "failed";
export type StageStatus = "idle" | "active" | "done" | "failed";

export const AGENTS: AgentName[] = ["monitor", "diagnosis", "fix", "verify"];

export type Hypothesis = {
  file: string;
  line: number;
  cause: string;
  evidence?: { traceId?: string; logSnippet?: string };
};

export type Incident = {
  id: string;
  phase: IncidentPhase;
  failureReason?: string;
  detectedAt: number;
  route: string;
  errorCount: number;
  exampleTraceId?: string;
  firstErrorAt?: number;
  lastErrorAt?: number;
  hypothesis?: Hypothesis;
  traceId?: string;
};

export type ToolCall = {
  agent: AgentName;
  tool: string;
  ok: boolean;
  durationMs: number;
  summary?: string;
  ts: number;
};

export type AgentDetail = { status: StageStatus; summary?: string; tools: ToolCall[] };
export type IncidentDetail = Record<AgentName, AgentDetail>;

export type Notice = { level: "warn" | "alert"; message: string };
export type DemoApi = { healthy: boolean; pid: number | null };

type SnapshotPayload = {
  activeIncident: Incident | null;
  recentIncidents?: Incident[];
  demoApi?: DemoApi;
  telemetryDegraded?: boolean;
  notice?: Notice | null;
  ts?: number;
};

export type SseEvent =
  | { type: "open" }
  | { type: "error" }
  | { type: "snapshot"; data: SnapshotPayload }
  | { type: "incident"; data: { id: string; phase: IncidentPhase; failureReason?: string; ts: number } }
  | { type: "agent"; data: { incidentId: string | null; agent: AgentName; status: "started" | "ok" | "failed"; summary?: string; ts: number } }
  | { type: "tool"; data: { incidentId: string | null; agent: AgentName; tool: string; ok: boolean; durationMs: number; summary?: string; ts: number } };

export type MonitorLoop = {
  polling: boolean;
  lastPollAt: number | null;
  lastStatus: "ok" | "failed" | null;
  lastSummary: string;
  cleanPolls: number;
  tools: ToolCall[];
};

export type State = {
  connected: boolean;
  everConnected: boolean;
  lastEventAt: number | null;
  activeIncident: Incident | null;
  recentIncidents: Incident[];
  demoApi: DemoApi | null;
  telemetryDegraded: boolean;
  notice: Notice | null;
  details: Record<string, IncidentDetail>;
  monitor: MonitorLoop;
};

export const initialState: State = {
  connected: false,
  everConnected: false,
  lastEventAt: null,
  activeIncident: null,
  recentIncidents: [],
  demoApi: null,
  telemetryDegraded: false,
  notice: null,
  details: {},
  monitor: { polling: false, lastPollAt: null, lastStatus: null, lastSummary: "", cleanPolls: 0, tools: [] },
};

const PHASE_RANK: Record<IncidentPhase, number> = {
  detected: 0,
  diagnosing: 1,
  fixing: 2,
  verifying: 3,
  resolved: 4,
  failed: 4,
};
const STATUS_RANK: Record<StageStatus, number> = { idle: 0, active: 1, done: 2, failed: 3 };

/** Monotonic: a duplicate or out-of-order event can never walk a stage backwards. */
function upgrade(current: StageStatus, next: StageStatus): StageStatus {
  return STATUS_RANK[next] > STATUS_RANK[current] ? next : current;
}

function isTerminal(phase: IncidentPhase): boolean {
  return phase === "resolved" || phase === "failed";
}

function emptyDetail(): IncidentDetail {
  return {
    monitor: { status: "idle", tools: [] },
    diagnosis: { status: "idle", tools: [] },
    fix: { status: "idle", tools: [] },
    verify: { status: "idle", tools: [] },
  };
}

/**
 * The phase alone implies how far the pipeline got, which is what lets a browser
 * that connects (or reconnects) mid-incident render a correct pipeline from the
 * snapshot without ever having seen the `agent` events that got it there.
 */
function applyPhase(detail: IncidentDetail, phase: IncidentPhase): IncidentDetail {
  const next: IncidentDetail = {
    monitor: { ...detail.monitor },
    diagnosis: { ...detail.diagnosis },
    fix: { ...detail.fix },
    verify: { ...detail.verify },
  };
  next.monitor.status = upgrade(next.monitor.status, "done");
  if (phase === "failed") {
    for (const a of AGENTS) if (next[a].status === "active") next[a].status = "failed";
    return next;
  }
  const rank = PHASE_RANK[phase];
  if (rank >= 1) next.diagnosis.status = upgrade(next.diagnosis.status, rank > 1 ? "done" : "active");
  if (rank >= 2) next.fix.status = upgrade(next.fix.status, rank > 2 ? "done" : "active");
  if (rank >= 3) next.verify.status = upgrade(next.verify.status, rank > 3 ? "done" : "active");
  return next;
}

function detectionSummary(incident: Incident): string {
  return `detected ${incident.errorCount} error span(s) on ${incident.route}`;
}

function detailFor(state: State, incident: Incident): IncidentDetail {
  const existing = state.details[incident.id];
  if (existing) return applyPhase(existing, incident.phase);
  // First sighting of this incident: Monitor's detecting poll was emitted with
  // incidentId null (it ran before the incident existed), so its evidence is
  // adopted from the loop bucket and its summary rebuilt from the incident itself.
  const fresh = applyPhase(emptyDetail(), incident.phase);
  fresh.monitor = { status: "done", summary: detectionSummary(incident), tools: state.monitor.tools.slice(0, 1) };
  return fresh;
}

function mergePhase(incident: Incident, phase: IncidentPhase, failureReason?: string): Incident {
  const reason = failureReason ?? incident.failureReason;
  if (isTerminal(incident.phase) || PHASE_RANK[phase] < PHASE_RANK[incident.phase]) {
    return reason === incident.failureReason ? incident : { ...incident, failureReason: reason };
  }
  return { ...incident, phase, failureReason: reason };
}

export function reduce(state: State, event: SseEvent): State {
  switch (event.type) {
    case "open":
      return { ...state, connected: true, everConnected: true };

    case "error":
      return { ...state, connected: false };

    case "snapshot": {
      const { activeIncident = null, recentIncidents = [], demoApi, telemetryDegraded, notice } = event.data;
      const details = { ...state.details };
      for (const incident of [activeIncident, ...recentIncidents]) {
        if (incident) details[incident.id] = detailFor(state, incident);
      }
      return {
        ...state,
        connected: true,
        everConnected: true,
        lastEventAt: Date.now(),
        activeIncident,
        recentIncidents,
        demoApi: demoApi ?? state.demoApi,
        telemetryDegraded: telemetryDegraded === true,
        notice: notice ?? null,
        details,
      };
    }

    case "incident": {
      const { id, phase, failureReason } = event.data;
      // An `incident` frame for an id with no record yet only happens if a snapshot
      // was missed; the detail entry still gets built, and the next snapshot fills
      // in the incident record itself.
      const base = state.details[id] ?? emptyDetail();
      return {
        ...state,
        lastEventAt: Date.now(),
        activeIncident:
          state.activeIncident?.id === id ? mergePhase(state.activeIncident, phase, failureReason) : state.activeIncident,
        recentIncidents: state.recentIncidents.map((i) => (i.id === id ? mergePhase(i, phase, failureReason) : i)),
        details: { ...state.details, [id]: applyPhase(base, phase) },
      };
    }

    case "agent": {
      const { incidentId, agent, status, summary, ts } = event.data;
      if (incidentId === null) {
        if (agent !== "monitor") return state;
        if (status === "started") return { ...state, lastEventAt: Date.now(), monitor: { ...state.monitor, polling: true } };
        const detected = typeof summary === "string" && summary.startsWith("detected");
        return {
          ...state,
          lastEventAt: Date.now(),
          monitor: {
            ...state.monitor,
            polling: false,
            lastPollAt: ts,
            lastStatus: status === "ok" ? "ok" : "failed",
            lastSummary: summary ?? "",
            cleanPolls: status === "ok" && !detected ? state.monitor.cleanPolls + 1 : 0,
          },
        };
      }
      const detail = state.details[incidentId] ?? emptyDetail();
      const stage = detail[agent];
      const nextStatus: StageStatus = status === "started" ? "active" : status === "ok" ? "done" : "failed";
      return {
        ...state,
        lastEventAt: Date.now(),
        details: {
          ...state.details,
          [incidentId]: {
            ...detail,
            [agent]: { ...stage, status: upgrade(stage.status, nextStatus), summary: summary || stage.summary },
          },
        },
      };
    }

    case "tool": {
      const { incidentId, agent, tool, ok, durationMs, summary, ts } = event.data;
      const call: ToolCall = { agent, tool, ok, durationMs, summary, ts };
      if (incidentId === null) {
        const tools = [call, ...state.monitor.tools.filter((t) => !(t.ts === ts && t.tool === tool))].slice(0, 4);
        return { ...state, lastEventAt: Date.now(), monitor: { ...state.monitor, tools } };
      }
      const detail = state.details[incidentId] ?? emptyDetail();
      const stage = detail[agent];
      if (stage.tools.some((t) => t.ts === ts && t.tool === tool)) return state;
      return {
        ...state,
        lastEventAt: Date.now(),
        details: {
          ...state.details,
          [incidentId]: { ...detail, [agent]: { ...stage, tools: [...stage.tools, call] } },
        },
      };
    }
  }
}
