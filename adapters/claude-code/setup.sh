#!/usr/bin/env bash
# 7Ei Mission Control — Claude Code adapter installer (macOS, launchd keep-alive).
# Runs as the operator user, no sudo. Sibling to adapters/arturita-host/setup.sh.
# Does NOT touch the live OpenClaw install (~/.openclaw/).
#
# Brings a Claude Code agent up from zero: writes a chmod-600 mc.env, verifies
# the posture (--doctor) + a single poll (--once), then loads a launchd agent.
#
#   MC_BASE_URL   backend (default https://7ei-backend.fly.dev)
#   MC_AGENT_TOKEN  mca_...  (REQUIRED — from onboarding; runtime=claude_code)
#   MC_WORKDIR    the code checkout the agent works in (default: cwd)
#   CC_MODEL      optional model alias (opus|sonnet|…)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="ai.7ei.claude-code-adapter"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
PY_BIN="$(command -v python3 || true)"
CLAUDE_BIN="$(command -v claude || true)"

MC_BASE_URL="${MC_BASE_URL:-https://7ei-backend.fly.dev}"
MC_AGENT_TOKEN="${MC_AGENT_TOKEN:-}"
MC_WORKDIR="${MC_WORKDIR:-$PWD}"
CC_MODEL="${CC_MODEL:-}"

[[ -z "$PY_BIN" ]] && { echo "python3 not found on PATH — install Python 3 first." >&2; exit 1; }
[[ -z "$CLAUDE_BIN" ]] && { echo "the 'claude' CLI is not on PATH — install + log in to Claude Code first (https://claude.com/claude-code)." >&2; exit 1; }
[[ -z "$MC_AGENT_TOKEN" ]] && { echo "MC_AGENT_TOKEN is required (onboard a runtime=claude_code agent first)." >&2; exit 1; }

CFG_DIR="$HOME/.7ei-claude-code"
mkdir -p "$CFG_DIR"; chmod 700 "$CFG_DIR"
ENV_FILE="$CFG_DIR/mc.env"

# mc.env holds ONLY non-secret config (chmod 600). Claude Code credentials come
# from the host's own `claude` login (or ANTHROPIC_API_KEY / GET /secrets) — never
# write an LLM key here. PROPOSE-AND-APPROVE by default (CC_PERMISSION_MODE=plan);
# autonomous exec stays OFF (do NOT add CC_AUTONOMOUS here unless you mean it).
{
  echo "MC_BASE_URL=${MC_BASE_URL}"
  echo "MC_AGENT_TOKEN=${MC_AGENT_TOKEN}"
  echo "MC_WORKDIR=${MC_WORKDIR}"
  echo "CC_PERMISSION_MODE=plan"
  [[ -n "$CC_MODEL" ]] && echo "CC_MODEL=${CC_MODEL}"
} > "$ENV_FILE"
chmod 600 "$ENV_FILE"
echo "Wrote ${ENV_FILE} (chmod 600, propose-and-approve)."

# Verify posture + a single poll before installing the keep-alive.
set -a; source "$ENV_FILE"; set +a
echo "── posture ──"; "$PY_BIN" "$HERE/cc_adapter.py" --doctor
echo "── smoke (one poll) ──"; "$PY_BIN" "$HERE/cc_adapter.py" --once || echo "(smoke poll returned non-zero — check the token/backend)"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${PY_BIN}</string>
    <string>${HERE}/cc_adapter.py</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MC_BASE_URL</key><string>${MC_BASE_URL}</string>
    <key>MC_AGENT_TOKEN</key><string>${MC_AGENT_TOKEN}</string>
    <key>MC_WORKDIR</key><string>${MC_WORKDIR}</string>
    <key>CC_PERMISSION_MODE</key><string>plan</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${CFG_DIR}/adapter.out.log</string>
  <key>StandardErrorPath</key><string>${CFG_DIR}/adapter.err.log</string>
</dict>
</plist>
PLIST_EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "claude-code adapter loaded (label ${LABEL}, propose-and-approve)."
echo
echo "The agent now claims assigned tasks and PROPOSES — it runs no host commands without approval."
echo "To enable autonomous exec later, see adapters/claude-code/README.md (two guards + the CC5 denylist)."
