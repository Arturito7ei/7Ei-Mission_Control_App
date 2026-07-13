# adapters/claude-code — Claude Code as a Mission Control fleet agent (Epic CC)

A stdlib-only poll-loop daemon that makes **Claude Code** a first-class external
executor inside the 7Ei office: the office assigns a task to a
`runtime:'claude_code'` agent, this adapter claims it, runs a **headless
`claude -p`** in the target workspace, streams the run to the task thread, and
posts the result + heartbeats — exactly the lifecycle OpenClaw/Cursor use.

> Design + safety model: `docs/DESIGN-claude-code-agent.md`. This adapter is its
> own thing — it does **not** touch the live OpenClaw install (`~/.openclaw/`).

## Safety posture (read this)

CC1 ships **propose-and-approve only**. `claude` runs in `--permission-mode plan`
by default: it reads, analyses, and **proposes a plan**; it never edits files or
runs commands on the host. `cc_headless.resolve_permission_mode` is the single
chokepoint — any non-`plan` request collapses back to `plan` unless **both**
operator guards (`CC_AUTONOMOUS=1` **and** `CC_AUTONOMOUS_CONFIRM=1`) are set.
Autonomous host execution is a later, off-by-default story (CC6) and even then
every command passes a denylist hook (CC5). Do not set the autonomous guards
until that lands and you mean it.

## Files

- `cc_adapter.py` — the daemon (IO: poll loop, subprocess, HTTP). Runnable: `python3 cc_adapter.py [--once]`.
- `cc_headless.py` — pure, unit-tested helpers: argv builder, stream-json parser, result extractor, secret redaction, the permission-mode gate, workdir/worktree planning.
- `test/test_cc_headless.py` — `python3 -m unittest discover -s adapters/claude-code/test`.

## Quick start

```bash
# 1. Onboard a Claude Code agent (prints an mca_ token once):
MC_CLERK_TOKEN=… npx @7ei/mc onboard --org <id> --runtime claude_code --name "Claude Code"

# 2. On the host that has the `claude` CLI installed + authenticated:
cat > mc.env <<'EOF'
MC_BASE_URL=https://7ei-backend.fly.dev
MC_AGENT_TOKEN=mca_…
MC_WORKDIR=/path/to/your/checkout
CC_PERMISSION_MODE=plan
EOF
chmod 600 mc.env
set -a; source mc.env; set +a
python3 cc_adapter.py --once   # smoke a single poll; drop --once to run the loop
```

## Environment

| Var | Default | Meaning |
|---|---|---|
| `MC_BASE_URL` | `http://localhost:3001` | app backend |
| `MC_AGENT_TOKEN` | — | `mca_…` external agent token (runtime=claude_code) |
| `MC_WORKDIR` | cwd | working dir for runs |
| `MC_POLL_SECONDS` | 20 | loop interval |
| `CC_CLAUDE_BIN` | `claude` | path to the Claude Code CLI |
| `CC_MODEL` | claude default | model alias/name (`opus`, `sonnet`, full name) |
| `CC_PERMISSION_MODE` | `plan` | `plan` (propose-only) / `acceptEdits` / `bypassPermissions` / … |
| `CC_MANAGE_WORKTREE` | off | `1` → `git worktree add` the `cc/<branch>` for workspace tasks |
| `CC_TIMEOUT_SECONDS` | 1800 | per-run wall-clock cap |
| `CC_ALLOWED_TOOLS` / `CC_DISALLOWED_TOOLS` | — | tool allow/deny lists passed to `claude` |
| `CC_ATTACH_RESULT` | off | `1` → also post the result markdown as a task work product |
| `CC_AUTONOMOUS` / `CC_AUTONOMOUS_CONFIRM` | off | CC6 autonomous-exec guards (BOTH required; leave unset) |

`mc.env` holds only non-secret config (chmod 600). LLM/host credentials for the
`claude` process (e.g. `ANTHROPIC_API_KEY`) come from the encrypted store via
`GET /api/agent/secrets` at boot, or from the host's own Claude Code login —
never write them into `mc.env`.

## Smoke test

```bash
cd backend && npm run smoke:claude-code   # drives the real adapter with a fake claude (no network)
```
