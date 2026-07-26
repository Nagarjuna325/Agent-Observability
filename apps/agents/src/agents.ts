import { SpanContext } from "@opentelemetry/api";
import { AgentName, AgentResult, withAgentSpan } from "@agentops/otel";
import { callTool } from "./mcp";
import { callLlm } from "./llm";
import { callFsTool, FsToolError, resolveInRoot } from "./fsMcp";
import {
  DEMO_API_PORT,
  getDemoApiState,
  lastExitWasAddrInUse,
  pollHealth,
  setManagedRestart,
  startDemoApi,
  stopDemoApi,
} from "./demoApi";

export const DEMO_SERVICE = "demo-api";
const MONITOR_LOOKBACK_MS = 10_000;
const MAX_LOG_BODIES = 5;
const LOG_BODY_CHARS = 2000;
const MAX_EVIDENCE_SPANS = 20;
const MAX_PATCH_CHARS = 300;
const MAX_BYTE_DELTA = 200;
const FIX_HEALTH_CAP_MS = 5_000;
const ROLLBACK_HEALTH_CAP_MS = 10_000;
const PORT_RELEASE_MS = 750;
const VERIFY_HEALTH_CAP_MS = 2_000;
const VERIFY_REPLAY_TIMEOUT_MS = 5_000;
const VERIFY_INGEST_POLL_MS = 3_000;
const VERIFY_INGEST_CAP_MS = 21_000;
const VERIFY_SPAN_LIMIT = 50;

export type ToolEvent = { agent: AgentName; tool: string; ok: boolean; durationMs: number; summary: string };
export type AgentCtx = { onTool: (e: ToolEvent) => void };

export type Detection = {
  firstErrorAt: number;
  lastErrorAt: number;
  errorCount: number;
  exampleTraceId: string;
  route: string;
};

export type MonitorResult = AgentResult & { detection?: Detection; pollSpanContext?: SpanContext };

export type Hypothesis = {
  file: string;
  line: number;
  cause: string;
  evidence: { traceId: string; logSnippet: string };
};

export type DiagnosisResult = AgentResult & { hypothesis?: Hypothesis };

// --- SigNoz row shapes, per apps/agents/MCP_SHAPES.md ---------------------------

type Row = { data: Record<string, unknown>; timestamp: string };

