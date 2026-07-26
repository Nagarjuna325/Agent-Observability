# AgentOps — demo runbook

Everything below has been executed and verified. Follow it top to bottom.

The story you are telling: **a bug appears in a real app, and a swarm of four agents
detects, diagnoses, fixes and verifies it on its own — and every thought those agents
had is visible in SigNoz.** The app is scaffolding; the agents' observability is the
product.

---

## 0. Pre-flight (~2 min, do this before the audience is watching)

Run each and confirm the expected result. If any fails, see **Troubleshooting**.

| Check | Command | Expect |
|---|---|---|
| SigNoz alive | `curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/api/v1/version` | `200` |
| SigNoz MCP alive | `curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:8000/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"p","version":"1"}}}'` | `200` |
| Ports free | `netstat -ano \| grep -E ":(3000\|4100\|5174) " \| grep LISTENING` | no output |
| Bug is seeded | `npm run reseed` | prints sha `449194be…` |

If SigNoz is down: `wsl -d Ubuntu -- bash -lc 'cd ~/signoz && foundryctl cast'`, then
wait ~60s and re-check. Docker Desktop must be running first.

### LLM quota — the one thing that can kill the demo
Gemini free tier = **20 requests/day/model**; each incident costs **2**
(Diagnosis + Fix) → **10 incidents per model per day**. Resets **07:00 UTC**
(midnight Pacific).

Check how many you've used today *without spending a request* — count your own
telemetry:
```bash
wsl -d Ubuntu -- docker exec signoz-telemetrystore-clickhouse-0-0 clickhouse-client -q \
 "SELECT attributes_string['gen_ai.request.model'] AS model, count() FROM signoz_traces.distributed_signoz_index_v3 WHERE name LIKE 'agent.%.llm' AND attributes_string['gen_ai.request.model'] != '' AND timestamp >= toDateTime('$(date -u +%Y-%m-%d) 07:00:00') GROUP BY model"
```
Empty result = full 20 available. If you're near the limit, switch model — quota is
**per model**, so a different id gives you a fresh 20, no rebuild:
```bash
GEMINI_MODEL=gemini-flash-latest npm run swarm
```
Known-good ids on this key: `gemini-3.6-flash` (default), `gemini-3.5-flash`,
`gemini-flash-latest`, `gemini-flash-lite-latest`.

---

## 1. Start the stack (order matters)

Three terminals. **Never start the demo-api backend by hand — the agent swarm owns
it** and will spawn, kill and restart it.

**All three run from the repo root** — `cd "/c/Users/nagar/Downloads/Hackathon Project"`
first in each terminal, then one command. Nothing else on the line.

```bash
# Terminal 1 — the agent swarm (spawns demo-api on :3000, serves SSE on :4100)
npm run swarm
# wait for: [agents] monitor loop running
```
```bash
# Terminal 2 — mission-control, the presenter screen (:5174)
npm run mission-control
```
```bash
# Terminal 3 — BuggyBoard's own UI, the "real app" (:5173)  [optional but good theatre]
npm run buggyboard
```
To use a different LLM model (quota), terminal 1 becomes:
`GEMINI_MODEL=gemini-flash-latest npm run swarm`

The swarm refuses to start if the API keys, the MCP server, or port 3000 aren't
right — a clean startup is itself a pre-flight pass.

**Browser tabs to have open, in this order:**
1. `http://localhost:5174` — mission-control (your main screen)
2. `http://localhost:5173` — BuggyBoard (the app being fixed)
3. `http://localhost:8080` — SigNoz → the **AgentOps — Agent Fleet Health** dashboard
4. `http://localhost:8080` — second SigNoz tab on **Traces**, filtered to service `sdlc-agents`

---

## 2. The demo (~3 min)

**Beat 1 — "here's a real app."** Show BuggyBoard on :5173. Click into a bug. It's a
normal bug tracker — a real third-party open-source app, not something we wrote. Its
git history predates the hackathon.

**Beat 2 — "here's our mission control, and nothing is wrong yet."** Switch to :5174.
The four agents sit idle; Monitor is quietly polling SigNoz every 4 seconds. Point out
that Monitor is genuinely autonomous — nobody tells it an incident happened.

**Beat 3 — break it.** Click **Trigger Incident**. This fires
`GET /api/bugs/999999` straight at the app — a request for a bug that doesn't exist.
The app returns **500** instead of a 404. That's the seeded bug.

**Beat 4 — watch the swarm work** (~30–60s, this is the whole show):
- **Monitor** turns active within ~4s, having found the error span in SigNoz itself.
- **Diagnosis** lights up, calls SigNoz for logs and the trace, and prints
  **`src/index.ts:87`** with a plain-English cause. Say out loud: *it got that from
  telemetry, not from being told.*
- **Fix** reads the file through a sandboxed filesystem server, writes a one-line
  patch, and restarts the app.
- **Verify** re-runs the exact failing request and demands a **404**, then re-checks
  SigNoz for new errors.
- The incident closes **resolved**.

