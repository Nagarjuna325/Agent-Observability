import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { withToolSpan } from "@agentops/otel";

export const MCP_URL = "http://localhost:8000/mcp";
const TOOL_TIMEOUT_MS = 10_000;

// Distinguishes a tool-level failure (server answered, isError / unparseable body)
// from a connection-level one — only the latter is worth a reconnect.
export class McpToolError extends Error {}

let client: Client | null = null;

async function openClient(): Promise<Client> {
  const c = new Client({ name: "agentops-agents", version: "0.1.0" }, { capabilities: {} });
  await c.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)));
  return c;
}

export async function connectMcp(): Promise<void> {
  client = await openClient();
}

export async function disconnectMcp(): Promise<void> {
  const c = client;
  client = null;
  if (c) await c.close().catch(() => undefined);
}

type ContentBlock = { type: string; text?: string };

async function invoke(toolName: string, args: Record<string, unknown>, span: { setAttribute(k: string, v: string | number): unknown }): Promise<unknown> {
  if (!client) throw new Error("MCP client is not connected");
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TOOL_TIMEOUT_MS);
  let raw: { content?: ContentBlock[]; isError?: boolean };
  try {
    raw = (await client.callTool({ name: toolName, arguments: args }, undefined, {
      signal: abort.signal,
      timeout: TOOL_TIMEOUT_MS,
    })) as { content?: ContentBlock[]; isError?: boolean };
  } finally {
    clearTimeout(timer);
  }

  const content = raw.content ?? [];
  const first = content[0]?.text ?? "";
  // Per MCP_SHAPES.md: tool errors are NOT JSON-RPC errors, they arrive as
  // result.isError with prose in content[0]. Check the flag before parsing.
  if (raw.isError) throw new McpToolError(`${toolName} isError: ${first.slice(0, 200)}`);

  // content[1..] is human-readable prose (pagination notes, "[Decisions applied]") —
  // advisory only, kept as a debug attribute rather than parsed.
  const note = content[1]?.text;
  if (note) span.setAttribute("mcp.response.note", note.slice(0, 200));

  try {
    return JSON.parse(first);
  } catch {
    throw new McpToolError(`${toolName} content[0].text was not JSON: ${first.slice(0, 200)}`);
  }
}

export function callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
  return withToolSpan(toolName, async (span) => {
    span.setAttribute("mcp.endpoint", MCP_URL);
    try {
      return await invoke(toolName, args, span);
    } catch (err) {
      if (err instanceof McpToolError) throw err;
      span.addEvent("mcp.reconnect", { reason: (err as Error).message.slice(0, 200) });
      await disconnectMcp();
      client = await openClient();
      return await invoke(toolName, args, span);
    }
  });
}
