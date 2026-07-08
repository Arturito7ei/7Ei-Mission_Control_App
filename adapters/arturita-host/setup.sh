#!/usr/bin/env bash
# Arturita Local Host — installer (macOS, launchd keep-alive). Runs as the
# operator user, no sudo. Sibling to adapters/mac-mini/setup.sh.
#
# S3 (2026-07-08): the host assumes FULL machine access, protected by a minimal
# self-protection denylist + the A2 approval gate on destructive ops. It binds
# 127.0.0.1 ONLY and refuses to start without a shared token (fail-closed).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="ai.7ei.arturita-host"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
NODE_BIN="$(command -v node || true)"
PORT="${ARTURITA_HOST_PORT:-8799}"
ROOT="${ARTURITA_HOST_ROOT:-$HOME}"   # default to the operator home; set to / for whole-machine

if [[ -z "$NODE_BIN" ]]; then echo "node not found on PATH — install Node >= 20 first." >&2; exit 1; fi

# 1. Shared token (fail-closed). Generated once, stored 0600 in the host config
#    dir — which is itself on the denylist so Arturita can't read it.
CFG_DIR="$HOME/.arturita-host"
mkdir -p "$CFG_DIR"; chmod 700 "$CFG_DIR"
TOKEN_FILE="$CFG_DIR/token"
if [[ ! -f "$TOKEN_FILE" ]]; then
  node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))' > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
  echo "Generated a new host token at $TOKEN_FILE (register it in the backend secret store as ARTURITA_HOST_TOKEN)."
fi
TOKEN="$(cat "$TOKEN_FILE")"

# 2. launchd plist (keep-alive, restart on crash). Localhost only.
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${HERE}/src/server.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ARTURITA_HOST_TOKEN</key><string>${TOKEN}</string>
    <key>ARTURITA_HOST_PORT</key><string>${PORT}</string>
    <key>ARTURITA_HOST_ROOT</key><string>${ROOT}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${CFG_DIR}/host.out.log</string>
  <key>StandardErrorPath</key><string>${CFG_DIR}/host.err.log</string>
</dict>
</plist>
PLIST_EOF

# 3. (Re)load.
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "arturita-host loaded (127.0.0.1:${PORT}, root=${ROOT})."
echo
echo "NEXT (operator, manual):"
echo "  • Grant TCC permissions when prompted (Full Disk Access / Automation / Accessibility / Microphone) — the Epic H wizard will guide this."
echo "  • Register the token in the backend secret store: ARTURITA_HOST_TOKEN=$(cat "$TOKEN_FILE")"
echo "  • Destructive ops still require an A2 approval — the daemon fails closed without approved:true."
