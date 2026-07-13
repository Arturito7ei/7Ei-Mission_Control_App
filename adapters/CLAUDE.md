# adapters/ — external BYO-agent runtimes

Loads on top of the root CLAUDE.md when working in `adapters/`.

## Layout

- `openclaw/mc_adapter.py` — the adapter: stdlib-only Python poll loop (urllib/json/subprocess, NO pip deps). Claims tasks via `agent-api.ts`, executes (shell | llm | http), posts results + heartbeats.
- `mac-mini/setup.sh` — one-command install: adapter + preset + launchd keep-alive + chmod-600 `mc.env` + `--once` smoke test.
- `presets/*.env` — executor presets (codex, gemini, nvidia-minimax); all reuse the OpenAI-compatible llm loop.
- `cursor/` — Cursor runtime notes.
- `claude-code/` — the **Claude Code** executor (Epic CC): stdlib-only Python poll loop (`cc_adapter.py`) that runs a **headless `claude -p`** in the target `cc/`-worktree, streams stream-json to the task thread, and posts result + heartbeat. Pure core `cc_headless.py`; the `cc_guard.py` PreToolUse hook + `cc_denylist.py` (twin of `backend/src/services/cc-denylist.ts`) enforce the command allow/deny list. **Propose-and-approve by default**; autonomous host exec is OFF, fail-closed behind two operator guards **and** the denylist. `./setup.sh` for launchd keep-alive; `cc_adapter.py --doctor` prints the posture. Its own thing — never touches `~/.openclaw/`.

## Rules

- Keep `mc_adapter.py` stdlib-only — it must run on any Mac/Linux with bare Python 3.
- Secrets: the adapter pulls scoped secrets (`MC_LLM_API_KEY`) from the encrypted store at boot via `GET /api/agent/secrets` and injects into env. LLM credentials are read from `os.environ` at CALL time. Never write an LLM key into `mc.env` or any preset.
- `mc.env` holds only: `MC_BASE_URL`, `MC_AGENT_TOKEN`, `MC_WORKDIR`, executor flags. chmod 600.
- Live deploy location: `~/.openclaw/mc-adapter/` (launchd label `com.7ei.mc-adapter`). Changing the running adapter = ask the user first.
- Smoke-test any adapter change: `cd backend && npm run smoke:openclaw` (or `smoke:openclaw:llm`) and `python3 mc_adapter.py --once` against prod before calling it done.
- NVIDIA NIM minimax quirk: requests MUST send `max_tokens` or NIM returns empty choices.