**Beat 5 — prove it's real, not theatre.** Two proofs:
```bash
curl -i http://localhost:3000/api/bugs/999999      # now 404, was 500
git -C "apps/demo-app" diff -- backend/src/index.ts # the agent's actual patch
```
The diff is a real change to a real file. Fix wrote it; nobody typed it.

**Beat 6 — the actual deliverable: the agents are observable.** Switch to SigNoz.
- **Traces** → the incident is **one continuous trace**: orchestrator at the root,
  then diagnosis → fix → verify, with a child span for **every** MCP tool call and
  every LLM call. Open `agent.diagnosis.llm` and show the model and token counts.
- **Agent Fleet Health dashboard** → per-agent latency, token spend, tool-call
  breakdown, failure rate.
- Point out the honesty design: failures are differentiated
  (`llm_error`, `wrong_hypothesis`, `patch_broke_process`, `rollback_failed`,
  `telemetry_unavailable`, `fs_mcp_unavailable`) so infrastructure flakiness can never
  be misread as bad agent reasoning.

**Optional closer — the safety story.** The Fix agent snapshots the file before
patching. If its patch won't boot, it rolls back automatically and reports
`patch_broke_process` rather than leaving the app broken. Verified: see step 4 below.

---

## 3. Reset between runs (~30s) — MANDATORY before every re-run

```bash
# 1. Stop the agent swarm (Ctrl-C in terminal 1)
# 2. Confirm the port actually released — a dev-server child can outlive its parent
netstat -ano | grep ":3000 " | grep LISTENING     # expect no output
# 3. Restore the bug + database  (ONLY while demo-api is stopped)
npm run reseed
# 4. Restart terminal 1  ->  npm run swarm
```
Leave mission-control and BuggyBoard running; they reconnect on their own.

**Why the order matters:** `reseed.mjs` rewrites the source file the running app has
loaded. Reseeding while it runs is the one operation guaranteed to confuse everything.

---

## 4. Checking it properly (do this once before you present)

Full-loop rehearsal, twice, from a re-seeded state. Both runs must close **resolved**.

```bash
# after a reset, with the swarm running:
curl -s -o /dev/null -w "trigger: %{http_code}\n" http://localhost:3000/api/bugs/999999   # 500
# wait ~60s, then:
curl -s -N --max-time 2 http://localhost:4100/events | head -2   # phase should read "resolved"
curl -s -o /dev/null -w "replay: %{http_code}\n" http://localhost:3000/api/bugs/999999    # 404
```

**Dashboards show live data** (not just old history — the narrow window is the point):
```bash
npm run verify-panels                                 # expect 16/16 PASS
```

**Rollback safety net still works** (costs 2 LLM calls; run once, not every rehearsal):
```bash
# reset first, then start the swarm with the forced-bad-patch hook:
AGENTS_FIX_FORCE_BAD_PATCH=1 npm run swarm
# trigger; expect the incident to close failed / patch_broke_process,
# demo-api healthy again, and the file restored to sha 449194be…
sha256sum apps/demo-app/backend/src/index.ts
```
**Never run with that env var set during the real demo.**

---

## 5. Troubleshooting (live, under pressure)

| Symptom | Cause | Do this |
|---|---|---|
| Incident closes `llm_error` | Gemini 429 (quota) or a transient 503 | Reset and re-trigger. If it repeats, restart the swarm with `GEMINI_MODEL=gemini-flash-latest`. **This is the most likely failure.** |
| Incident closes `telemetry_unavailable` | SigNoz ingest lag or MCP down | Check the MCP pre-flight; reset and re-trigger |
| Swarm refuses to start, "port 3000 in use" | orphaned demo-api | `netstat -ano \| findstr :3000` then `taskkill /PID <pid> /F` |
| mission-control shows "disconnected" | swarm not running | start terminal 1; the UI reconnects itself |
| Trigger button greyed out | an incident is already active, or demo-api unhealthy | wait for it to close — only one incident runs at a time, by design |
| `phase: failed`, reason `wrong_hypothesis` | the agent genuinely got it wrong | **Don't hide it.** This is the honest-failure design working; reset and re-run |

**If everything falls over and the audience is waiting:** `npm run mock` in
`apps/mission-control` replays a scripted incident with no backend, no SigNoz and no
LLM. It is a fallback for showing the UI, not a substitute for the real run — say so
if you use it.

---

## 6. Talking points worth landing

- **The judged thing is agent observability.** One incident = one trace = every agent
  step, every MCP tool call, every LLM call with token counts.
- **The app is foreign code.** BuggyBoard is a third-party MIT project; its history
  predates the hackathon. The agents fixed code nobody here wrote.
- **The agents can't cheat.** `GROUND_TRUTH.md` documents the bug for humans, and the
  Fix agent's filesystem access is sandboxed to the backend directory — proven by a
  test that tries four different ways to read the answer key and is refused each time.
- **Failures are differentiated on purpose**, so a dead telemetry pipeline is never
  reported as bad reasoning.
- **No retries.** One attempt; if it fails, it fails visibly in the trace. Rollback is
  mechanical deploy-style reversion, not a second guess.
