# AgentOps — self-healing software, observed end to end

A swarm of four autonomous agents **detects, diagnoses, fixes and verifies a real bug
in a real open-source application** — with no human in the loop — and emits every step
it takes as OpenTelemetry spans into [SigNoz](https://signoz.io).

The application being fixed is scaffolding. **The deliverable is the agents' own
observability**: you can watch them think, see every tool call they make, every token
they spend, and exactly why they failed when they fail.

---

## What it does

1. A request hits a bug-tracker API for a resource that doesn't exist. Instead of a
   clean `404`, a seeded defect makes it dereference `null` and return **`500`**.
2. **Monitor** notices — by querying SigNoz, the same way a human on-call engineer
   would. Nothing tells it directly.
3. **Diagnosis** pulls the error logs and trace from SigNoz and names the exact
   failing line: `src/index.ts:87`.
4. **Fix** reads that file through a sandboxed filesystem server, writes a minimal
   patch, and restarts the service — rolling back automatically if the patch won't boot.
5. **Verify** replays the original failing request, demands exactly `404`, and
   re-checks SigNoz for new errors.
6. The incident closes **resolved** — as one continuous trace of ~14 spans.

It generalises: seeded with a *completely different* bug it had never seen (a call to
a non-existent method, on a different route, at a different line), the swarm detected
it, named `src/index.ts:77` with the correct cause, fixed it, and verified it.

---

## Architecture at a glance

```
              ┌──────────────────────────────────────────┐
              │            SigNoz (:8080)                │
              │  traces · logs · metrics · dashboards    │
              └───────▲──────────────────────┬───────────┘
       telemetry      │                      │  queried as a TOOL
       (OTLP :4318)   │                      │  (MCP :8000)
              ┌───────┴────────┐     ┌───────▼──────────────────┐
              │   demo-api     │     │      agent swarm         │
              │  (BuggyBoard)  │◄────┤  Monitor → Diagnosis →   │
              │    :3000       │spawn│      Fix → Verify        │
              └────────────────┘kill └───────┬──────────────────┘
                                             │ SSE :4100
                                     ┌───────▼────────┐
                                     │ mission-control│
                                     │     :5174      │
                                     └────────────────┘
```

| Component | What it is |
|---|---|
| `apps/agents` | Orchestrator + the four agents. Owns and restarts the demo-api process. |
| `apps/demo-app` | [BuggyBoard](https://github.com/AutomationPanda/buggyboard-web-app) — a third-party MIT bug tracker. Not ours; its history predates this project. |
| `apps/mission-control` | Live pipeline viewer (React + Vite), fed by Server-Sent Events. |
| `packages/otel` | Shared OpenTelemetry setup and span wrappers. |
| `infra/signoz` | SigNoz deployment config, dashboards, and alert rule. |
| `scripts/` | Bug seeding/reset, dashboard provisioning, sandbox scope test. |

**Full walkthrough:** [ARCHITECTURE.md](ARCHITECTURE.md) ·
**Presenter runbook:** [DEMO.md](DEMO.md)

---

## Quick start

**Prerequisites:** Node 20+, Docker Desktop, a running SigNoz instance, and a
repo-root `.env` (gitignored):

```
GEMINI_API_KEY=...
SIGNOZ_API_KEY=...
SIGNOZ_UI_EMAIL=...
SIGNOZ_UI_PASSWORD=...
```

```bash
npm install
npm run build:all

npm run swarm             # terminal 1 — agents + demo-api (:3000, SSE :4100)
npm run mission-control   # terminal 2 — presenter UI  → http://localhost:5174
npm run buggyboard        # terminal 3 — the app's own UI → http://localhost:5173
```

Click **Trigger Incident** in mission-control, then watch. After ~30–60 seconds:

```bash
curl -i http://localhost:3000/api/bugs/999999      # 404 — was 500
git -C apps/demo-app diff -- backend/src/index.ts  # the agent's actual patch
```

**Reset between runs:** stop the swarm, confirm port 3000 is released, then
`npm run reseed`. Never reseed while the app is running.

| Command | Purpose |
|---|---|
| `npm run swarm` | Start the agent swarm (spawns demo-api itself) |
| `npm run mission-control` | Live pipeline UI on `:5174` |
| `npm run buggyboard` | The demo app's own UI on `:5173` |
| `npm run reseed` | Restore the seeded bug and database |
| `npm run verify-panels` | Prove every SigNoz dashboard panel returns live data |

---

## Observability model

One incident is **one trace**:

```
agent.orchestrator.incident            ← incident.id, phase events, link to detecting poll
├── agent.diagnosis.run
│   ├── gen_ai.tool.signoz_search_logs
│   ├── gen_ai.tool.signoz_get_trace_details
│   └── agent.diagnosis.llm            ← model + input/output tokens
├── agent.fix.run
│   ├── gen_ai.tool.read_text_file
│   ├── agent.fix.llm
│   ├── gen_ai.tool.write_file
│   └── agent.fix.restart
└── agent.verify.run
    ├── agent.verify.replay            ← http.method + status 404
    └── gen_ai.tool.signoz_search_traces
```

Failures are **differentiated on purpose** — `llm_error`, `wrong_hypothesis`,
`patch_broke_process`, `rollback_failed`, `telemetry_unavailable`,
`fs_mcp_unavailable` — so a dead telemetry pipeline can never be misread as an agent
reasoning badly. There are **no retries**: one attempt, and failures are loud.

Two dashboards ship with the project: **Agent Fleet Health** (per-agent latency, token
spend, tool-call breakdown, failure rate) and **Demo API Health**, plus an alert rule
on agent failure rate.

---

## Guardrails

An agent that edits source code and restarts a service needs hard limits. There are four:

**Least-privilege filesystem access.** The Fix agent reaches the codebase only through
a filesystem MCP server rooted at `apps/demo-app/backend`. It cannot resolve a path
outside that directory — including the repo-root `GROUND_TRUTH.md`, which records the
seeded defect for human reference. `scripts/fix-scope-test.mjs` asserts that relative
traversal, absolute paths, directory listing, and search are all refused.

**Pre-write validation.** A proposed patch must match its target exactly once, must
actually change something, and is capped at 300 characters per side and a 200-byte
net file delta. A violation aborts *before* anything is written.

**Automatic rollback.** The original bytes are captured before the write. If the
patched service fails its health check, they're restored and the service restarted
again — mechanical reversion, not a second guess at the fix.

**No retries.** One attempt per incident. Failures are surfaced with a specific
reason rather than being absorbed and retried.

## Known limitations

- Detection is error-shaped: a silent logic bug returning HTTP 200 would not be noticed.
- Verify's replay check is specific to the seeded bug; the general safety net is its
  "zero error spans after restart" check.
- One incident at a time, by design.
- Free-tier LLM quota (20 requests/day/model, 2 per incident) is the main operational
  constraint; `GEMINI_MODEL=<id>` switches models without a rebuild.

---

## Credits

Demo application: **BuggyBoard** by Andrew Knight
([AutomationPanda/buggyboard-web-app](https://github.com/AutomationPanda/buggyboard-web-app)),
MIT licensed — vendored unmodified apart from the deliberately seeded bug. The agents
fix code this project did not write.

Observability backend: **[SigNoz](https://signoz.io)** (open source, self-hosted via
[Foundry](https://github.com/SigNoz/foundry)).

AI assistance: Claude Code (Anthropic) was used during development.

