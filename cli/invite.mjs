// Epic ONB / ONB6 — the CLI half of invite-based onboarding. Pure planners only
// (argv → { method, path, body } + config), so mc.mjs owns all IO and this stays
// unit-testable with no network. Two audiences, two flows:
//
//   * `invite create` — the OPERATOR mints an invite. Clerk-authed (owner-gated on
//     the backend). Prints the invite token + the copy-able onboarding PROMPT + the
//     doc URL. It NEVER prints a claimed agent token — there is no agent key at this
//     step (the key is minted only when the joining agent claims it, ONB4), and this
//     command deliberately has no path that could ever surface one.
//
//   * `onboard --invite <token>` — the AGENT-SIDE client. Invite-token-bearer (NO
//     Clerk): join → poll the claim until a human approves → claim once → write a
//     chmod-600 `mc.env`. The claimed token is written to the file and is NEVER
//     printed to stdout (adapters/CLAUDE.md + the ONB4 anti-transcript rule).

import { parseFlags } from './onboard.mjs'

// ─── `invite create` (operator, Clerk-authed) ───────────────────────────────

/** argv (after `invite create`) → validated operator config. Throws on bad input. */
export function parseInviteCreate(args) {
  const f = parseFlags(args)
  const orgId = typeof f.org === 'string' ? f.org : null
  if (!orgId) throw new Error('provide --org <id> (the org the invite belongs to)')

  // --adapter may repeat (parseFlags keeps the last for a duplicated key), so we
  // also accept a comma-separated list. Omitted → "any invitable adapter".
  let adapters = null
  if (typeof f.adapter === 'string') {
    adapters = f.adapter.split(',').map((s) => s.trim()).filter(Boolean)
    if (adapters.length === 0) adapters = null
  }

  const cfg = {
    orgId,
    allowedAdapterTypes: adapters,
    maxUses: f.uses !== undefined ? Number(f.uses) : undefined,
    expiresInHours: f['ttl-hours'] !== undefined ? Number(f['ttl-hours']) : undefined,
    message: typeof f.message === 'string' ? f.message : undefined,
    dryRun: f['dry-run'] === true,
  }
  if (cfg.maxUses !== undefined && (!Number.isInteger(cfg.maxUses) || cfg.maxUses < 1)) {
    throw new Error('--uses must be a positive integer')
  }
  if (cfg.expiresInHours !== undefined && (!Number.isFinite(cfg.expiresInHours) || cfg.expiresInHours <= 0)) {
    throw new Error('--ttl-hours must be a positive number')
  }
  return cfg
}

/** The owner-gated create-invite request. The backend returns the token + the
 *  onboarding prompt exactly once (never stored, never re-fetchable). */
export function inviteCreateRequest(cfg) {
  const body = {}
  if (cfg.allowedAdapterTypes) body.allowedAdapterTypes = cfg.allowedAdapterTypes
  if (cfg.maxUses !== undefined) body.maxUses = cfg.maxUses
  if (cfg.expiresInHours !== undefined) body.expiresInHours = cfg.expiresInHours
  if (cfg.message !== undefined) body.message = cfg.message
  return { method: 'POST', path: `/api/orgs/${cfg.orgId}/agent-invites`, body }
}

// ─── `onboard --invite <token>` (agent-side, invite-token-bearer) ───────────

/** argv (after `onboard`, when `--invite` is present) → agent-side config. */
export function parseAgentOnboard(args) {
  const f = parseFlags(args)
  const invite = typeof f.invite === 'string' ? f.invite : null
  if (!invite) throw new Error('agent-side onboard needs --invite <token>')

  const cfg = {
    invite,
    adapterType: typeof f.adapter === 'string' ? f.adapter : null,
    agentName: typeof f.name === 'string' ? f.name : null,
    capabilities: typeof f.capability === 'string'
      ? f.capability.split(',').map((s) => s.trim()).filter(Boolean)
      : ['machine_exec'],
    mcApiUrl: typeof f['mc-url'] === 'string' ? f['mc-url'].replace(/\/+$/, '') : null,
    workdir: typeof f.workdir === 'string' ? f.workdir : null,
    out: typeof f.out === 'string' ? f.out : 'mc.env',
    pollSeconds: f['poll-seconds'] !== undefined ? Number(f['poll-seconds']) : 5,
    maxWaitSeconds: f['max-wait'] !== undefined ? Number(f['max-wait']) : 600,
    dryRun: f['dry-run'] === true,
  }
  if (!cfg.adapterType) throw new Error('--adapter <type> is required (e.g. openclaw_local, claude_code)')
  if (!cfg.agentName) throw new Error('--name <name> is required')
  return cfg
}