function rows(payload: unknown): Row[] {
  const results = (payload as { data?: { data?: { results?: Array<{ rows?: Row[] }> } } })?.data?.data?.results;
  return results?.[0]?.rows ?? [];
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

async function tracked<T>(agent: AgentName, ctx: AgentCtx, tool: string, args: Record<string, unknown>, summarize: (rows: Row[]) => string): Promise<Row[]> {
  const started = Date.now();
  try {
    const parsed = rows(await callTool(tool, args));
    ctx.onTool({ agent, tool, ok: true, durationMs: Date.now() - started, summary: summarize(parsed) });
    return parsed;
  } catch (err) {
    ctx.onTool({ agent, tool, ok: false, durationMs: Date.now() - started, summary: (err as Error).message.slice(0, 200) });
    throw err;
  }
}

// --- Monitor (zero LLM calls) ---------------------------------------------------

// Absolute-timestamp watermark, never a relative window: SigNoz still holds 500s
// from earlier rehearsals (architecture.md decision 5).
let watermark = 0;

export function initWatermark(at: number): void {
  watermark = at;
}

/** Monotonic — an incident close may only ever push the watermark forward. */
export function jumpWatermark(at: number): void {
  watermark = Math.max(watermark, at);
}

export function getWatermark(): number {
  return watermark;
}

export function runMonitorPoll(ctx: AgentCtx): Promise<MonitorResult> {
  return withAgentSpan<MonitorResult>("monitor", "poll", async (span) => {
    const start = watermark;
    const end = Date.now();
    const pollSpanContext = span.spanContext();
    span.setAttributes({ "monitor.window_start_ms": start, "monitor.window_end_ms": end });

    let errorRows: Row[];
    try {
      errorRows = await tracked("monitor", ctx, "signoz_search_traces", {
        service: DEMO_SERVICE,
        error: true,
        start,
        end,
        limit: 10,
        searchContext: "Monitor agent poll: any error span from demo-api since the last handled incident",
      }, (r) => `${r.length} error span(s)`);
    } catch (err) {
      span.recordException(err as Error);
      return { status: "failed", failureReason: "telemetry_unavailable", pollSpanContext };
    }

    span.setAttribute("monitor.error_span_count", errorRows.length);
    if (errorRows.length === 0) {
      jumpWatermark(end - MONITOR_LOOKBACK_MS);
      return { status: "ok", pollSpanContext };
    }

    const stamps = errorRows.map((r) => Date.parse(str(r.data.timestamp) || r.timestamp));
    const server = errorRows.find((r) => str(r.data["http.route"]) !== "") ?? errorRows[0];
    const detection: Detection = {
      firstErrorAt: Math.min(...stamps),
      lastErrorAt: Math.max(...stamps),
      errorCount: errorRows.length,
      exampleTraceId: str(server.data.trace_id),
      route: str(server.data["http.route"]) || str(server.data.name),
    };
    span.setAttributes({
      "incident.route": detection.route,
      "incident.example_trace_id": detection.exampleTraceId,
      "incident.error_count": detection.errorCount,
    });
    return { status: "ok", detection, pollSpanContext };
  });
}

// --- Diagnosis ------------------------------------------------------------------

const PROMPT_INVARIANT =
  "API contract: requests for resources that don't exist must return 404 — a 5xx on a missing resource is always a bug.";

const DIAGNOSIS_SYSTEM = [
  "You are the Diagnosis agent in an autonomous SDLC swarm. You are given telemetry evidence",
  "(error logs and trace spans) collected from a running Express + TypeScript service and must",
  "name the single source-file line that causes the failure.",
  "",
  PROMPT_INVARIANT,
  "",
  "Rules:",
  "- Reason only from the evidence provided. Do not invent files, lines, or stack frames.",
  "- The file:line you report must come from the first stack frame inside the application's own",
  "  source (paths containing /backend/src/), not from express or @opentelemetry internals.",
  "- Reply with STRICT JSON and nothing else: no markdown fences, no commentary.",
  '- Schema: {"status":"ok","hypothesis":{"file":"<path as it appears in the stack frame>",',
  '  "line":<integer>,"cause":"<one or two sentences>","evidence":{"traceId":"<trace id>",',
  '  "logSnippet":"<the single most relevant log line>"}}}',
  '- If the evidence is insufficient to name a file and line, reply {"status":"failed"}.',
].join("\n");

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…[truncated]` : s;
}

/** Stack frames carry absolute Windows paths; collapse to a repo-relative POSIX path. */
export function normalizeFilePath(file: string): string {
  const match = /[\\/]backend[\\/](.+)$/.exec(file);
  return (match ? match[1] : file).replace(/\\/g, "/");
}

function stripFence(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  return (fenced ? fenced[1] : text).trim();
}

export function runDiagnosis(
  input: { windowStart: number; windowEnd: number; exampleTraceId: string; route: string; errorCount: number },
  ctx: AgentCtx
): Promise<DiagnosisResult> {
  return withAgentSpan<DiagnosisResult>("diagnosis", "run", async (span) => {
    span.setAttributes({
      "incident.route": input.route,
      "incident.example_trace_id": input.exampleTraceId,
      "incident.error_count": input.errorCount,
    });

    let logRows: Row[];
    let spanRows: Row[];
    try {
      logRows = await tracked("diagnosis", ctx, "signoz_search_logs", {
        service: DEMO_SERVICE,
        severity: "ERROR",
        start: input.windowStart,
        end: input.windowEnd,
        limit: MAX_LOG_BODIES,
        searchContext: `Diagnosis agent: ERROR logs for demo-api around the failing ${input.route} requests`,
      }, (r) => `${r.length} ERROR log(s)`);
      spanRows = await tracked("diagnosis", ctx, "signoz_get_trace_details", {
        traceId: input.exampleTraceId,
        includeSpans: true,
        start: input.windowStart,
        end: input.windowEnd,
        searchContext: `Diagnosis agent: full span tree for the example failing trace ${input.exampleTraceId}`,
      }, (r) => `${r.length} span(s) in trace`);
    } catch (err) {
      span.recordException(err as Error);
      return { status: "failed", failureReason: "telemetry_unavailable" };
    }

    const logBodies = logRows.slice(0, MAX_LOG_BODIES).map((r) => truncate(str(r.data.body), LOG_BODY_CHARS));
    // The 500 lives on the Server span while the TypeError message lives on its
    // Internal child (MCP_SHAPES.md §1) — both must reach the model.
    const evidenceSpans = spanRows.slice(0, MAX_EVIDENCE_SPANS).map((r) => ({
      name: str(r.data.name),
      status: str(r.data.status_code_string),
      durationMs: Math.round(((num(r.data.duration_nano) ?? 0) / 1e6) * 1000) / 1000,
      httpStatus: num(r.data["http.response.status_code"]),
      statusMessage: str(r.data.status_message),
    }));
    span.setAttributes({ "diagnosis.log_count": logBodies.length, "diagnosis.span_count": evidenceSpans.length });

    const user = [
      `Service: ${DEMO_SERVICE}`,
      `Failing route: ${input.route}`,
      `Error spans observed: ${input.errorCount}`,
      `Example trace id: ${input.exampleTraceId}`,
      "",
      "ERROR log bodies:",
      JSON.stringify(logBodies, null, 2),
      "",
      "Spans in the example trace:",
      JSON.stringify(evidenceSpans, null, 2),
    ].join("\n");

    const llm = await callLlm("diagnosis", { system: DIAGNOSIS_SYSTEM, user, maxTokens: 1024 });
    if (llm.status === "failed" || !llm.text) return { status: "failed", failureReason: "llm_error" };

    let parsed: { status?: string; hypothesis?: Partial<Hypothesis> };
    try {
      parsed = JSON.parse(stripFence(llm.text));
    } catch {
      span.setAttribute("diagnosis.unparseable_output", llm.text.slice(0, 200));
      return { status: "failed", failureReason: "llm_error" };
    }

    const h = parsed.hypothesis;
    const line = Number(h?.line);
    if (parsed.status !== "ok" || !h?.file || !Number.isInteger(line) || line <= 0) {
      return { status: "failed", failureReason: "llm_error" };
    }

    const hypothesis: Hypothesis = {
      file: normalizeFilePath(h.file),
      line,
      cause: str(h.cause),
      evidence: {
        traceId: str(h.evidence?.traceId) || input.exampleTraceId,
        logSnippet: truncate(str(h.evidence?.logSnippet), LOG_BODY_CHARS),
      },
    };
    span.setAttributes({ "diagnosis.file": hypothesis.file, "diagnosis.line": hypothesis.line });
    return { status: "ok", hypothesis };
  });
}

// --- Fix ------------------------------------------------------------------------

/** Verify asserts against the exact process Fix started, so `restart` is part of its contract. */
export type FixRestart = { pid: number | null; restartedAt: number };

export type FixResult = AgentResult & {
  rationale?: string;
  patch?: { search: string; replace: string };
  rolledBack?: boolean;
  restart?: FixRestart;
};

const FIX_SYSTEM = [
  "You are the Fix agent in an autonomous SDLC swarm. You are given a root-cause hypothesis for a",
  "running Express + TypeScript service and the full current contents of the suspect source file.",
  "Produce the smallest edit that removes the defect.",
  "",
  PROMPT_INVARIANT,
  "",
  "Rules:",
  '- Output ONE search/replace pair. "search" must be an EXACT substring of the file contents shown',
  "  below and must occur exactly ONCE in that file — include just enough surrounding text to be unique.",
  `- "search" and "replace" are each at most ${MAX_PATCH_CHARS} characters, and the patched file must be`,
  `  within ${MAX_BYTE_DELTA} bytes of the original. Fix the defect only: no refactoring, no added`,
  "  comments, no logging, no extra error handling, no reformatting of unrelated lines.",
  "- Keep the surrounding indentation and code style exactly as it appears.",
  "- Reply with STRICT JSON and nothing else: no markdown fences, no commentary.",
  '- Schema: {"status":"ok","search":"<exact existing text>","replace":"<replacement text>",',
  '  "rationale":"<one or two sentences>"}',
  '- If you cannot produce a safe minimal edit from what you were given, reply {"status":"failed"}.',
].join("\n");

async function trackedFs(ctx: AgentCtx, tool: string, args: Record<string, unknown>, summarize: (text: string) => string): Promise<string> {
  const started = Date.now();
  try {
    const text = await callFsTool(tool, args);
    ctx.onTool({ agent: "fix", tool, ok: true, durationMs: Date.now() - started, summary: summarize(text) });
    return text;
  } catch (err) {
    ctx.onTool({ agent: "fix", tool, ok: false, durationMs: Date.now() - started, summary: (err as Error).message.slice(0, 200) });
    throw err;
  }
}

type RestartResult = AgentResult & { healthy: boolean; pidBefore: number | null; pidAfter: number | null; restartedAt: number };

function fixRestart(step: "restart" | "rollback_restart", healthCapMs: number): Promise<RestartResult> {
  return withAgentSpan<RestartResult>("fix", step, async (span) => {
    const pidBefore = getDemoApiState().pid;
    await stopDemoApi();
    // Stamped per spawn attempt: Verify's telemetry window starts here, and a window
    // that opened before the surviving process existed would sweep in the old one's spans.
    let restartedAt = Date.now();
    let healthy = await startDemoApi(`fix_${step}`, healthCapMs);
    if (!healthy && lastExitWasAddrInUse()) {
      span.setAttribute("fix.eaddrinuse_retry", true);
      await stopDemoApi();
      await new Promise((r) => setTimeout(r, PORT_RELEASE_MS));
      restartedAt = Date.now();
      healthy = await startDemoApi(`fix_${step}_retry`, healthCapMs);
    }
    const pidAfter = getDemoApiState().pid;
    span.setAttributes({
      "fix.pid_before": pidBefore ?? -1,
      "fix.pid_after": pidAfter ?? -1,
      "fix.restart_healthy": healthy,
      "fix.restarted_at_ms": restartedAt,
    });
    // A health check that passed against the old process would validate code that was
    // never loaded, so the pid must actually have changed.
    const restarted = healthy && pidAfter !== null && pidAfter !== pidBefore;
    return { status: restarted ? "ok" : "failed", healthy, pidBefore, pidAfter, restartedAt };
  });
}

export function runFix(hypothesis: Hypothesis, ctx: AgentCtx): Promise<FixResult> {
  return withAgentSpan<FixResult>("fix", "run", async (span) => {
    span.setAttributes({ "fix.file": hypothesis.file, "fix.line": hypothesis.line });

    const absolutePath = resolveInRoot(hypothesis.file);
    if (!absolutePath) {
      span.setAttribute("fix.guard_violation", "path_outside_root");
      return { status: "failed", failureReason: "wrong_hypothesis" };
    }

    let original: string;
    try {
      original = await trackedFs(ctx, "read_text_file", { path: absolutePath }, (t) => `${t.length} chars read`);
    } catch (err) {
      span.recordException(err as Error);
      return { status: "failed", failureReason: err instanceof FsToolError ? "wrong_hypothesis" : "fs_mcp_unavailable" };
    }

    const eol = original.includes("\r\n") ? "\r\n" : "\n";
    // The model answers in JSON, where newlines are always \n, but this checkout is
    // CRLF. Matching or writing raw would either miss every multi-line search or
    // leave mixed endings, and the reseed hash check plus stack-trace line numbers
    // both depend on byte-for-byte fidelity.
    const toFileEol = (s: string) => s.replace(/\r\n/g, "\n").replace(/\n/g, eol);
    const lineText = original.split(/\r?\n/)[hypothesis.line - 1] ?? "";

    const user = [
      `File: ${hypothesis.file}`,
      `Suspect line ${hypothesis.line}: ${lineText}`,
      `Root cause reported by the Diagnosis agent: ${hypothesis.cause}`,
      `Observed error log: ${hypothesis.evidence.logSnippet}`,
      "",
      `Full current contents of ${hypothesis.file}:`,
      original,
    ].join("\n");

    const llm = await callLlm("fix", { system: FIX_SYSTEM, user, maxTokens: 1024 });
    if (llm.status === "failed" || !llm.text) return { status: "failed", failureReason: "llm_error" };

    let parsed: { status?: string; search?: string; replace?: string; rationale?: string };
    try {
      parsed = JSON.parse(stripFence(llm.text));
    } catch {
      span.setAttributes({ "fix.guard_violation": "unparseable_output", "fix.unparseable_output": llm.text.slice(0, 200) });
      return { status: "failed", failureReason: "llm_error" };
    }

    const search = toFileEol(str(parsed.search));
    const modelReplace = toFileEol(str(parsed.replace));
    const rationale = str(parsed.rationale);
    const occurrences = search === "" ? 0 : original.split(search).length - 1;
    const applied = (replacement: string) => original.replace(search, () => replacement);
    const guard =
      parsed.status !== "ok" || search === "" ? "malformed_output"
      : search.length > MAX_PATCH_CHARS || modelReplace.length > MAX_PATCH_CHARS ? "patch_too_long"
      : search === modelReplace ? "no_op_patch"
      : occurrences === 0 ? "search_not_found"
      : occurrences > 1 ? "search_ambiguous"
      : Math.abs(Buffer.byteLength(applied(modelReplace)) - Buffer.byteLength(original)) > MAX_BYTE_DELTA ? "byte_delta_too_large"
      : null;
    if (guard) {
      span.setAttribute("fix.guard_violation", guard);
      return { status: "failed", failureReason: "llm_error" };
    }

    // Test hook: corrupts a patch that has ALREADY cleared the guards, so the
    // rollback path can be exercised on demand without also tripping validation.
    // Never set this outside a rollback test.
    const forceBad = process.env.AGENTS_FIX_FORCE_BAD_PATCH === "1";
    const replace = forceBad ? `${modelReplace}${eol})))` : modelReplace;
    span.setAttributes({
      "fix.forced_bad_patch": forceBad,
      "fix.search": search.slice(0, MAX_PATCH_CHARS),
      "fix.replace": replace.slice(0, MAX_PATCH_CHARS),
      "fix.rationale": rationale.slice(0, 500),
    });

    setManagedRestart(true);
    try {
      await trackedFs(ctx, "write_file", { path: absolutePath, content: applied(replace) }, () => "patch written");
      const restart = await fixRestart("restart", FIX_HEALTH_CAP_MS);
      if (restart.status === "ok") {
        return {
          status: "ok",
          rationale,
          patch: { search, replace },
          restart: { pid: restart.pidAfter, restartedAt: restart.restartedAt },
        };
      }

      await trackedFs(ctx, "write_file", { path: absolutePath, content: original }, () => "original bytes restored");
      const rollback = await fixRestart("rollback_restart", ROLLBACK_HEALTH_CAP_MS);
      span.setAttribute("fix.rolled_back", true);
      return rollback.status === "ok"
        ? { status: "failed", failureReason: "patch_broke_process", rolledBack: true, rationale }
        : { status: "failed", failureReason: "rollback_failed", rolledBack: true, rationale };
    } catch (err) {
      span.recordException(err as Error);
      return { status: "failed", failureReason: "fs_mcp_unavailable" };
    } finally {
      setManagedRestart(false);
    }
  });
}

// --- Verify (zero LLM calls) ----------------------------------------------------

export type VerifyResult = AgentResult & {
  replayStatus?: number;
  spanCount?: number;
  errorSpanCount?: number;
  summary?: string;
};

export const REPLAY_URL = `http://localhost:${DEMO_API_PORT}/api/bugs/999999`;

