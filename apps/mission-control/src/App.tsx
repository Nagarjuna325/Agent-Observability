import { useEffect, useReducer, useState } from "react";
import { AGENTS, initialState, reduce } from "./state";
import type { AgentName, Hypothesis, Incident, IncidentDetail, StageStatus, ToolCall } from "./state";

const SSE_URL = import.meta.env.VITE_SSE_URL ?? "http://localhost:4100/events";
const DEMO_API_URL = import.meta.env.VITE_DEMO_API_URL ?? "http://localhost:3000";
const TRIGGER_URL = `${DEMO_API_URL}/api/bugs/999999`;
// Monitor polls every 4s; the button stays locked past one full poll interval so a
// double-click can't queue a second incident before `activeIncident` shows up.
const TRIGGER_LOCK_MS = 8_000;

const AGENT_LABEL: Record<AgentName, string> = {
  monitor: "Monitor",
  diagnosis: "Diagnosis",
  fix: "Fix",
  verify: "Verify",
};
const AGENT_ROLE: Record<AgentName, string> = {
  monitor: "watches SigNoz for 5xx",
  diagnosis: "finds the root cause",
  fix: "patches + restarts",
  verify: "proves it is fixed",
};
const PHASE_LABEL: Record<string, string> = {
  detected: "Detected",
  diagnosing: "Diagnosing",
  fixing: "Fixing",
  verifying: "Verifying",
  resolved: "Resolved",
  failed: "Failed",
};

