#!/usr/bin/env bash
# @7ei/arturita-stt — start the free local Whisper voice-input bridge.
# Zero-dep (Node built-ins). Requires `whisper` + `ffmpeg` on PATH
# (brew install openai-whisper ffmpeg).
set -euo pipefail

cd "$(dirname "$0")"

# CORS: lock the bridge to your Arturita origin. Override before running, e.g.
#   ARTURITA_STT_ORIGINS=http://localhost:3000 ./setup.sh
export ARTURITA_STT_ORIGINS="${ARTURITA_STT_ORIGINS:-https://app.7ei.ai}"
export ARTURITA_STT_MODEL="${ARTURITA_STT_MODEL:-base}"

command -v node   >/dev/null || { echo "✕ node not found (need Node >= 20)"; exit 1; }
command -v whisper>/dev/null || { echo "✕ whisper not found — run: brew install openai-whisper"; exit 1; }
command -v ffmpeg >/dev/null || { echo "✕ ffmpeg not found — run: brew install ffmpeg"; exit 1; }

echo "▸ arturita-stt: whisper=$(command -v whisper) model=${ARTURITA_STT_MODEL} origins=${ARTURITA_STT_ORIGINS}"
exec node src/server.mjs
