# Adapter presets (MCA-ADAPT S2.2)

Drop-in `mc.env` presets for the 7Ei Mission Control adapter (`adapters/openclaw/mc_adapter.py`).
Every LLM preset reuses the same OpenAI-compatible `llm` executor — only the base URL + model differ.
**"If it can receive a heartbeat, it's hired."**

Copy a preset to `~/.openclaw/mc-adapter/mc.env`, then fill `MC_AGENT_TOKEN` (mint in Cockpit → agent card)
and the provider key.

| Preset | Runtime | Executor | Notes |
|---|---|---|---|
| `codex.env` | OpenAI (Codex/GPT) | `llm` | `MC_LLM_API_KEY` = OpenAI key |
| `gemini.env` | Google Gemini | `llm` | Google's OpenAI-compatible endpoint |
| `nvidia-minimax.env` | MiniMax-M3 @ NVIDIA NIM | `llm` | needs `MC_LLM_MAX_TOKENS` (NIM quirk) |
| `ollama.env` | Local Ollama | `llm` | `http://localhost:11434/v1`, **no key** — `ollama pull <model>` first |
| `shell.env` | Deterministic shell | `shell` | runs `task.input` as a command (gated) |
| `http.env` | Bring-your-own HTTP bot | `http` | POSTs the task to your webhook |

Common to all: `MC_BASE_URL=https://7ei-backend.fly.dev`, `MC_AGENT_TOKEN=<paste>`, `MC_POLL_SECONDS=20`.

## shell.env
```
MC_EXECUTOR=shell
MC_ALLOW_SHELL=1
MC_WORKDIR=/Users/artutito/7Ei-MC_TARCO
```

## http.env  (generic webhook / HTTP bot)
```
MC_EXECUTOR=http
MC_HTTP_URL=https://your-bot.example.com/mc
MC_HTTP_HEADER=Authorization: Bearer <your-bot-key>
```
The adapter POSTs `{id,title,input}` to `MC_HTTP_URL`; reply with JSON `{"output":"...","status":"done"}` or plain text.