type ReplayResult = AgentResult & { httpStatus: number };

/** A direct HTTP action, not an MCP call — `agent.verify.replay`, never `gen_ai.tool.*`. */
function replayTrigger(): Promise<ReplayResult> {
  return withAgentSpan<ReplayResult>("verify", "replay", async (span) => {
    span.setAttributes({ "http.request.method": "GET", "url.full": REPLAY_URL });
    let httpStatus = 0;
    try {
      const res = await fetch(REPLAY_URL, { signal: AbortSignal.timeout(VERIFY_REPLAY_TIMEOUT_MS) });
      httpStatus = res.status;
      await res.arrayBuffer();
    } catch (err) {
      span.recordException(err as Error);
    }
    span.setAttribute("http.response.status_code", httpStatus);
    return httpStatus === 404
      ? { status: "ok", httpStatus }
      : { status: "failed", failureReason: "wrong_hypothesis", httpStatus };
  });
}

export function runVerify(restart: FixRestart, ctx: AgentCtx): Promise<VerifyResult> {
  return withAgentSpan<VerifyResult>("verify", "run", async (span) => {
    const healthy = await pollHealth(VERIFY_HEALTH_CAP_MS);
    const pid = getDemoApiState().pid;
    span.setAttributes({
      "verify.healthy": healthy,
      "verify.pid_expected": restart.pid ?? -1,
      "verify.pid_actual": pid ?? -1,
      "verify.restart_window_start_ms": restart.restartedAt,
    });
    // A pid other than Fix's means the supervisor respawned underneath us, so every
    // later check would be validating a process Fix never started.
    if (!healthy || pid === null || pid !== restart.pid) {
      return {
        status: "failed",
        failureReason: "patch_broke_process",
        summary: healthy ? `pid ${pid} is not Fix's restarted pid ${restart.pid}` : "demo-api is not healthy",
      };
    }

    // A 200 on a missing resource is the cosmetic-fix loophole this check exists to
    // close, so nothing short of an exact 404 counts.
    const replay = await replayTrigger();
    span.setAttribute("verify.replay_status", replay.httpStatus);
    if (replay.status !== "ok") {
      return {
        status: "failed",
        failureReason: "wrong_hypothesis",
        replayStatus: replay.httpStatus,
        summary: `replay returned ${replay.httpStatus || "no response"}, expected 404`,
      };
    }

    // SigNoz needs ~5-10s to make spans queryable (measured: a flat 5s wait lost the
    // race in the first live gate), so poll the SAME fixed window until it is
    // non-empty or the cap expires — pollHealth applied to telemetry. The zero-error
    // assert below still evaluates exactly once, on the window's final contents.
    let spanRows: Row[] = [];
    const ingestDeadline = Date.now() + VERIFY_INGEST_CAP_MS;
    try {
      // Deliberately unfiltered: "no error spans" is only meaningful alongside proof
      // that spans are arriving at all.
      do {
        await new Promise((r) => setTimeout(r, VERIFY_INGEST_POLL_MS));
        spanRows = await tracked("verify", ctx, "signoz_search_traces", {
          service: DEMO_SERVICE,
          start: restart.restartedAt,
          end: Date.now(),
          limit: VERIFY_SPAN_LIMIT,
          searchContext: "Verify agent: all demo-api spans since the Fix agent restarted it — expecting the 404 replay and zero errors",
        }, (r) => `${r.length} span(s) since restart`);
      } while (spanRows.length === 0 && Date.now() < ingestDeadline);
    } catch (err) {
      span.recordException(err as Error);
      return { status: "failed", failureReason: "telemetry_unavailable", replayStatus: replay.httpStatus, summary: "signoz_search_traces failed" };
    }

    const errorRows = spanRows.filter((r) => r.data.has_error === true || str(r.data.status_code_string) === "Error");
    span.setAttributes({ "verify.span_count": spanRows.length, "verify.error_span_count": errorRows.length });

    // The replay above guarantees a span, so an empty window means the pipeline is
    // dead — not that the service is clean.
    if (spanRows.length === 0) {
      return {
        status: "failed",
        failureReason: "telemetry_unavailable",
        replayStatus: replay.httpStatus,
        spanCount: 0,
        summary: "no demo-api spans since the restart — telemetry pipeline is not reporting",
      };
    }
    if (errorRows.length > 0) {
      return {
        status: "failed",
        failureReason: "wrong_hypothesis",
        replayStatus: replay.httpStatus,
        spanCount: spanRows.length,
        errorSpanCount: errorRows.length,
        summary: `${errorRows.length} error span(s) still arriving after the patch`,
      };
    }

    return {
      status: "ok",
      replayStatus: replay.httpStatus,
      spanCount: spanRows.length,
      errorSpanCount: 0,
      summary: `replay 404, ${spanRows.length} span(s) since restart, 0 errors`,
    };
  });
}
