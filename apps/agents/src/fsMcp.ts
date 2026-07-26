import * as path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { withToolSpan } from "@agentops/otel";

/** The Fix agent's entire visible universe (demo-integrity.md) — never widen this. */
export const FIX_ROOT = path.resolve(__dirname, "../../demo-app/backend");

const SERVER_ENTRY = require.resolve("@modelcontextprotocol/server-filesystem/dist/index.js");
const TOOL_TIMEOUT_MS = 10_000;

/** Server answered with isError (denied path, missing file) — not a transport fault. */
export class FsToolError extends Error {}

let client: Client | null = null;

async function openClient(): Promise<Client> {
  const transport = new StdioClientTransport({
    // No npx and no shell: cross-spawn gets argv as an array, so the space in the
    // repo path can't be re-split by cmd.exe.
    command: process.execPath,
    args: [SERVER_ENTRY, FIX_ROOT],
    stderr: "inherit",
  });
  // capabilities stays empty on purpose: advertising `roots` makes the server drop
  // its command-line allow-list and adopt whatever roots the client offers, which
  // would hand the answer key's directory back to the agent.
  const c = new Client({ name: "agentops-fix", version: "0.1.0" }, { capabilities: {} });
  await c.connect(transport);
  return c;
}

export async function connectFsMcp(): Promise<void> {
  try {
    client = await openClient();
  } catch {
    client = await openClient();
  }
}

export async function disconnectFsMcp(): Promise<void> {
  const c = client;
  client = null;
  if (c) await c.close().catch(() => undefined);
}

/** Absolute path inside the root, or null if the requested path escapes it. */
export function resolveInRoot(relativePath: string): string | null {
  const absolute = path.resolve(FIX_ROOT, relativePath);
  return absolute.startsWith(FIX_ROOT + path.sep) ? absolute : null;
}

export function callFsTool(toolName: string, args: Record<string, unknown>): Promise<string> {
  return withToolSpan(toolName, async (span) => {
    span.setAttributes({ "mcp.server": "filesystem", "mcp.root": FIX_ROOT });
    if (!client) throw new Error("filesystem MCP client is not connected");
    const raw = (await client.callTool({ name: toolName, arguments: args }, undefined, {
      timeout: TOOL_TIMEOUT_MS,
    })) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };

    const text = raw.content?.[0]?.text ?? "";
    if (raw.isError) throw new FsToolError(`${toolName}: ${text.slice(0, 300)}`);
    // Unlike the SigNoz server (mcp.ts), this one returns plain text — JSON-parsing
    // it here would mangle the source bytes we are about to patch.
    return text;
  });
}
