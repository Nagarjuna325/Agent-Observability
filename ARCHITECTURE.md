# AgentOps — how it works, end to end

A four-agent swarm detects, diagnoses, fixes and verifies a real bug in a real
open-source app **without a human in the loop** — and every step the agents take is
emitted as OpenTelemetry spans into SigNoz.

**The app is scaffolding. The agents' own observability is the deliverable.**

---

## 1. The pieces

| Piece | What it is | Where it runs |
|---|---|---|
| **BuggyBoard** (`demo-api`) | A third-party MIT bug-tracker (Express + SQLite). We didn't write it; its git history predates this hackathon. It contains one seeded bug. | Node, port **3000** |
| **Agent swarm** (`sdlc-agents`) | Orchestrator + 4 agents. Owns and restarts the demo-api process. | Node, SSE on **4100** |
| **SigNoz** | Real open-source SigNoz (official Docker images), self-hosted. Stores all telemetry; the agents *query it as a tool*. | Docker in WSL2, UI **8080** |
| **SigNoz MCP server** | Translates SigNoz's API into MCP tools the agents can call. | Docker, **8000** |
| **Filesystem MCP server** | Sandboxed file access for the Fix agent, rooted at `apps/demo-app/backend` only. | stdio child process |
| **mission-control** | Our live viewer — the presenter's screen. | Vite, **5174** |

Exactly **two OTel service names** exist: `demo-api` and `sdlc-agents`.

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

---

## 2. What actually happens, step by step

### The trigger
Someone clicks **Trigger Incident**, which fires `GET /api/bugs/999999` at demo-api —
a request for a bug that doesn't exist. The seeded bug corrupted the not-found guard
(`if (!bug)` → `if (!bug.id)`), so instead of a clean 404, the code dereferences
`null`, throws a `TypeError`, and Express returns **500**.

That error becomes an error span and a stack-trace log line in SigNoz — just like any
real production error would.

### Agent 1 — Monitor (no LLM)
Every 4 seconds it asks SigNoz, through MCP, *"any error spans from demo-api since my
last check?"* No LLM is involved; the threshold is deterministic. Its agenthood is the
autonomous loop, not cleverness.

Two design details that matter:
- It uses an **absolute-timestamp watermark**, never "last 5 minutes" — SigNoz still
  holds 500s from earlier rehearsals, and a relative window would re-detect them forever.
- Polls **pause** during an incident and the watermark jumps past the handled errors
  afterwards, so the same failure can't be detected twice.

When it finds errors, the orchestrator opens **one root span for the incident** and
records a *span link* back to the detecting poll — "caused by, not parented by."

### Agent 2 — Diagnosis (1 LLM call)
Pulls two pieces of evidence from SigNoz via MCP: the ERROR **logs** (which carry the
stack trace) and the full **trace** detail. It hands only that evidence to the LLM and
demands strict JSON back: `file`, `line`, `cause`.

It answers **`src/index.ts:87`** — derived purely from telemetry. It never reads the
source, and it certainly never reads `GROUND_TRUTH.md`.

### Agent 3 — Fix (1 LLM call)
1. Reads the suspect file through the **sandboxed filesystem MCP server** — rooted at
   the backend directory, so the answer key is physically unreachable. The bytes it
   reads double as the rollback snapshot.
2. One LLM call returns `{search, replace, rationale}`.
3. **Local guards run before anything is written**: `search` must match exactly once,
   must differ from `replace`, both ≤300 chars, and the file may not change by more
   than 200 bytes. A violation aborts *without writing*.
4. Writes the patch, then **restarts demo-api** — it kills and re-spawns the child
   process it owns, and asserts the new PID differs.
5. If the patched app won't come back healthy, it **rewrites the original bytes** and
   restarts again. That's mechanical deploy-style reversion, not a second guess.

### Agent 4 — Verify (no LLM)
Three checks, fail-fast:
1. Process healthy **and** the PID is the one Fix started (no impostor process).
2. **Replays the failing request** and demands exactly **404**. A 200 would mean a
   cosmetic fix that hides the bug — this check exists to close that loophole.
3. Re-queries SigNoz for the window since the restart and asserts **≥1 span exists**
   *and* **zero error spans**. The "≥1" half matters: zero spans means the telemetry
   pipeline is dead, which must never be reported as "the fix worked."

Then the orchestrator closes the incident **resolved**.

### If something goes wrong
There are **no retries**. One attempt; failures are loud and *differentiated*:

| Reason | Meaning |
|---|---|
| `llm_error` | The model failed or returned junk, or a pre-write guard rejected the patch |
| `wrong_hypothesis` | Process is up but still misbehaving (non-404 replay, or new error spans) |
| `patch_broke_process` | The patch wouldn't boot; rollback succeeded |
| `rollback_failed` | Even the rollback wouldn't boot — stop, alert a human |
| `telemetry_unavailable` | SigNoz/MCP is down — infrastructure, not bad reasoning |
| `fs_mcp_unavailable` | The filesystem MCP transport died |