/** The public join request. Strictly-typed body — mirrors the ONB3 route schema.
 *  `mcApiUrl` (when known) rides in agentDefaultsPayload, as the doc instructs. */
export function joinRequestPlan(cfg) {
  const agentDefaultsPayload = {}
  if (cfg.workdir) agentDefaultsPayload.workdir = cfg.workdir
  if (cfg.mcApiUrl) agentDefaultsPayload.mcApiUrl = cfg.mcApiUrl
  return {
    method: 'POST',
    path: `/api/agent-invites/${cfg.invite}/join`,
    public: true,
    body: {
      agentName: cfg.agentName,
      adapterType: cfg.adapterType,
      capabilities: cfg.capabilities,
      ...(Object.keys(agentDefaultsPayload).length ? { agentDefaultsPayload } : {}),
    },
  }
}

/** The public one-time claim. Spent once, after approval; returns the raw token. */
export function claimRequestPlan(requestId, claimSecret) {
  return {
    method: 'POST',
    path: `/api/agent-join-requests/${requestId}/claim-api-key`,
    public: true,
    body: { claimSecret },
  }
}

/**
 * The `mc.env` body written after a successful claim.
 *
 * ONLY MC_BASE_URL / MC_AGENT_TOKEN / MC_WORKDIR + non-secret flags — never an LLM
 * key (the standing `adapters/CLAUDE.md` rule; the LLM key is served from the
 * encrypted store via GET /api/agent/secrets). The token is written here and is
 * NEVER echoed to stdout.
 */
export function mcEnvLines(cfg, baseUrl, token) {
  const lines = [`MC_BASE_URL=${baseUrl}`, `MC_AGENT_TOKEN=${token}`]
  if (cfg.workdir) lines.push(`MC_WORKDIR=${cfg.workdir}`)
  lines.push(`# adapter: ${cfg.adapterType} — start the matching adapter with this mc.env sourced.`)
  return lines.join('\n') + '\n'
}

export const INVITE_HELP = `7ei-mc invite — create an agent invite (operator, Clerk-authed)
auth: MC_CLERK_TOKEN (a Clerk session JWT from the web console) — NOT an agent token
env:  MC_BASE_URL (default https://7ei-backend.fly.dev)

  invite create --org <id> [flags]      mint an invite; prints the token + the
                                         copy-able onboarding prompt (shown ONCE)

  --org <id>            org the invite belongs to           (required)
  --adapter <type>      restrict to adapter type(s), comma-separated
                        (omit → any invitable adapter)
  --uses <n>            max uses                             (default 1, single-use)
  --ttl-hours <n>       time to live in hours               (default 72, max 168)
  --message <text>      operator note shown in the doc/prompt (context, not a step)
  --dry-run             print the planned request without calling the backend

The invite token and the onboarding prompt are shown EXACTLY ONCE and cannot be
re-fetched — a lost invite is re-created, not recovered. This command never prints
a claimed agent key: the key is minted only when the joining agent claims it.

example:
  MC_CLERK_TOKEN=... 7ei-mc invite create --org org_42 --adapter claude_code --ttl-hours 48`

export const AGENT_ONBOARD_HELP = `7ei-mc onboard --invite <token> — agent-side onboarding client (no Clerk)
env:  MC_BASE_URL (default https://7ei-backend.fly.dev)

Drives the whole flow for the runtime you are onboarding: submit a join request,
wait for a human to approve it, claim the one-time key, and write a chmod-600
mc.env. The claimed token is written to the file and is NEVER printed.

  --invite <token>     the mci_inv_ invite token                     (required)
  --adapter <type>     your adapterType (openclaw_local|claude_code|…) (required)
  --name <name>        the name to register under                     (required)
  --capability <c,…>   requested capabilities (default machine_exec)
  --mc-url <url>       Mission Control base URL (default MC_BASE_URL)
  --workdir <path>     absolute workdir → mc.env MC_WORKDIR
  --out <path>         where to write mc.env                          (default ./mc.env)
  --poll-seconds <n>   how often to re-try the claim while pending    (default 5)
  --max-wait <n>       give up waiting for approval after n seconds    (default 600)
  --dry-run            print the planned join request and exit

example:
  7ei-mc onboard --invite mci_inv_… --adapter claude_code --name "Scout" --workdir /path/to/checkout`
