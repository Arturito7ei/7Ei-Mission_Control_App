# Mac-mini adapter bundle

One-command install of the 7Ei Mission Control external-agent adapter on a
dedicated Mac mini (or any always-on Mac). Wraps `../openclaw/mc_adapter.py` +
`../presets/` with an installer that also sets up a launchd keep-alive service.

## Install

```bash
# on the Mac mini, from a checkout of this repo:
cd 7Ei-Mission_Control_App/adapters/mac-mini
./setup.sh
```

Interactive prompts: `MC_BASE_URL`, `MC_WORKDIR`, executor preset, and the agent
token. Or run non-interactively:

```bash
MC_AGENT_TOKEN=mca_xxx ./setup.sh --preset nvidia-minimax --yes
```

### Flags

| flag | effect |
|------|--------|
| `--preset <name>` | `codex` \| `gemini` \| `nvidia-minimax` \| `shell` \| `http` (default `shell`) |
| `--no-shell` | force `MC_ALLOW_SHELL=0` (adapter won't run shell commands) |
| `--yes` | non-interactive; loads launchd at the end |
| `--no-launchd` | install + smoke test only |

## What it does

1. Copies `mc_adapter.py` to `~/.openclaw/mc-adapter/`.
2. Writes `~/.openclaw/mc-adapter/mc.env` (chmod 600) from the chosen preset,
   overlaid with your `MC_BASE_URL` / token / workdir.
3. Renders `~/Library/LaunchAgents/com.7ei.mc-adapter.plist` for the current
   user (sources `mc.env` then execs the adapter; `KeepAlive` restarts on crash).
4. Runs one `--once` poll pass as a smoke test.
5. Optionally `launchctl load -w` the service (survives reboot).

## The LLM key is not stored on disk

`mc.env` intentionally leaves `MC_LLM_API_KEY` **empty**. At boot the adapter
calls `GET /api/agent/secrets` and injects the org's scoped secrets into its
environment — so set `MC_LLM_API_KEY` once in the app (**Cockpit → Secrets**,
encrypted at rest) and every adapter host picks it up. `llm_chat()` and the
`auto` executor read the key from the environment at call time, so the injected
value is used and no plaintext key ever lands in `mc.env`.

## Operate

```bash
tail -f ~/.openclaw/mc-adapter/adapter.log        # live logs
launchctl unload ~/Library/LaunchAgents/com.7ei.mc-adapter.plist   # stop
launchctl load -w ~/Library/LaunchAgents/com.7ei.mc-adapter.plist  # start
```

To upgrade the adapter, re-run `./setup.sh` (it overwrites `mc_adapter.py` and
reloads the service). See `../openclaw/README.md` for the execution model and
`../../GO-LIVE.md` for the full production runbook.
