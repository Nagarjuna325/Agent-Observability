import type { GoogleGenAI } from "@google/genai" with { "resolution-mode": "import" };
import { AgentName, recordLlmUsage, withAgentSpan } from "@agentops/otel";

// Free-tier quota is per model per day (`GenerateRequestsPerDayPerProjectPerModel`,
// 20/day for 3.5-flash) and each incident spends 2 calls, so a day of rehearsals
// exhausts one model while its siblings still have budget. Overridable so the
// presenter can hop models without a rebuild. Verified callable on this key
// 2026-07-26: gemini-3.6-flash, gemini-flash-latest, gemini-flash-lite-latest.
// Dead on this key: 2.5-flash / 2.5-flash-lite (404 "no longer available to new
// users"), 2.0-flash / 2.0-flash-lite (429, no free quota).
export const LLM_MODEL = process.env.GEMINI_MODEL ?? "gemini-3.6-flash";

// Only 3.5-flash accepts thinkingBudget:0; the others 400 on it. Where thinking
// can't be switched off it is drawn from maxOutputTokens, so the JSON answer needs
// headroom on top of the caller's budget or the response comes back empty at
// MAX_TOKENS with no text at all.
const THINKING_DISABLABLE = new Set(["gemini-3.5-flash"]);
const THINKING_HEADROOM_TOKENS = 3072;

export type LlmResult = { status: "ok" | "failed"; failureReason?: "llm_error"; text?: string };

let client: GoogleGenAI | null = null;

export function callLlm(
  agent: AgentName,
  opts: { system: string; user: string; maxTokens: number }
): Promise<LlmResult> {
  return withAgentSpan<LlmResult>(agent, "llm", async (span) => {
    // `@google/genai` ships a CJS runtime entry but only ESM type declarations
    // (the package is "type": "module"), so a static import won't type-check from
    // this CJS build — dynamic import is the only way in without going ESM-wide.
    if (!client) {
      const { GoogleGenAI } = await import("@google/genai");
      client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    }
    try {
      const thinkingOff = THINKING_DISABLABLE.has(LLM_MODEL);
      const response = await client.models.generateContent({
        model: LLM_MODEL,
        contents: opts.user,
        config: {
          systemInstruction: opts.system,
          temperature: 0,
          maxOutputTokens: thinkingOff ? opts.maxTokens : opts.maxTokens + THINKING_HEADROOM_TOKENS,
          responseMimeType: "application/json",
          ...(thinkingOff ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
        },
      });
      const usage = response.usageMetadata;
      recordLlmUsage(span, {
        model: LLM_MODEL,
        inputTokens: usage?.promptTokenCount ?? 0,
        outputTokens: usage?.candidatesTokenCount ?? 0,
      });
      span.setAttribute("gen_ai.response.stop_reason", response.candidates?.[0]?.finishReason ?? "");
      return { status: "ok", text: response.text ?? "" };
    } catch (err) {
      span.recordException(err as Error);
      return { status: "failed", failureReason: "llm_error" };
    }
  });
}
