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

One command (recommended — installs adapter + preset + launchd keep-alive, runs a
smoke test): see [`../mac-mini/`](../mac-mini/README.md).

```bash
cd adapters/mac-mini
MC_AGENT_TOKEN=mca_xxx ./setup.sh --preset nvidia-minimax --yes
```

Or by hand:

```bash
mkdir -p ~/.openclaw/mc-adapter
cp mc_adapter.py mc.env.example ~/.openclaw/mc-adapter/
cp ~/.openclaw/mc-adapter/mc.env.example ~/.openclaw/mc-adapter/mc.env
# edit mc.env → paste MC_AGENT_TOKEN, set MC_BASE_URL + MC_WORKDIR
# leave MC_LLM_API_KEY empty — it's injected from the encrypted secret store at boot
```

## 3. Run

```bash
set -a; source ~/.openclaw/mc-adapter/mc.env; set +a
python3 ~/.openclaw/mc-adapter/mc_adapter.py --once   # one pass
python3 ~/.openclaw/mc-adapter/mc_adapter.py          # poll loop
```

Keep it alive with launchd: edit + install `com.7ei.mc-adapter.plist` to
`~/Library/LaunchAgents/`, then `launchctl load -w ~/Library/LaunchAgents/com.7ei.mc-adapter.plist`.

## Execution model (`MC_EXECUTOR`)

- **`shell`** — runs `task.input` directly as a shell command in `MC_WORKDIR`
  (gated by `MC_ALLOW_SHELL=1`). Deterministic; good for git ops / scripts.
- **`llm`** (Phase 2.1) — hands the task to the agent's **MiniMax / OpenAI-compatible
  brain**. The adapter fetches its identity from `GET /api/agent/me`, builds a
  system prompt (name, role, terms of reference), and runs a **ReAct-style tool
  loop**: the model may emit one ```` ```bash ```` block, the adapter executes it
  (when `MC_ALLOW_SHELL=1`), feeds the `OBSERVATION:` back, and loops up to
  `MC_MAX_STEPS` until the model returns a final answer. Configure with
  `MC_LLM_BASE_URL`, `MC_LLM_API_KEY`, `MC_LLM_MODEL`. For a **local Ollama** brain
  set `MC_LLM_BASE_URL=http://localhost:11434/v1` and leave `MC_LLM_API_KEY` empty
  (local hosts need no key) — see [`../presets/ollama.env`](../presets/ollama.env).
- **`auto`** (default) — `llm` when `MC_LLM_API_KEY` is set, else `shell`.

So the agent gets real reasoning + the host's tools, not just raw shell.

## Security

- Token is bearer-scoped to one agent+org; only its sha256 hash is stored server-side. Rotate via `POST /api/agents/:id/rotate-token`.
- Shell execution is **off by default**. Only enable on a host the owner controls; scope `MC_WORKDIR`.
- Store the token in 1Password (`op run --env-file mc.env -- python3 mc_adapter.py`), not in plaintext where avoidable.

## Verify

`backend/scripts/smoke-openclaw.ts` boots an in-process backend, onboards an
external agent, assigns a task, runs this adapter `--once`, and asserts the task
reaches **done** with a heartbeat. Run: `npm --prefix backend run smoke:openclaw`.
