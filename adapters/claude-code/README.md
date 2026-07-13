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
- `cc_headless.py` — pure, unit-tested helpers: argv builder, stream-json parser, result extractor, secret redaction, the permission-mode gate, workdir/worktree planning, and the PreToolUse guard-hook helpers (CC2).
- `cc_guard.py` — the **PreToolUse guard hook** (CC2). When Claude could attempt a command, this turns it into a `machine_exec` approval (verbatim argv → the office A2 gate) and **denies** the tool call — nothing runs on the host. Installed automatically via `--settings` whenever a non-`plan` posture is active (or `CC_GUARD=1`).
- `cc_denylist.py` — the **semantic command allow/deny list** (CC5), the host-side twin of `backend/src/services/cc-denylist.ts`. Classifies a shell command `deny` (catastrophic / privilege / exfil / reverse-shell — refused pre-approval) / `allow` (opt-in allowlist of safe read-only commands) / `gate` (everything else → A2 approval). Deny > allow > gate; fail-closed (unknown → gate).
- `test/` — `python3 -m unittest discover -s adapters/claude-code/test` (headless helpers + guard hook).

## Propose-and-approve bridge (CC2)

In `plan` mode Claude never calls tools, so it only ever proposes. If you run a
tool-using posture, the guard hook makes it safe: **every `Bash` command becomes
a `machine_exec` approval showing the verbatim `argv`**, and the tool call is
**denied** — the office approves the exact command (with a fresh-session step-up)
instead of Claude running it. The backend renders that approval from the
structured `argv` (never the agent's prose) and fail-closes on a malformed
payload (`prepareApprovalRecord`, shared by the human + agent approval routes).
Autonomous execution (actually running an approved/allowlisted command) is CC6,
off by default behind two guards + the CC5 denylist.

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
| `CC_GUARD` | auto | `1` → force-install the propose-and-approve guard hook even in `plan` mode (default: installed whenever the posture is non-`plan`) |
| `CC_AUTONOMOUS` / `CC_AUTONOMOUS_CONFIRM` | off | CC6 autonomous-exec guards (BOTH required; leave unset) |

`mc.env` holds only non-secret config (chmod 600). LLM/host credentials for the
`claude` process (e.g. `ANTHROPIC_API_KEY`) come from the encrypted store via
`GET /api/agent/secrets` at boot, or from the host's own Claude Code login —
never write them into `mc.env`.

## Install (macOS launchd keep-alive)

```bash
MC_AGENT_TOKEN=mca_… MC_WORKDIR=/path/to/checkout ./setup.sh
```
Writes a chmod-600 `~/.7ei-claude-code/mc.env`, prints the resolved posture
(`--doctor`), runs one poll (`--once`), then loads a keep-alive launchd agent —
all in **propose-and-approve** mode. It refuses to run without the `claude` CLI
on PATH and an `mca_` token. It never touches `~/.openclaw/`.

## Autonomous execution — advanced, OFF by default

By default the agent only ever **proposes**. Autonomous host execution (Claude
actually running commands) is fail-closed behind **three** preconditions — miss
any one and the posture stays propose-and-approve:

1. `CC_AUTONOMOUS=1`          — operator guard #1
2. `CC_AUTONOMOUS_CONFIRM=1`  — operator guard #2
3. the **CC5 command denylist** (`cc_denylist.py`) importable on the host
4. plus a non-`plan` `CC_PERMISSION_MODE` (e.g. `bypassPermissions`)

Check exactly what's resolved before trusting it:
```bash
python3 cc_adapter.py --doctor
```

**Even when autonomous**, every command still passes the `cc_guard.py` PreToolUse
hook → the CC5 denylist: **denylisted** commands (`rm -rf /`, `curl|sh`, `sudo`,
secret reads, reverse shells, …) are **refused**; **unknown** commands are
**proposed** to the office as `machine_exec` approvals (never auto-run); only
**fully-allowlisted** read-only commands (`git status`, `npm test`, …) run
without a per-command approval. File edits happen in the agent's `cc/` worktree
and are reviewable as a diff — run the agent against an isolated checkout.

To turn it on (only when you mean it):
```bash
# in mc.env, add:
CC_PERMISSION_MODE=bypassPermissions
CC_AUTONOMOUS=1
CC_AUTONOMOUS_CONFIRM=1
# then: python3 cc_adapter.py --doctor   → posture AUTONOMOUS
```
To turn it back off: remove those three lines (or set them to 0). `--panic` /
pausing the agent from the Cockpit also stops it (the `canAgentRun` gate).

## Smoke test

```bash
cd backend && npm run smoke:claude-code   # drives the real adapter with a fake claude (no network)
python3 -m unittest discover -s adapters/claude-code/test   # pure helpers + guard + denylist
```
