# Arturita Local Host daemon (C1)

A hardened, localhost-only capability service that lets Arturita inspect and act
on the operator's Mac — **the only component with filesystem access**. Sibling to
`adapters/mac-mini/`; runs as the operator user (no sudo), keep-alive via
launchd. This is the daemon **scaffold + the real read/preview/undo path**;
destructive execution is wired but **fails closed behind the A2 approval gate**.

## Safety model (S3, confirmed 2026-07-08)

The operator grants **full machine access** — the install assumes full control of
the machine. Protection comes from:

1. **Minimal self-protection denylist** (`src/safety.mjs`) — hard-refused for read
   *and* write: the host's own config/token (`~/.arturita-host`), the burner
   wallet keystore (`.arturita-keystore`, S4), SSH/GPG/cloud creds, keychains,
   `.env`/secret files, wallet vaults, and **OS system-integrity paths** (`/System`,
   `/usr` except `/usr/local`, `/bin`, `/sbin`, …). Arturita can't steal her own
   signing key or brick the OS.
2. **Symlink-safe path resolution** — every target is `realpath`-resolved before
   the denylist/root check, so a symlinked parent can't escape.
3. **Blast-radius caps** — auto-safe ≤ 10 files / 50 MB; over that (or any
   move/delete/overwrite) → needs approval; over 5000 files / 20 GB → refused.
4. **A2 approval gate + fail-closed** — destructive ops (`/apply`) require
   `approved: true` (an A2-approved backend command). Without it they are refused.
5. **Undo journal** — approved destructive ops stage originals (10-minute window);
   `/undo` restores them.
6. **Localhost + token** — binds `127.0.0.1` only; every request needs the shared
   bearer token; the daemon **refuses to start without one** (fail-closed).

## Capabilities (HTTP, `127.0.0.1:8799`)

| Route | Method | Gate | Purpose |
|---|---|---|---|
| `/health` | GET | none | liveness (no data) |
| `/list` | POST | token | list a directory (safe) |
| `/read` | POST | token | read a file, ≤ 5 MB (safe) |
| `/preview` | POST | token | preview manifest for a destructive op (no action) |
| `/apply` | POST | token + `approved:true` | perform an approved destructive op (staged/undoable) |
| `/undo` | POST | token | reverse a prior op within its window |

`machine_exec` is intentionally **not** exposed here yet (C3 — broad exec allowed
per S6, but the destructive subset stays A2-gated with argv shown verbatim).

## Install

```bash
cd adapters/arturita-host
./setup.sh                      # generates a token, writes the launchd plist, loads it
#   ARTURITA_HOST_ROOT=/  ./setup.sh   # for whole-machine root (default: $HOME)
```

Then, as the operator: grant the macOS TCC permissions when prompted (the Epic H
first-run wizard will guide this), and register the printed token in the backend
secret store as `ARTURITA_HOST_TOKEN`.

## Test

```bash
npm test          # node --test — real temp-dir FS: read/list/preview/undo + fail-closed destructive
```

## Files

- `src/safety.mjs` — denylist / system-integrity / symlink-safe access + blast caps (mirror of `backend/src/services/host-planner.ts`).
- `src/actions.mjs` — real FS read/list/preview + staged undo; destructive fail-closed.
- `src/server.mjs` — the localhost daemon (token auth, routes).
- `setup.sh` — installer + launchd keep-alive.
- `test/host.test.mjs` — end-to-end action-layer tests.
