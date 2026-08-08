# AGENTS.md

Root operating guide is `CLAUDE.md` (+ `backend/CLAUDE.md`, `web/CLAUDE.md`). This file
adds only the durable, non-obvious environment notes that live agents need.

## Cursor Cloud specific instructions

This is an npm-workspaces monorepo, but **each workspace installs from its own lockfile**
(`backend/`, `web/`, `app/`, `apps/mobile/`, `apps/desktop/`). There is no root install.
The startup update script runs `npm install` in `backend/` and `web/` (the primary E2E
stack). Node 22 is required and already present.

### Services (dev)

| Service | Dir | Dev command | Port | Standard commands |
|---|---|---|---|---|
| Backend API (Fastify + Drizzle + libSQL/Turso) | `backend/` | `npm run dev` | 3001 | see `backend/CLAUDE.md` (`npm test`, `npm run evals`, `npm run typecheck`) |
| Web dashboard (Next.js 15) — PRIMARY UI | `web/` | `npm run dev` | 3000 | see `web/CLAUDE.md` (`npm test`, `npm run build`, `npm run typecheck`) |

- Backend boots self-contained: with no `.env` it uses a local SQLite file (`DATABASE_URL=file:./dev.db`), auto-creates the schema on boot, and reports readiness at `GET /api/health` (`db:"connected"`). Optional integrations (Anthropic/OpenAI/Gemini, Clerk, Pinecone, Redis, Google, Jira) are each guarded by an env-var check and are skipped when unset — agents can't run real LLM work without `ANTHROPIC_API_KEY`, but everything else boots.
- `web` reads the backend URL from `NEXT_PUBLIC_API_URL` (default `http://localhost:3001`).

### Lint is NOT a CI gate (don't chase it)

`.github/workflows/ci.yml` gates only **typecheck + test + build** (installing with
`npm install --legacy-peer-deps`). The `npm run lint` scripts are not wired: `backend`'s
`eslint` binary isn't installed, and `web`'s `next lint` prompts interactively because no
ESLint config exists. Use `npm run typecheck` as the static gate, not `npm run lint`.

### Running a live, signed-in dashboard needs Clerk (gotcha)

The live `web` dashboard (`/dashboard`) calls Clerk's `useAuth` unconditionally
(`web/app/dashboard/page.tsx`). Two consequences in a normal cloud dev tree:

- **Hosted mode**: set `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` + `CLERK_SECRET_KEY` (dev instance) and sign in. Without a key the dashboard bounces to `/` (no session).
- **Packaged/loopback web mode is NOT runnable from a plain `npm install` tree.** Its keyless fallback only triggers when `@clerk/nextjs` fails to `require()` (as in the Electron packaged build that strips Clerk). Here the package resolves, so `useAuth` runs without a `<ClerkProvider>` and the dashboard throws a client-side exception. Do not "fix" this in source — it's by design for the packaged build.
- The landing page `/` has no Clerk dependency and renders fine keyless (useful smoke check that `web` is serving).

### Exercising core functionality locally WITHOUT Clerk (backend packaged profile)

To create orgs/agents/tasks end-to-end with zero external secrets, run the **backend** in
the `packaged` profile and drive the REST API with the loopback bearer:

```bash
cd backend
MC_DEPLOYMENT_PROFILE=packaged \
SECRETS_ENC_KEY=<real-non-default> \
RUN_TOKEN_SECRET=<real-non-default-DISTINCT-from-enc> \
MC_LOOPBACK_SESSION_SECRET=<real-non-default> \
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:8081 \
npm run dev
```

- The fail-closed guard (`backend/src/services/secret-keys.ts`) refuses to boot if any of the three keys is missing/empty/a known dev default, or if `RUN_TOKEN_SECRET == SECRETS_ENC_KEY`. Use three distinct real strings.
- On boot it idempotently seeds org `local-org` owned by user `local-operator`.
- Authenticate every secured API call with `Authorization: Bearer <MC_LOOPBACK_SESSION_SECRET>`; a missing/wrong bearer is `401`. Example: `curl -H "Authorization: Bearer <secret>" http://localhost:3001/api/orgs`.
- If you also want the packaged web build to talk to it, the packaged web sends the literal bearer `mc-loopback` (`web/app/dashboard/page.tsx`), so set `MC_LOOPBACK_SESSION_SECRET=mc-loopback` — but note the packaged web caveat above (it won't run from a normal npm tree).
