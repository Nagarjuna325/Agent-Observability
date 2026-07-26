# SigNoz stack — deployment and provisioning

SigNoz OSS is deployed with **[Foundry](https://github.com/SigNoz/foundry)**
(`foundryctl cast`), which installs SigNoz *and* its MCP server in one step. SigNoz
has deprecated the docker-compose install path, so Foundry is the supported route.

`casting.yaml` and `casting.yaml.lock` in this directory are the source of truth and
are sufficient to reproduce the deployment.

## What gets exposed

| Port | Service |
|---|---|
| `8080` | SigNoz UI + API |
| `4317` / `4318` | OTLP ingest (gRPC / HTTP) — both `demo-api` and `sdlc-agents` export to `http://localhost:4318` |
| `8000` | SigNoz **MCP server** (`/mcp`, streamable-http) — this is what the agents query as a tool |

The MCP server is not hand-rolled: it's declared in `casting.yaml`
(`spec.mcp.spec.enabled: true`) and materialised by Foundry with the correct
in-network wiring (`SIGNOZ_URL=http://signoz-signoz-0:8080`) and a restart policy.

## Deploying

Foundry runs on Linux. On Windows, run it inside WSL2 — note `foundryctl` requires
**glibc ≥ 2.34**, so use Ubuntu 22.04 or newer, not 18.04.

`casting.yaml` and `casting.yaml.lock` ship with the API key field set to the
placeholder `__FROM_DOTENV_SIGNOZ_API_KEY__` so no credential is committed. Substitute
your own key at deploy time:

```sh
# from the repo root, with SIGNOZ_API_KEY set in .env (gitignored)
set -a && . ./.env && set +a

wsl -d Ubuntu -- bash -c "sed 's|__FROM_DOTENV_SIGNOZ_API_KEY__|$SIGNOZ_API_KEY|' \
  > ~/signoz/casting.yaml" < infra/signoz/casting.yaml
cp infra/signoz/casting.yaml.lock ~/signoz/   # via your WSL path

wsl -d Ubuntu -- bash -lc 'cd ~/signoz && foundryctl cast'
```

Health check — `docker logs signoz-mcp` should end with
`"Listening for MCP clients" … "mcp_endpoint":"/mcp"`. `/mcp` is the only non-404
path on that port.

## Getting an API key

The agents authenticate to SigNoz with a **service-account** key:

1. `POST /api/v1/service_accounts` to create the account
2. `POST /api/v1/service_accounts/{id}/keys` to mint a key

A freshly created service account has **no role**, and in that state every data route
returns `403 authz_forbidden` even though `/api/v1/version` and
`/api/v1/service_accounts/me` return `200` — so the key looks valid while nothing
works. Diagnose with `GET /api/v1/service_accounts/me`: if `serviceAccountRoles` is
`null`, attach a role:

1. `GET /api/v1/roles` → note the id of `signoz-admin`
2. `POST /api/v1/service_account_roles` with
   `{"serviceAccountId": "<id>", "roleId": "<id>"}`

Admin rather than viewer, because the same key provisions dashboards and alerts.

> **Note:** the generated key can contain an `=` character. Parsing it out of `.env`
> with `cut -d= -f2` truncates it and yields a silent `401` that looks like a
> permissions problem. Split on the first `=` only (`cut -d= -f2-`).

## Dashboards and alerts

```sh
node scripts/provision-signoz.mjs      # create/update; idempotent
node scripts/verify-signoz-panels.mjs --hours 0.25
```

`provision-signoz.mjs` reads the JSON in this directory and creates or updates each
object, matching on title so re-runs don't duplicate.

`verify-signoz-panels.mjs` runs **each panel's own query** through the query_range API
and fails any panel returning empty or all-zero data — an HTTP 200 is not treated as
evidence that a panel works. Pass a narrow `--hours` window to prove the panels
populate from fresh data rather than accumulated history.

| File | What it is |
|---|---|
| `agent-fleet-health.json` | 9 panels: per-agent invocations, p50/p95 latency, LLM token spend, MCP tool breakdown, failure rate, failures by reason |
| `demo-api-health.json` | 7 panels: request volume, 5xx, per-status breakdown for `GET /api/bugs/:id`, latency, error rate |
| `agent-failure-rate-alert.json` | Threshold alert on agent failure rate |
| `notification-channel.json` | Required prerequisite — this SigNoz rejects an alert rule with no channel attached |

### Panel data sources

Panels are split deliberately. SigNoz's span metrics cover internal agent spans but
carry only `service.name`, `operation`, `span.kind` and `status.code` — so anything
needing a custom attribute (`gen_ai.usage.*`, `gen_ai.agent.name`, `incident.id`,
`incident.failure_reason`, or even `http.route`) queries **traces** instead. Note also
that `signoz_calls_total` is a monotonic delta counter, so it needs
`timeAggregation: "increase"`; the default `rate` silently returns nothing against
sparse traffic.
