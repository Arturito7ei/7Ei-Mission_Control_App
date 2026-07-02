# Claude config + architecture review — 2026-07-02

Audit of the repo's agent-instruction setup (CLAUDE.md), the layered structure now implemented, a design for per-agent / per-project config under 7Ei_OS, and prioritized architecture recommendations. Grounded in the official Claude Code memory/monorepo guidance (docs: code.claude.com `/en/memory`, `/en/large-codebases`) and a full repo survey.

---

## 1. CLAUDE.md audit (what was wrong, what changed)

How loading actually works (verified against current docs):

- Root `CLAUDE.md` loads **in full at launch** and is re-injected after `/compact`.
- A `CLAUDE.md` inside a subdirectory loads **on demand** — only when Claude reads files there. This is the mechanism that makes per-subsystem files cheap.
- `@path` imports load **at launch** — they organize, they don't save context.
- `.claude/rules/*.md` with `paths:` frontmatter load only when matching files are touched.
- Guidance: keep each file **under ~200 lines**; longer files reduce adherence. Block-level HTML comments are stripped before injection (free maintainer notes).

Findings on the previous single-file setup:

1. **One file carried three unrelated audiences.** Backend patterns, web conventions, and adapter rules all loaded for every session — including sessions that never touch that subsystem. Cost: context + diluted adherence.
2. **State duplicated into instructions.** The "Current state" section repeated STATUS.md — this is exactly how the March-2026 staleness happened (instructions don't get bumped when state changes). Instructions and state need different owners: STATUS.md is bumped per story; CLAUDE.md should change rarely.
3. **No Layer-0 pointer.** The vault repo's CLAUDE.md references `Arturito7ei/7Ei_OS`; the Mission Control repo didn't — so agents working here had no path to the org-wide protocols.
4. **The `app/` (Expo) ambiguity** was the root cause of past drift — the stale file treated it as active. Now explicitly marked LEGACY/frozen in the tree.

### Implemented layout

```
CLAUDE.md            ~45 lines  — orientation, Layer-0 pointer, verify commands, cross-cutting rules
backend/CLAUDE.md    ~90 lines  — critical files, auth model, DB/migration rules, patterns, testing, env, cloud table
web/CLAUDE.md        ~25 lines  — tokens, a11y, deploy lag, "no shared API client yet" guidance
adapters/CLAUDE.md   ~25 lines  — stdlib-only rule, secret-store contract, live-deploy safety rule, NIM quirk
```

Working in `backend/` loads root + backend only; web sessions never pay for the cloud-provider table; the root stays under its 70-line budget (enforced by a maintainer comment). Rule of thumb going forward: **state → STATUS.md · procedures → skills or docs/ · subsystem conventions → nearest CLAUDE.md · org protocols → 7Ei_OS**.

---

## 2. Per-agent + per-project config under 7Ei_OS

The pieces already exist: `Arturito7ei/7Ei_OS` (protocols: memory, governance, coordination, spawning…), the vault (shared knowledge + `Memory/agents/`), and per-repo CLAUDE.md files. The design below wires them together without inventing a new layer.

### Principle: three planes, one source each

| Plane | Source of truth | Consumed how |
|---|---|---|
| **Org protocols** (all agents, all projects) | `7Ei_OS/protocols/` | Loaded at session start, small and stable |
| **Project conventions** (per repo/subsystem) | `CLAUDE.md` layered in each repo (this repo now does it) | Versioned with the code, PR-reviewed |
| **Knowledge & state** (grows daily) | Vault + STATUS.md | Retrieved on demand — never inlined into instructions |

### Per-project

Every 7Ei repo gets the same shape as this one: a thin root CLAUDE.md whose first section points to 7Ei_OS, plus per-subsystem files where the repo is big enough to warrant them. The vault repo already follows the thin-root pattern.

### Per-agent — recommended mechanics

Add an `agents/` directory to 7Ei_OS: `agents/<agent-name>.md` holds that agent's identity, scope, and standing orders (what Arturito R2D2 may do autonomously vs. the CTO agent, etc. — the vault's `07-Agents/Agent — *.md` notes are the raw material; the 7Ei_OS copy is the operational contract).

