// Epic CC / CC4 — per-runtime adapter profile for the onboarding surfaces.
//
// The Hire dialog + Add-Agent wizard both need to print the correct `mc.env` +
// run command for the runtime the operator picked. Before CC4, `claude_code`
// fell through to the OpenClaw run-command (wrong adapter, wrong env). This pure
// helper is the single source of truth for "which adapter + which env" so both
// components stay in sync and it's unit-testable.

export type Runtime = 'openclaw' | 'cursor' | 'claude_code' | 'custom'

export interface AdapterEnvLine {
  key: string
  value: string
}

export interface AdapterProfile {
  runtime: string
  /** repo-relative path to the adapter to run */
  adapter: string
  /** interpreter for the adapter */
  runner: string
  /** extra env lines beyond MC_BASE_URL + MC_AGENT_TOKEN */
  env: AdapterEnvLine[]
  /** one-line hint shown under the token */
  note: string
}

// Default working dir hints. The vault is right for the OpenClaw ops agent; a
// code executor should point at a code checkout, not the vault.
const VAULT_WORKDIR = '/Users/artutito/7Ei-MC_TARCO'
const CHECKOUT_HINT = '/path/to/your/checkout'

const PROFILES: Record<string, AdapterProfile> = {
  openclaw: {
    runtime: 'openclaw',
    adapter: 'adapters/openclaw/mc_adapter.py',
    runner: 'python3',
    env: [
      { key: 'MC_EXECUTOR', value: 'auto' },
      { key: 'MC_ALLOW_SHELL', value: '1' },
      { key: 'MC_WORKDIR', value: VAULT_WORKDIR },
    ],
    note: 'Drop the block on the OpenClaw host and the agent is live.',
  },
  cursor: {
    runtime: 'cursor',
    adapter: 'adapters/cursor/cursor_adapter.py',
    runner: 'python3',
    env: [{ key: 'MC_INBOX', value: '$PWD/coordination/inbox' }],
    note: 'Run on the Cursor host; the agent writes work orders to the inbox.',
  },
  claude_code: {
    runtime: 'claude_code',
    adapter: 'adapters/claude-code/cc_adapter.py',
    runner: 'python3',
    env: [
      { key: 'MC_WORKDIR', value: CHECKOUT_HINT },
      // Propose-and-approve by default: Claude plans, never edits/executes on the
      // host. Autonomous exec is off (two guards, CC6) — do not set it here.
      { key: 'CC_PERMISSION_MODE', value: 'plan' },
    ],
    note: 'Run on a host with the `claude` CLI installed + logged in. Propose-and-approve (plan mode) — no host commands run without approval.',
  },
  custom: {
    runtime: 'custom',
    adapter: 'adapters/openclaw/mc_adapter.py',
    runner: 'python3',
    env: [
      { key: 'MC_EXECUTOR', value: 'auto' },
      { key: 'MC_WORKDIR', value: VAULT_WORKDIR },
    ],
    note: 'Bring-your-own runtime — configure the executor for your host.',
  },
}

/** Resolve the adapter profile for a runtime (falls back to openclaw). */
export function adapterProfile(runtime: string | null | undefined): AdapterProfile {
  return PROFILES[String(runtime ?? '').trim()] ?? PROFILES.openclaw
}

/** The `mc.env` file body for a runtime: MC_BASE_URL + MC_AGENT_TOKEN + the
 *  runtime's extra env lines. `token` may be a placeholder before it's minted. */
export function mcEnv(runtime: string, apiBase: string, token: string): string {
  const p = adapterProfile(runtime)
  const lines = [`MC_BASE_URL=${apiBase}`, `MC_AGENT_TOKEN=${token}`]
  for (const e of p.env) lines.push(`${e.key}=${e.value}`)
  return lines.join('\n')
}

/** The full copy-paste block: `mc.env` + the source + run command, matching the
 *  runtime's real adapter (not the OpenClaw one for every runtime). */
export function runBlock(runtime: string, apiBase: string, token: string): string {
  const p = adapterProfile(runtime)
  return [
    '# mc.env',
    mcEnv(runtime, apiBase, token),
    '',
    `# run on the ${p.runtime} host:`,
    'set -a; source mc.env; set +a',
    `${p.runner} ${p.adapter}`,
  ].join('\n')
}
