// Pure planner for `7ei-mc onboard` (MCA-85 D2).
// Wraps the org + external-agent + token mint into one guided flow. No IO here
// (argv → config + request builders) so it is unit-testable; mc.mjs runs it.
//
// Both mint endpoints are Clerk-secured, so onboard authenticates with the
// operator's Clerk session JWT (MC_CLERK_TOKEN), not an agent token.

export const RUNTIMES = ['openclaw', 'cursor', 'claude_code', 'custom']

/** Parse `--key value`, `--key=value`, and bare `--flag` (boolean) into an object. */
export function parseFlags(args) {
  const out = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (!a.startsWith('--')) throw new Error(`unexpected argument: ${a} (flags look like --key value)`)
    const body = a.slice(2)
    const eq = body.indexOf('=')
    if (eq >= 0) { out[body.slice(0, eq)] = body.slice(eq + 1); continue }
    const next = args[i + 1]
    if (next === undefined || next.startsWith('--')) { out[body] = true }
    else { out[body] = next; i++ }
  }
  return out
}

/** argv (after `onboard`) → validated onboard config. Throws on bad input. */
export function parseOnboard(args) {
  const f = parseFlags(args)
  const cfg = {
    dryRun: f['dry-run'] === true,
    orgId: typeof f.org === 'string' ? f.org : null,
    orgName: typeof f['org-name'] === 'string' ? f['org-name'] : null,
    agent: {
      name: typeof f.name === 'string' ? f.name : 'Scout',
      role: typeof f.role === 'string' ? f.role : 'External Agent',
      runtime: typeof f.runtime === 'string' ? f.runtime : 'custom',
      llmProvider: typeof f.provider === 'string' ? f.provider : 'minimax',
      llmModel: typeof f.model === 'string' ? f.model : 'minimax',
    },
  }
  if (!cfg.orgId && !cfg.orgName) throw new Error('provide --org <id> (use an existing org) or --org-name <name> (create one)')
  if (cfg.orgId && cfg.orgName) throw new Error('use either --org or --org-name, not both')
  if (!RUNTIMES.includes(cfg.agent.runtime)) throw new Error(`--runtime must be one of: ${RUNTIMES.join(', ')}`)
  return cfg
}

/** Request that creates a new org (only when --org-name was given). */
export function orgRequest(cfg) {
  return { method: 'POST', path: '/api/orgs', body: { name: cfg.orgName } }
}

/** Request that mints an external agent + its token in the given org. */
export function agentRequest(cfg, orgId) {
  return { method: 'POST', path: `/api/orgs/${orgId}/agents/external`, body: cfg.agent }
}

export const ONBOARD_HELP = `7ei-mc onboard — mint an org + external agent + token against a running backend
auth: MC_CLERK_TOKEN (a Clerk session JWT from the web console) — NOT an agent token
env:  MC_BASE_URL (default https://7ei-backend.fly.dev)

  --org-name <name>    create a new org (auto-creates Arturito)
  --org <id>           OR mint into an existing org
  --name <name>        external agent name        (default: Scout)
  --role <role>        external agent role         (default: External Agent)
  --runtime <r>        ${RUNTIMES.join('|')}   (default: custom)
  --provider <p>       LLM provider                (default: minimax)
  --model <m>          LLM model                   (default: minimax)
  --dry-run            print the planned requests without calling the backend

example:
  MC_CLERK_TOKEN=... npx @7ei/mc onboard --org-name "Acme" --name Scout --runtime custom`