function formatDuration(ms: number): string {
  if (ms < 0) return "0.0s";
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}s`;
}

function formatClock(ts?: number): string {
  return ts ? new Date(ts).toLocaleTimeString() : "—";
}

/**
 * The orchestrator only puts the structured `hypothesis` into a snapshot, and the
 * next snapshot after Diagnosis lands is the one at incident close — so mid-run the
 * only carrier of file:line is the diagnosis agent's summary (`file:line — cause`).
 */
function currentHypothesis(incident: Incident | null, detail: IncidentDetail | null): Hypothesis | undefined {
  if (incident?.hypothesis) return incident.hypothesis;
  const summary = detail?.diagnosis.summary;
  const m = summary ? /^(.+?):(\d+)\s*[—-]\s*([\s\S]+)$/.exec(summary) : null;
  return m ? { file: m[1], line: Number(m[2]), cause: m[3] } : undefined;
}

function ToolRow({ call }: { call: ToolCall }) {
  return (
    <div className="tool">
      <span className={call.ok ? "tool-badge ok" : "tool-badge fail"}>{call.ok ? "OK" : "FAIL"}</span>
      <span className="tool-name">{call.tool}</span>
      <span className="tool-ms">{call.durationMs}ms</span>
      {call.summary ? <span className="tool-summary">{call.summary}</span> : null}
    </div>
  );
}

function StageCard({
  agent,
  status,
  summary,
  tools,
  index,
}: {
  agent: AgentName;
  status: StageStatus;
  summary?: string;
  tools: ToolCall[];
  index: number;
}) {
  return (
    <div className={`stage stage-${status}`}>
      <div className="stage-head">
        <span className="stage-index">{index + 1}</span>
        <span className="stage-name">{AGENT_LABEL[agent]}</span>
        <span className={`stage-status status-${status}`}>{status}</span>
      </div>
      <div className="stage-role">{AGENT_ROLE[agent]}</div>
      {summary ? <div className="stage-summary">{summary}</div> : null}
      {tools.length > 0 ? (
        <div className="stage-tools">
          {tools.map((t) => (
            <ToolRow key={`${t.tool}-${t.ts}`} call={t} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default function App() {
  const [state, dispatch] = useReducer(reduce, initialState);
  const [now, setNow] = useState(Date.now());
  const [triggerNote, setTriggerNote] = useState<string | null>(null);
  const [triggerLockedUntil, setTriggerLockedUntil] = useState(0);

  useEffect(() => {
    const es = new EventSource(SSE_URL);
    es.onopen = () => dispatch({ type: "open" });
    es.onerror = () => dispatch({ type: "error" });
    es.addEventListener("snapshot", (e) => dispatch({ type: "snapshot", data: JSON.parse((e as MessageEvent).data) }));
    es.addEventListener("incident", (e) => dispatch({ type: "incident", data: JSON.parse((e as MessageEvent).data) }));
    es.addEventListener("agent", (e) => dispatch({ type: "agent", data: JSON.parse((e as MessageEvent).data) }));
    es.addEventListener("tool", (e) => dispatch({ type: "tool", data: JSON.parse((e as MessageEvent).data) }));
    return () => es.close();
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, []);

  const active = state.activeIncident;
  const focus: Incident | null = active ?? state.recentIncidents[0] ?? null;
  const detail: IncidentDetail | null = focus ? (state.details[focus.id] ?? null) : null;
  const hypothesis = currentHypothesis(focus, detail);
  const closed = state.recentIncidents.filter((i) => i.id !== active?.id);
  const demoApiHealthy = state.demoApi?.healthy === true;
  const locked = now < triggerLockedUntil;
  const triggerDisabled = active !== null || !demoApiHealthy || locked;

  async function trigger() {
    setTriggerLockedUntil(Date.now() + TRIGGER_LOCK_MS);
    setTriggerNote("Fired GET /api/bugs/999999 — expecting a 500. Monitor polls every 4s.");
    try {
      // no-cors: the response is meant to be a 500 and we never read it. This keeps
      // an opaque/blocked response from surfacing as a UI failure — the real signal
      // comes back through the agents' SSE stream, not from this fetch.
      await fetch(TRIGGER_URL, { mode: "no-cors", cache: "no-store" });
    } catch {
      setTriggerNote("Could not reach demo-api on :3000 — is the agents process running?");
    }
  }

  const monitorIdleLine = state.monitor.lastStatus
    ? `last poll ${formatClock(state.monitor.lastPollAt ?? undefined)} · ${state.monitor.lastSummary || "clean"} · ${state.monitor.cleanPolls} clean in a row`
    : "waiting for the first poll…";

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-main">AgentOps</span>
          <span className="brand-sub">Mission Control</span>
        </div>
        <div className="pills">
          <span className={state.connected ? "pill ok" : "pill fail"}>
            SSE {state.connected ? "connected" : state.everConnected ? "reconnecting…" : "connecting…"}
          </span>
          <span className={demoApiHealthy ? "pill ok" : "pill fail"}>
            demo-api {demoApiHealthy ? "healthy" : "down"}
            {state.demoApi?.pid ? ` · pid ${state.demoApi.pid}` : ""}
          </span>
          <span className={state.telemetryDegraded ? "pill warn" : "pill muted"}>
            telemetry {state.telemetryDegraded ? "degraded" : "ok"}
          </span>
        </div>
        <button className="trigger" onClick={() => void trigger()} disabled={triggerDisabled}>
          Trigger Incident
        </button>
      </header>

      {state.notice ? <div className={`notice notice-${state.notice.level}`}>{state.notice.level}: {state.notice.message}</div> : null}
      {triggerNote && !active ? <div className="notice notice-info">{triggerNote}</div> : null}
      {triggerDisabled && !active && !demoApiHealthy ? (
        <div className="notice notice-alert">demo-api is not healthy — the trigger is disabled until it comes back.</div>
      ) : null}

      <section className={active ? "incident-bar live" : "incident-bar"}>
        {focus ? (
          <>
            <span className="incident-id">{focus.id}</span>
            <span className={`phase phase-${focus.phase}`}>{PHASE_LABEL[focus.phase] ?? focus.phase}</span>
            <span className="incident-elapsed">
              {active ? formatDuration(now - focus.detectedAt) : formatDuration((focus.lastErrorAt ?? focus.detectedAt) - focus.detectedAt)}
              {active ? " elapsed" : " (closed)"}
            </span>
            <span className="incident-route">{focus.route}</span>
            {focus.failureReason ? <span className="failure-reason">{focus.failureReason}</span> : null}
          </>
        ) : (
          <span className="incident-idle">No incident — Monitor is watching</span>
        )}
        <span className="monitor-loop">{monitorIdleLine}</span>
      </section>

      <section className="pipeline">
        {AGENTS.map((agent, i) => (
          <StageCard
            key={agent}
            agent={agent}
            index={i}
            status={detail ? detail[agent].status : "idle"}
            summary={detail ? detail[agent].summary : undefined}
            tools={detail ? detail[agent].tools : []}
          />
        ))}
      </section>

      {hypothesis ? (
        <section className="hypothesis">
          <div className="hypothesis-label">Root cause named by the Diagnosis agent</div>
          <div className="hypothesis-loc">
            {hypothesis.file}:{hypothesis.line}
          </div>
          <div className="hypothesis-cause">{hypothesis.cause}</div>
          {hypothesis.evidence?.logSnippet ? <pre className="hypothesis-evidence">{hypothesis.evidence.logSnippet}</pre> : null}
        </section>
      ) : null}

      <section className="lower">
        <div className="panel">
          <h2>Before / After</h2>
          {focus ? (
            <div className="beforeafter">
              <div className="ba-col ba-before">
                <div className="ba-title">Before — what Monitor saw</div>
                <div className="ba-big">{focus.errorCount} error span(s)</div>
                <div className="ba-line">route {focus.route}</div>
                <div className="ba-line">first {formatClock(focus.firstErrorAt)} · last {formatClock(focus.lastErrorAt)}</div>
                <div className="ba-line mono">trace {focus.exampleTraceId ?? "—"}</div>
              </div>
              <div className="ba-col ba-after">
                <div className="ba-title">After — what Verify proved</div>
                <div className="ba-big">{detail?.verify.status === "done" ? "clean" : detail?.verify.status === "failed" ? "not clean" : "pending"}</div>
                <div className="ba-line">{detail?.verify.summary ?? "Verify has not reported yet."}</div>
                {focus.failureReason ? <div className="ba-line fail">failure: {focus.failureReason}</div> : null}
              </div>
            </div>
          ) : (
            <div className="empty">Nothing to compare yet — trigger an incident.</div>
          )}
        </div>

        <div className="panel">
          <h2>Recent incidents</h2>
          {closed.length === 0 ? (
            <div className="empty">No closed incidents yet.</div>
          ) : (
            <ul className="recent">
              {closed.map((i) => (
                <li key={i.id}>
                  <span className="incident-id small">{i.id}</span>
                  <span className={`phase small phase-${i.phase}`}>{PHASE_LABEL[i.phase] ?? i.phase}</span>
                  <span className="recent-detail">
                    {i.hypothesis ? `${i.hypothesis.file}:${i.hypothesis.line}` : i.route}
                    {i.failureReason ? ` · ${i.failureReason}` : ""}
                  </span>
                  <span className="recent-time">{formatClock(i.detectedAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
