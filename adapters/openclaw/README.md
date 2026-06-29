# OpenClaw / external runtime adapter (MCA-EXT, Phase 2)

Bridges a **self-hosted runtime** (OpenClaw/MiniMax, Cursor, custom) to Mission
Control. The app assigns tasks to an external agent; this adapter claims them,
runs them with the host's own tools, and reports results + heartbeats back.

```
Mission Control  ──assign──▶  agent.task.assigned
        ▲                            │
        │ POST /result               ▼ GET /api/agent/tasks?state=assigned
        │ POST /heartbeat   ┌──────────────────┐  POST /claim
        └───────────────────┤  mc_adapter.py   ├── run with host tools (shell)
                            └──────────────────┘
```

## 1. Onboard the agent (get a token)

From the app (or curl with a Clerk session), create the external agent:

```bash
curl -sX POST "$MC_BASE_URL/api/orgs/$ORG_ID/agents/external" \
  -H "Authorization: Bearer $CLERK_JWT" -H 'Content-Type: application/json' \
  -d '{"name":"Arturito · Open Claw","role":"Ops","runtime":"openclaw","llmProvider":"minimax"}'
# → { "agent": {...}, "agentToken": "mca_..." }   ← token shown ONCE
```

## 2. Install on the Mac mini

```bash
mkdir -p ~/.openclaw/mc-adapter
cp mc_adapter.py mc.env.example ~/.openclaw/mc-adapter/
cp ~/.openclaw/mc-adapter/mc.env.example ~/.openclaw/mc-adapter/mc.env
# edit mc.env → paste MC_AGENT_TOKEN, set MC_BASE_URL + MC_WORKDIR
```

## 3. Run

```bash
set -a; source ~/.openclaw/mc-adapter/mc.env; set +a
python3 ~/.openclaw/mc-adapter/mc_adapter.py --once   # one pass
python3 ~/.openclaw/mc-adapter/mc_adapter.py          # poll loop
```

Keep it alive with launchd: edit + install `com.7ei.mc-adapter.plist` to
`~/Library/LaunchAgents/`, then `launchctl load -w ~/Library/LaunchAgents/com.7ei.mc-adapter.plist`.

## Execution model

The default executor runs `task.input` as a **shell command** in `MC_WORKDIR`
(gated by `MC_ALLOW_SHELL=1`) — OpenClaw is a shell-capable runtime, so this is
both the smoke-test path and genuinely useful (git ops, file work, scripts).
To hand tasks to the full OpenClaw/MiniMax brain instead, replace `execute()`
with a call into OpenClaw's gateway (Phase 2.1).

## Security

- Token is bearer-scoped to one agent+org; only its sha256 hash is stored server-side. Rotate via `POST /api/agents/:id/rotate-token`.
- Shell execution is **off by default**. Only enable on a host the owner controls; scope `MC_WORKDIR`.
- Store the token in 1Password (`op run --env-file mc.env -- python3 mc_adapter.py`), not in plaintext where avoidable.

## Verify

`backend/scripts/smoke-openclaw.ts` boots an in-process backend, onboards an
external agent, assigns a task, runs this adapter `--once`, and asserts the task
reaches **done** with a heartbeat. Run: `npm --prefix backend run smoke:openclaw`.
