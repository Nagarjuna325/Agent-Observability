import { context, createContextKey, Span, SpanStatusCode, trace } from "@opentelemetry/api";

export type AgentName = "monitor" | "diagnosis" | "fix" | "verify" | "orchestrator";
export type AgentResult = { status: "ok" | "failed"; failureReason?: string; [k: string]: unknown };

const tracer = trace.getTracer("@agentops/otel");
const AGENT_NAME_KEY = createContextKey("agentops.agent.name");
const INCIDENT_ID_KEY = createContextKey("agentops.incident.id");

/** Every span opened inside `fn` — agent steps, MCP tools, LLM calls — is stamped
 *  with the incident id, so a dashboard can group a whole incident without walking
 *  the trace tree. */
export function withIncidentId<T>(incidentId: string, fn: () => Promise<T>): Promise<T> {
  return context.with(context.active().setValue(INCIDENT_ID_KEY, incidentId), fn);
}

function stampContextAttributes(span: Span): void {
  const incidentId = context.active().getValue(INCIDENT_ID_KEY);
  if (typeof incidentId === "string") span.setAttribute("incident.id", incidentId);
}

export function withAgentSpan<T extends AgentResult>(
  agent: AgentName,
  step: string,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  return tracer.startActiveSpan(`agent.${agent}.${step}`, (span) => {
    span.setAttribute("gen_ai.agent.name", agent);
    stampContextAttributes(span);
    return context.with(context.active().setValue(AGENT_NAME_KEY, agent), async () => {
      try {
        const result = await fn(span);
        if (result.status === "failed") {
          span.setStatus({ code: SpanStatusCode.ERROR, message: result.failureReason });
          if (result.failureReason) {
            span.setAttribute("incident.failure_reason", result.failureReason);
          }
        } else {
          // Explicit OK rather than the UNSET default: a resolved incident's root span
          // has to read as green in the waterfall, not merely "not an error".
          span.setStatus({ code: SpanStatusCode.OK });
        }
        span.end();
        return result;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
        span.end();
        throw err;
      }
    });
  });
}

export function withToolSpan<T>(toolName: string, fn: (span: Span) => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(`gen_ai.tool.${toolName}`, async (span) => {
    span.setAttribute("gen_ai.tool.name", toolName);
    stampContextAttributes(span);
    const agent = context.active().getValue(AGENT_NAME_KEY);
    if (typeof agent === "string") {
      span.setAttribute("gen_ai.agent.name", agent);
    }
    try {
      const result = await fn(span);
      span.end();
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      span.end();
      throw err;
    }
  });
}

export function recordLlmUsage(
  span: Span,
  u: { model: string; inputTokens: number; outputTokens: number }
): void {
  span.setAttributes({
    "gen_ai.request.model": u.model,
    "gen_ai.usage.input_tokens": u.inputTokens,
    "gen_ai.usage.output_tokens": u.outputTokens,
  });
}
