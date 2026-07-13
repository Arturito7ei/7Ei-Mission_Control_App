# @7ei/arturita-stt — free local Whisper voice input

A tiny **zero-dependency** (Node built-ins only) HTTP bridge that turns captured
mic audio into text with a **local whisper**, so the operator gets **free,
on-device voice input** for Arturita — including in **Brave**, whose built-in
Web Speech speech-to-text is disabled and fails with a `network` error.

Same trust model as local Ollama: the operator's **browser** posts audio directly
to `127.0.0.1`; nothing leaves the machine and no cloud key is needed.

```
browser (push-to-talk, MediaRecorder)
   │  POST multipart audio
   ▼
127.0.0.1:8790  (this bridge)  ──►  whisper CLI (+ ffmpeg)  ──►  { text }
```

## Requirements (already on this Mac)

- **Node ≥ 20** (built-ins only — no `npm install`).
- **`whisper`** CLI + **`ffmpeg`** on `PATH`. On this machine both are present via
  Homebrew (`brew install openai-whisper ffmpeg`). whisper loads webm/ogg/mp4/wav
  through ffmpeg, so the raw MediaRecorder blob is handed straight to it.

## Start it (the ONE command)

```bash
cd adapters/arturita-stt
ARTURITA_STT_ORIGINS=https://app.7ei.ai npm run stt        # or: npm start
```

- Listens on `http://127.0.0.1:8790`.
- `ARTURITA_STT_ORIGINS` is the CORS allowlist (comma-separated), mirroring
  `OLLAMA_ORIGINS`. Omit it and it defaults to `*` (fine for pure localhost);
  set it to your app origin (`https://app.7ei.ai`, or `http://localhost:3000`
  for dev) to lock the bridge to Arturita.

Then open the Assistant tab → **🎙 Push to talk**. When the bridge is reachable
the status line reads **🔒 Local Whisper (free, on-device)** and the ⚙ Pipeline
config → **Talk-path self-test** shows the STT leg green.

## Config (env)

| Var | Default | Meaning |
|---|---|---|
| `ARTURITA_STT_PORT` | `8790` | listen port (matches `WHISPER_DEFAULT_URL` in the web client) |
| `ARTURITA_STT_ORIGINS` | `*` | CORS allowlist, comma-separated, or `*` |
| `ARTURITA_STT_MODEL` | `base` | whisper model (`tiny`/`base`/`small`/… or a cached one like `large-v3-turbo`) |
| `ARTURITA_STT_WHISPER_BIN` | `whisper` | the whisper executable |
| `ARTURITA_STT_LANGUAGE` | `en` | force a language, or `auto` to detect |
| `ARTURITA_STT_MAX_BYTES` | `26214400` | reject audio larger than this (25 MB) |

## Endpoints

- `GET /health` → `{ ok, service, engine, model }`
- `POST /inference` — multipart `file` part (whisper.cpp-compatible) → `{ text }`
- `POST /v1/audio/transcriptions` — OpenAI-compatible alias → `{ text }`

Both return `{ text }`, so an OpenAI-compatible whisper server (faster-whisper /
speaches) is a drop-in alternative — point the web client's `WHISPER_DEFAULT_URL`
at it and set its CORS to the app origin.

## Test

```bash
npm test        # pure units: multipart parser, whisper arg-builder, CORS allowlist
```

End-to-end (needs `say` on macOS + ffmpeg):

```bash
say -o /tmp/clip.aiff "hello arturita"
ffmpeg -y -i /tmp/clip.aiff -c:a libopus /tmp/clip.webm
curl -F "file=@/tmp/clip.webm;type=audio/webm" http://127.0.0.1:8790/inference
# → {"text":"Hello Arturita."}
```

## Notes

- **Not** the hardened `@7ei/arturita-host` daemon (that's an authed, fail-closed
  file/machine capability service the *backend* calls). This bridge is
  browser-facing, unauthenticated by design (localhost-only + CORS-scoped), and
  only does one thing: audio → text.
- Purely optional. If it isn't running, Arturita falls back to browser Web Speech
  (where the browser allows it) and always to the typed box.
