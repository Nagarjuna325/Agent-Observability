// Creates or updates the version-controlled SigNoz dashboards + alert rule in
// infra/signoz/. Idempotent: objects are matched by title (dashboards) / alert name
// (rule), so re-running updates in place instead of duplicating.
//
//   node scripts/provision-signoz.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// Values in .env contain "=" (the SigNoz API key does), so split on the FIRST "=" only.
const env = Object.fromEntries(
  readFileSync(join(repoRoot, ".env"), "utf8")
    .split(/\r?\n/)
    .filter((line) => line.includes("=") && !line.trim().startsWith("#"))
    .map((line) => [line.slice(0, line.indexOf("=")).trim(), line.slice(line.indexOf("=") + 1).trim()])
);

const BASE = env.SIGNOZ_URL || "http://localhost:8080";
const KEY = env.SIGNOZ_API_KEY;
if (!KEY) {
  console.error("SIGNOZ_API_KEY missing from repo-root .env");
  process.exit(1);
}

// SigNoz serves its SPA on a catch-all, so an unknown route answers 200 + HTML.
// Every call goes through here so a non-JSON body is treated as failure, not success.
async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "SIGNOZ-API-KEY": KEY, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (res.ok && text === "") return null; // channel updates answer 204 No Content
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${method} ${path} → HTTP ${res.status}, non-JSON body: ${text.slice(0, 160)}`);
  }
  if (!res.ok || json.status !== "success") {
    throw new Error(`${method} ${path} → HTTP ${res.status} ${JSON.stringify(json).slice(0, 400)}`);
  }
  return json.data;
}

const failures = [];

for (const file of ["agent-fleet-health.json", "demo-api-health.json"]) {
  const dashboard = JSON.parse(readFileSync(join(repoRoot, "infra", "signoz", file), "utf8"));
  try {
    const existing = (await api("GET", "/api/v1/dashboards")).find((d) => d.data?.title === dashboard.title);
    if (existing) {
      await api("PUT", `/api/v1/dashboards/${existing.id}`, dashboard);
      console.log(`UPDATED dashboard "${dashboard.title}" (${existing.id}, ${dashboard.widgets.length} panels)`);
    } else {
      const created = await api("POST", "/api/v1/dashboards", dashboard);
      console.log(`CREATED dashboard "${dashboard.title}" (${created.id}, ${dashboard.widgets.length} panels)`);
    }
  } catch (err) {
    console.error(`FAILED  dashboard "${dashboard.title}": ${err.message}`);
    failures.push(file);
  }
}

// This SigNoz version rejects an alert rule whose threshold names a channel that
// doesn't exist ("channels: the following channels do not exist"), so the channel is
// a hard prerequisite of the rule, not an optional extra.
const channel = JSON.parse(readFileSync(join(repoRoot, "infra", "signoz", "notification-channel.json"), "utf8"));
try {
  const existing = (await api("GET", "/api/v1/channels")).find((c) => c.name === channel.name);
  if (existing) {
    await api("PUT", `/api/v1/channels/${existing.id}`, channel);
    console.log(`UPDATED channel "${channel.name}" (${existing.id})`);
  } else {
    const created = await api("POST", "/api/v1/channels", channel);
    console.log(`CREATED channel "${channel.name}" (${created.id})`);
  }
} catch (err) {
  console.error(`FAILED  channel "${channel.name}": ${err.message}`);
  failures.push("notification-channel.json");
}

const rule = JSON.parse(readFileSync(join(repoRoot, "infra", "signoz", "agent-failure-rate-alert.json"), "utf8"));
try {
  const existing = (await api("GET", "/api/v1/rules")).rules.find((r) => r.alert === rule.alert);
  if (existing) {
    await api("PUT", `/api/v1/rules/${existing.id}`, rule);
    console.log(`UPDATED alert rule "${rule.alert}" (${existing.id})`);
  } else {
    await api("POST", "/api/v1/rules", rule);
    console.log(`CREATED alert rule "${rule.alert}"`);
  }
} catch (err) {
  console.error(`FAILED  alert rule "${rule.alert}": ${err.message}`);
  failures.push("agent-failure-rate-alert.json");
}

if (failures.length > 0) {
  console.error(`\n${failures.length} object(s) failed to provision: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nAll SigNoz objects provisioned.");