The point of splitting these: **a dead telemetry pipeline must never be misread as an
agent reasoning badly.** The orchestrator is the sole writer of this attribute.

---

## 3. What lands in SigNoz

One incident = **one continuous trace**, roughly 14 spans:

```
agent.orchestrator.incident            ← root; incident.id, phase events, link to the poll
├── agent.diagnosis.run
│   ├── gen_ai.tool.signoz_search_logs
│   ├── gen_ai.tool.signoz_get_trace_details
│   └── agent.diagnosis.llm            ← model + input/output token counts
├── agent.fix.run
│   ├── gen_ai.tool.read_text_file
│   ├── agent.fix.llm
│   ├── gen_ai.tool.write_file
│   └── agent.fix.restart              ← a direct action, NOT a gen_ai.tool.*
└── agent.verify.run
    ├── agent.verify.replay            ← carries http.method + status 404
    └── gen_ai.tool.signoz_search_traces
```

Naming rules (binding):
- Agent step → `agent.<name>.<step>`
- **MCP tool call** → `gen_ai.tool.<literal tool name>`, always a child of the step
- A direct action (an HTTP call, a process restart) is a **step**, never `gen_ai.tool.*`
- Every span carries `gen_ai.agent.name` and `incident.id` (propagated via Context, so
  no function has to thread it through)

Monitor's pre-incident polls are deliberately their own root traces — no incident
exists yet to parent them to.

---

## 4. Running it end to end

**Prerequisites:** Docker Desktop running, SigNoz up in WSL2, `.env` present at the
repo root (gitignored) with `GEMINI_API_KEY`, `SIGNOZ_API_KEY`, SigNoz UI credentials.

```bash
cd "/c/Users/nagar/Downloads/Hackathon Project"

# Terminal 1 — the swarm (spawns demo-api on :3000, serves SSE on :4100)
npm run swarm

# Terminal 2 — the presenter screen
npm run mission-control        # http://localhost:5174

# Terminal 3 — BuggyBoard's own UI (optional)
npm run buggyboard             # http://localhost:5173
```

The swarm **refuses to start** unless the API keys are present, the SigNoz MCP server
answers, and port 3000 is free — a clean startup is itself a pre-flight check.

**Never start the demo-api backend yourself** — the swarm owns that process, because
restarting it is how the Fix agent deploys its patch.

Then: click **Trigger Incident**, watch the pipeline for ~30–60s, and confirm
`curl -i http://localhost:3000/api/bugs/999999` now returns **404**.

**Reset between runs** (mandatory): stop the swarm → confirm port 3000 released →
`npm run reseed` → restart. Reseeding rewrites the source file the running app has
loaded, so it must only happen while the app is stopped.

Full presenter runbook with troubleshooting: **[DEMO.md](DEMO.md)**.

---

## 5. Honesty guarantees

These are the claims a judge is most likely to probe:

- **The app is foreign code.** BuggyBoard is MIT-licensed, by another author, and its
  commit history predates the hackathon. LICENSE and attribution are kept.
- **The agents cannot cheat.** `GROUND_TRUTH.md` documents the bug for humans and sits
  at the repo root; the Fix agent's filesystem server is rooted at
  `apps/demo-app/backend`. A committed test (`scripts/fix-scope-test.mjs`) proves four
  different escape attempts — relative traversal, absolute path, directory listing,
  and search — are all refused.
- **Detection is real.** Monitor discovers the incident by querying SigNoz, exactly as
  a human on-call would. Nothing signals it directly.
- **The fix is a real code change**, applied to a real file and deployed by a real
  process restart — verified by `git diff` and by the endpoint's behaviour changing.
- **It generalises.** Verified by seeding a *completely different* bug the system was
  never designed for (a call to a non-existent method, on a different route, at a
  different line). Monitor detected it, Diagnosis named `src/index.ts:77` and the exact
  cause, Fix repaired it, Verify confirmed it, and the incident closed `resolved`.

---

## 6. Known limitations (stated plainly)

- **It detects errors, not wrongness.** Monitor triggers on 5xx/exception spans. A
  silent logic bug that returns a wrong answer with HTTP 200 would never be noticed.
- **Verify's replay is bug-specific.** It re-requests `GET /api/bugs/999999` and expects
  404. For a different bug, the general safety net is the third check (zero error spans
  after the restart), not the replay.
- **One incident at a time**, by design — the trigger is disabled while one is active.
- **Free-tier LLM quota is the operational risk:** 20 requests/day/model, 2 per
  incident. `GEMINI_MODEL=<id>` switches models without a rebuild.
- **No retries anywhere.** A transient provider 503 closes the incident honestly as
  `llm_error`; the recovery is to trigger again.
