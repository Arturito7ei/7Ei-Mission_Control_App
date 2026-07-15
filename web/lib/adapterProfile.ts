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
  /** Whether this adapter's run loop honors the `MC_ALLOW_SHELL` env flag. The
   *  OpenClaw poll loop (`mc_adapter.py`) does; Cursor's file inbox and Claude
   *  Code's plan-mode permission model do not. Shell-capable runtimes get an
   *  explicit `MC_ALLOW_SHELL` line in `mc.env` — OFF by default (opt-in per
   *  agent), matching the server registry's `allowShell: false` safety default
   *  (`backend/src/services/adapter-registry.ts`). */
  honorsShellFlag?: boolean
}

/** Options for the generated run-block / mc.env. */
export interface RunBlockOptions {
  /** Opt a NEW agent into host shell execution (`MC_ALLOW_SHELL=1`). Default
   *  OFF, so a freshly-onboarded agent cannot run host commands unless the
   *  operator deliberately turns it on. Existing agents are unaffected: their
   *  `mc.env` already lives on their host and is never rewritten by the wizard,
   *  and the adapter reads the flag from its own local env — the server never
   *  gates shell from the registry, so nothing is retroactively disabled. */
  allowShell?: boolean
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
    // MC_ALLOW_SHELL is intentionally NOT a static line here — mcEnv() appends it
    // (default OFF) for shell-capable runtimes, so new agents match the registry's
    // allowShell:false default and only get shell when the operator opts in.
    env: [
      { key: 'MC_EXECUTOR', value: 'auto' },
      { key: 'MC_WORKDIR', value: VAULT_WORKDIR },
    ],
    honorsShellFlag: true,
    note: 'Drop the block on the OpenClaw host and the agent is live. Shell execution is OFF unless you opt in.',
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
    honorsShellFlag: true,
    note: 'Bring-your-own runtime — configure the executor for your host. Shell execution is OFF unless you opt in.',
  },
}

/** Resolve the adapter profile for a runtime (falls back to openclaw). */
export function adapterProfile(runtime: string | null | undefined): AdapterProfile {
  return PROFILES[String(runtime ?? '').trim()] ?? PROFILES.openclaw
}

/** Does this runtime's adapter honor `MC_ALLOW_SHELL`? Only shell-capable
 *  runtimes show the operator a shell opt-in. */
export function honorsShellFlag(runtime: string | null | undefined): boolean {
  return !!adapterProfile(runtime).honorsShellFlag
}

/** The `mc.env` file body for a runtime: MC_BASE_URL + MC_AGENT_TOKEN + the
 *  runtime's extra env lines. `token` may be a placeholder before it's minted.
 *  Shell-capable runtimes get an explicit `MC_ALLOW_SHELL` line — OFF unless
 *  `opts.allowShell` is set, so new agents default to shell-off. */
export function mcEnv(runtime: string, apiBase: string, token: string, opts: RunBlockOptions = {}): string {
  const p = adapterProfile(runtime)
  const lines = [`MC_BASE_URL=${apiBase}`, `MC_AGENT_TOKEN=${token}`]
  for (const e of p.env) lines.push(`${e.key}=${e.value}`)
  if (p.honorsShellFlag) lines.push(`MC_ALLOW_SHELL=${opts.allowShell ? '1' : '0'}`)
  return lines.join('\n')
}

/** The full copy-paste block: `mc.env` + the source + run command, matching the
 *  runtime's real adapter (not the OpenClaw one for every runtime). */
export function runBlock(runtime: string, apiBase: string, token: string, opts: RunBlockOptions = {}): string {
  const p = adapterProfile(runtime)
  return [
    '# mc.env',
    mcEnv(runtime, apiBase, token, opts),
    '',
    `# run on the ${p.runtime} host:`,
    'set -a; source mc.env; set +a',
    `${p.runner} ${p.adapter}`,
  ].join('\n')
}
