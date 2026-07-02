#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# 7Ei Mission Control — one-command Mac-mini adapter installer.
#
# Installs mc_adapter.py + a chosen executor preset into ~/.openclaw/mc-adapter,
# renders the launchd keep-alive plist for the current user, runs a one-shot
# smoke test, and (optionally) loads the service so it survives reboots.
#
# Usage:
#   ./setup.sh                       # interactive
#   MC_AGENT_TOKEN=mca_... ./setup.sh --preset nvidia-minimax --yes
#
# Flags:
#   --preset <name>   codex | gemini | nvidia-minimax | shell | http  (default: shell)
#   --no-shell        force MC_ALLOW_SHELL=0 (safer; shell executor disabled)
#   --yes             non-interactive; don't prompt, load launchd at the end
#   --no-launchd      install + smoke test only; skip launchctl load
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── locate the bundle (this dir) and the adapter/presets in the repo ──────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADAPTER_SRC="$SCRIPT_DIR/../openclaw/mc_adapter.py"
PRESET_DIR="$SCRIPT_DIR/../presets"
DEST="$HOME/.openclaw/mc-adapter"
PLIST_DEST="$HOME/Library/LaunchAgents/com.7ei.mc-adapter.plist"

PRESET="shell"
ALLOW_SHELL="1"
ASSUME_YES="0"
DO_LAUNCHD="1"

while [ $# -gt 0 ]; do
  case "$1" in
    --preset)    PRESET="$2"; shift 2;;
    --no-shell)  ALLOW_SHELL="0"; shift;;
    --yes)       ASSUME_YES="1"; shift;;
    --no-launchd) DO_LAUNCHD="0"; shift;;
    *) echo "unknown flag: $1" >&2; exit 2;;
  esac
done

say() { printf '\033[1;33m▸\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ -f "$ADAPTER_SRC" ] || die "adapter not found at $ADAPTER_SRC (run from the repo checkout)"
command -v python3 >/dev/null || die "python3 not found — install the Xcode command line tools"

# ── config values ─────────────────────────────────────────────────────────────
MC_BASE_URL="${MC_BASE_URL:-https://7ei-backend.fly.dev}"
MC_WORKDIR="${MC_WORKDIR:-$HOME/7Ei-MC_TARCO}"
MC_AGENT_TOKEN="${MC_AGENT_TOKEN:-}"

if [ "$ASSUME_YES" = "0" ]; then
  read -r -p "MC_BASE_URL   [$MC_BASE_URL]: " _v; MC_BASE_URL="${_v:-$MC_BASE_URL}"
  read -r -p "MC_WORKDIR    [$MC_WORKDIR]: " _v; MC_WORKDIR="${_v:-$MC_WORKDIR}"
  read -r -p "Executor preset (codex|gemini|nvidia-minimax|shell|http) [$PRESET]: " _v; PRESET="${_v:-$PRESET}"
fi

if [ -z "$MC_AGENT_TOKEN" ]; then
  if [ "$ASSUME_YES" = "1" ]; then die "MC_AGENT_TOKEN not set (mint one in the app -> Cockpit -> rotate token)"; fi
  read -r -p "MC_AGENT_TOKEN (mca_...): " MC_AGENT_TOKEN
fi
[ -n "$MC_AGENT_TOKEN" ] || die "a token is required"

# ── install files ─────────────────────────────────────────────────────────────
say "Installing to $DEST"
mkdir -p "$DEST" "$(dirname "$PLIST_DEST")"
cp "$ADAPTER_SRC" "$DEST/mc_adapter.py"
chmod +x "$DEST/mc_adapter.py"

# base env from preset (if any) then overlay the resolved values
ENV_FILE="$DEST/mc.env"
if [ "$PRESET" != "shell" ] && [ -f "$PRESET_DIR/$PRESET.env" ]; then
  cp "$PRESET_DIR/$PRESET.env" "$ENV_FILE"
  say "Seeded mc.env from preset '$PRESET'"
else
  : > "$ENV_FILE"
  [ "$PRESET" = "shell" ] || say "no preset file for '$PRESET'; writing minimal mc.env"
fi

# strip any keys we are about to (re)write, then append the resolved config
_tmp="$(mktemp)"
grep -vE '^(MC_BASE_URL|MC_AGENT_TOKEN|MC_WORKDIR|MC_ALLOW_SHELL|MC_EXECUTOR)=' "$ENV_FILE" > "$_tmp" 2>/dev/null || true
mv "$_tmp" "$ENV_FILE"
{
  echo "MC_BASE_URL=$MC_BASE_URL"
  echo "MC_AGENT_TOKEN=$MC_AGENT_TOKEN"
  echo "MC_WORKDIR=$MC_WORKDIR"
  echo "MC_ALLOW_SHELL=$ALLOW_SHELL"
  # 'shell' preset -> force shell executor; otherwise leave preset/auto in place
  [ "$PRESET" = "shell" ] && echo "MC_EXECUTOR=shell"
} >> "$ENV_FILE"
chmod 600 "$ENV_FILE"
say "Wrote $ENV_FILE (chmod 600)"
say "Note: leave MC_LLM_API_KEY empty here — the adapter pulls it from the encrypted"
say "      secret store at boot (Cockpit -> Secrets -> MC_LLM_API_KEY). No plaintext key on disk."

# ── render the launchd plist for THIS user ────────────────────────────────────
cat > "$PLIST_DEST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>            <string>com.7ei.mc-adapter</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>set -a; source "$ENV_FILE"; set +a; exec /usr/bin/python3 "$DEST/mc_adapter.py"</string>
  </array>
  <key>RunAtLoad</key>        <true/>
  <key>KeepAlive</key>        <true/>
  <key>ThrottleInterval</key> <integer>10</integer>
  <key>StandardOutPath</key>  <string>$DEST/adapter.log</string>
  <key>StandardErrorPath</key><string>$DEST/adapter.err</string>
</dict>
</plist>
PLIST
say "Rendered $PLIST_DEST"

# ── smoke test (one pass) ─────────────────────────────────────────────────────
say "Smoke test: one poll pass..."
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"; set +a
if python3 "$DEST/mc_adapter.py" --once; then
  say "Smoke test OK"
else
  die "smoke test failed — check the token / MC_BASE_URL and re-run"
fi

# ── load launchd ──────────────────────────────────────────────────────────────
if [ "$DO_LAUNCHD" = "1" ] && [ "$ASSUME_YES" = "0" ]; then
  read -r -p "Load the keep-alive service now (survives reboot)? [y/N]: " _v
  { [ "${_v:-N}" = "y" ] || [ "${_v:-N}" = "Y" ]; } || DO_LAUNCHD="0"
fi
if [ "$DO_LAUNCHD" = "1" ]; then
  launchctl unload "$PLIST_DEST" 2>/dev/null || true
  launchctl load -w "$PLIST_DEST"
  say "launchd service loaded. Logs: tail -f $DEST/adapter.log"
else
  say "Skipped launchd. Start manually:  launchctl load -w $PLIST_DEST"
fi

say "Done. Agent will poll $MC_BASE_URL every few seconds."
