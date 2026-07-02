# Self-hosting 7Ei Mission Control (MCA-DIST S5.3)

Run the whole stack on your own machine — libSQL + backend + web — with Docker.
This complements the hosted path (backend on Fly, web on Vercel).

## Quick start

```bash
export SECRETS_ENC_KEY=$(openssl rand -hex 16)     # 32-byte secret store key
export RUN_TOKEN_SECRET=$(openssl rand -hex 16)
docker compose up -d --build
```

- Web → http://localhost:3000
- Backend API → http://localhost:3001  (health: `/api/health`)
- libSQL (sqld) → http://localhost:8080

The backend runs its idempotent migrations on boot, so the DB is ready on first start.

## Modes

- **Trusted-local** — omit `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`;
  the web boots without auth for a single-operator local deployment.
- **Authenticated** — set the Clerk keys (web + backend) for multi-user access.

## Optional integrations (set as `backend` env)

`GITHUB_VAULT_TOKEN` (Obsidian shared memory) · `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`
(Gmail/Calendar/Drive) · connector tokens are stored per-org via the encrypted secret store.

## Evals

```bash
cd backend && npm run evals     # scored orchestration checks (CI-gatable)
```
