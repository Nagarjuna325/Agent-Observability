#!/usr/bin/env node
// Proves the Fix agent's filesystem MCP server cannot resolve anything outside
// apps/demo-app/backend (demo-integrity.md). Same command line as fsMcp.ts.
// Never prints the content of a file it was supposed to be refused.
import { createRequire } from "node:module";
import { existsSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const require = createRequire(import.meta.url);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixRoot = resolve(repoRoot, "apps/demo-app/backend");
const serverEntry = require.resolve("@modelcontextprotocol/server-filesystem/dist/index.js");
const answerKey = join(repoRoot, "GROUND_TRUTH.md");
const strayWrite = join(repoRoot, "scope-test-should-not-exist.txt");

const client = new Client({ name: "agentops-scope-test", version: "0.1.0" }, { capabilities: {} });
await client.connect(
  new StdioClientTransport({ command: process.execPath, args: [serverEntry, fixRoot], stderr: "ignore" })
);

async function call(tool, args) {
  try {
    const res = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 10_000 });
    return { ok: !res.isError, text: res.content?.[0]?.text ?? "" };
  } catch (err) {
    return { ok: false, text: err.message };
  }
}

let failures = 0;
function report(name, pass, detail) {
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function allowed(name, tool, args, expect) {
  const r = await call(tool, args);
  report(name, r.ok && expect(r.text), r.ok ? "" : r.text.slice(0, 160));
}

async function refused(name, tool, args) {
  const r = await call(tool, args);
  // Only the refusal message is ever printed, never the body it guarded.
  report(name, !r.ok, r.ok ? "SERVER RETURNED CONTENT" : r.text.slice(0, 120));
}

await allowed("read src/index.ts (relative, inside root)", "read_text_file", { path: "src/index.ts" }, (t) =>
  t.includes("/api/bugs/:id")
);
await allowed("read src/index.ts (absolute, inside root)", "read_text_file", { path: join(fixRoot, "src/index.ts") }, (t) =>
  t.includes("/api/bugs/:id")
);
await refused("read ../../../GROUND_TRUTH.md (relative traversal)", "read_text_file", { path: "../../../GROUND_TRUTH.md" });
await refused("read GROUND_TRUTH.md (absolute)", "read_text_file", { path: answerKey });
await refused("read repo-root package.json (absolute, outside root)", "read_text_file", { path: join(repoRoot, "package.json") });
await refused("read agents source (sibling app, outside root)", "read_text_file", { path: join(repoRoot, "apps/agents/src/agents.ts") });
await refused("list repo root", "list_directory", { path: repoRoot });
await refused("search repo root for GROUND_TRUTH.md", "search_files", { path: repoRoot, pattern: "GROUND_TRUTH.md" });
await refused("write outside root", "write_file", { path: strayWrite, content: "should never exist" });

if (existsSync(strayWrite)) {
  unlinkSync(strayWrite);
  report("no file created outside root", false, "stray file was created and has been removed");
} else {
  report("no file created outside root", true);
}

const dirs = await call("list_allowed_directories", {});
report("allowed directories are exactly the backend root", dirs.ok && dirs.text.trim().endsWith(fixRoot), dirs.text.trim().replace(/\n/g, " | "));

await client.close();
console.log(failures === 0 ? "\nALL SCOPE CHECKS PASSED" : `\n${failures} SCOPE CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