Each agent runtime then consumes its own file through the mechanism native to it:

1. **Claude Code / Cowork agents** (one identity per machine or checkout): user-level `~/.claude/CLAUDE.md` containing two imports:
   ```markdown
   @~/7Ei_OS/protocols/principles.md
   @~/7Ei_OS/agents/<this-agent>.md
   ```
   Requires a local checkout of 7Ei_OS (a `git pull` in launchd/cron keeps it fresh). Alternative with the same effect: symlink `~/.claude/rules/7ei -> ~/7Ei_OS/rules/` — rules dirs support symlinks and can be path-scoped.
2. **Mission Control agents** (OpenClaw/MiniMax via the adapter): they never read CLAUDE.md — their identity comes from `buildSystemPrompt()` (TOR + org context). Make 7Ei_OS canonical here too: a small backend story to sync `agents/<name>.md` → the agent's `termsOfReference` (via the existing vault/GitHub connector, on change or on a routine). One file then drives both a Claude Code session and the MC runtime.
3. **Other tools** (Cursor, etc.): keep a repo-level `AGENTS.md` as the interop file and make `CLAUDE.md` import it (`@AGENTS.md`) or symlink it, per the official interop pattern. Only worth doing in repos actually touched by non-Claude tools.

What NOT to do: don't put per-agent files inside each project repo (N agents × M repos = drift matrix), and don't sync instructions through the vault (the vault is knowledge; Obsidian edits bypass PR review — instructions should ship like code).

### Suggested 7Ei_OS additions

```
7Ei_OS/
├── protocols/            (exists)
├── agents/               NEW — one operational contract per agent
│   ├── _template.md
│   ├── arturito-r2d2.md
│   ├── cto.md
│   └── openclaw-mac-mini.md
└── rules/                NEW (optional) — path-scoped rules symlinked into repos that want them
```

---

## 3. Architecture recommendations (prioritized)

From the repo survey (line counts and paths verified 2026-07-02). The platform is healthy: 29 services all <320 lines, clean auth separation (Clerk JWT for web; hashed long-lived agent tokens for the agent API; AES-256-GCM scoped secrets), 415 tests + boot-collision guard, idempotent migrations. The items below are the real debt, ordered by value:

1. **Split `backend/src/routes/all.ts` (1,383 lines).** The one god file. Mechanical split into `orgs.ts, agents.ts, tasks.ts, projects.ts, costs.ts, skills.ts` route modules; `boot.test.ts` already guards against collision regressions, making this low-risk. Highest-value refactor: it's the file every backend task reads. (1 story)
2. **Fix the routes→services inversion.** `agent-executor.ts` and `scheduler.ts` import `sendPushNotification()` from a routes file — the only violation of the "services are pure helpers" rule. Extract to `services/push.ts`. Do it inside story #1. (small)
3. **Centralize the web API client.** Every dashboard panel duplicates `fetch` + auth headers inline. Add `web/lib/api.ts`; migrate panels opportunistically. Prerequisite for splitting `CockpitPanel.tsx` (808 lines) and for actually adopting the design tokens, which exist but are barely used. (1–2 stories)
4. **Decide `app/` (Expo).** 7.2K LOC, diverged from web, historically the source of doc drift. Either archive to a branch and delete from `main` (recommended — PWA already covers mobile per MCA-65) or freeze with a CI guard that fails PRs touching it without a label. Cheap decision, permanent clarity. (decision + 1 small PR)
5. **Resolve prod `pinecone: false` / `redis: false`.** RAG search and distributed rate-limiting are silently off in prod — features the code advertises. Either set the keys (user console action) or make degraded mode explicit in `/api/health` consumers and the Cockpit. Also still open from MCA-33: rate limits on the agent API.
6. **7Ei_OS sync story (§2.2 above).** TOR sync from `7Ei_OS/agents/` — makes the per-agent design real for non-Claude runtimes. (1 story)

Suggested order: 1+2 → 4 (decision) → 3 → 6 → 5 rides on the GO-LIVE console work.
