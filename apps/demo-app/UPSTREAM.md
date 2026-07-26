# Upstream provenance — BuggyBoard

The code in this directory is **not ours**. It is vendored (copied in, inner `.git`
removed) from a third-party open-source project so that the AgentOps agents fix a
bug in a genuinely foreign codebase.

| | |
|---|---|
| Project | BuggyBoard — a simple bug tracker, built for educational purposes |
| Repository | https://github.com/AutomationPanda/buggyboard-web-app |
| Author | Andrew "Pandy" Knight ([Automation Panda](https://automationpanda.com/)) |
| License | MIT — see `LICENSE` in this directory, kept verbatim |
| Upstream commit | `4aedc2fdfcbc3fa0869ee6ff52a345588a8d8218` ("Fix bug modal scrolling bug", 2026-06-12) |
| Retrieved | 2026-07-25 |

The upstream commit predates this hackathon (repo created 2026-05, HEAD 2026-06-12),
which is the evidence that the codebase our agents diagnose and patch was written by
someone else, before us.

## Local modifications

Everything here is upstream-verbatim except:

- `.git/` removed (vendored, not a submodule).
- Upstream's root `CLAUDE.md` renamed to `UPSTREAM_CLAUDE.md` so it does not collide
  with this monorepo's own `apps/demo-app/CLAUDE.md`. Contents unchanged.
- This file.
- From Phase 5 onward: exactly one seeded bug in `backend/src/`, documented in the
  repo-root ground-truth file, plus whatever the Fix agent patches at demo time.
- The single deliberate divergence from upstream is a one-line guard corruption at
  `backend/src/index.ts:87` in the `GET /api/bugs/:id` handler; both canonical states
  (pristine and seeded) are kept verbatim in the repo's `infra/seed/` directory.

No dependency versions were changed — `npm install` was clean on Node 20 as-is.
