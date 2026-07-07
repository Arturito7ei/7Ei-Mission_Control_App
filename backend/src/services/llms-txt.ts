// ─── llms.txt — agent-facing install/context doc (MCA-85 D2) ─────────────────
// A concise, machine-readable index (per https://llmstxt.org) that tells an AI
// agent or tool what 7Ei Mission Control is, how to authenticate, and where the
// canonical machine-readable surface lives (the OpenAPI 3.1 spec from D1).
//
// Served public at GET /llms.txt from the API host; a static mirror lives at
// web/public/llms.txt so it also resolves at the web/apex domain (7ei.ai/llms.txt).
// Pure builder — the route interpolates the live PUBLIC_URL as `apiUrl`.

export interface LlmsTxtOptions {
  /** Base URL of the running backend (agents hit this). Default: prod Fly host. */
  apiUrl?: string
  /** Web console URL. Default: app.7ei.ai. */
  appUrl?: string
  /** npm package name for the CLI. */
  cliPackage?: string
}

const trimSlash = (u: string) => u.replace(/\/+$/, '')

export function buildLlmsTxt(opts: LlmsTxtOptions = {}): string {
  const api = trimSlash(opts.apiUrl ?? 'https://7ei-backend.fly.dev')
  const app = trimSlash(opts.appUrl ?? 'https://app.7ei.ai')
  const cli = opts.cliPackage ?? '@7ei/mc'
  const repo = 'https://github.com/Arturito7ei/7Ei-Mission_Control_App'

  return `# 7Ei Mission Control

> 7Ei Mission Control is an AI-agent "virtual office" control plane: stand up an
> organisation of AI agents — a Chief of Staff (Arturito) plus specialist heads —
> assign them tasks, and let them collaborate, remember context across sessions,
> and run on a schedule. External "bring-your-own" agent runtimes connect over a
> token-authenticated HTTP API.

This file helps AI agents and tools discover how to install, authenticate, and
operate against 7Ei Mission Control. The OpenAPI spec below is the source of truth.

## Quick start (external agent)

- Install the CLI: \`npm i -g ${cli}\` (or run ad-hoc: \`npx ${cli} <command>\`).
- Onboard — mint an org, an external agent, and its token in one step:
  \`npx ${cli} onboard --org-name "My Org" --name "Scout" --runtime custom\`
  Needs a Clerk session token in \`MC_CLERK_TOKEN\` (copy it from ${app}). The
  command prints an agent token — set it as \`MC_AGENT_TOKEN\` (shown once).
- Drive the agent: \`7ei-mc me\`, \`7ei-mc tasks\`, \`7ei-mc claim <id>\`,
  \`7ei-mc result <id> done "…"\`.

## API

- [OpenAPI 3.1 spec](${api}/api/openapi.json): machine-readable and always
  current — generated from the live route table, so it cannot drift. Start here.
- Base URL: \`${api}\` (override with \`MC_BASE_URL\`).
- Auth: external agents send \`Authorization: Bearer mca_…\` (mint via \`onboard\`
  or Cockpit → agent card). The web console API uses Clerk session JWTs.
- Health: [${api}/api/health](${api}/api/health).

## Agent API (token-authed)

- \`GET /api/agent/me\` — the calling agent's identity.
- \`GET /api/agent/tasks?state=assigned\` — the agent's queue.
- \`POST /api/agent/tasks/:id/claim\` — atomic checkout (returns runId + sessionState).
- \`POST /api/agent/tasks/:id/result\` — report \`{ status, output }\`.
- \`POST /api/agent/tasks/:id/comment\` — comment on a ticket.
- \`POST /api/agent/heartbeat\` — liveness.
- \`GET|PUT /api/agent/memory/*\` — the shared memory vault.

## Docs

- [CLI README](${repo}/blob/main/cli/README.md)
- [API reference](${repo}/blob/main/docs/API.md)
- [Repository](${repo})

## Optional

- [Web console](${app}): create orgs, hire agents, and watch the live cockpit.
`
}
