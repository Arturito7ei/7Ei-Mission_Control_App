// Epic CC / CC5 — semantic shell-command allowlist / denylist.
//
// The single genuinely-new safety control the design flagged (R4): before CC5
// there was NO semantic denylist for shell commands — command control rested
// only on the A2 machine_exec approval + the host daemon not exposing an exec
// endpoint. This module is that control. It classifies a shell command into:
//
//   * deny  — a catastrophic / self-protection / exfil pattern. REFUSED
//             pre-approval: a denylisted command can't even be filed as an
//             approval, and the autonomous guard hook refuses to run it.
//   * allow — matches the (opt-in, per-agent) allowlist of safe commands. May
//             run WITHOUT a per-command approval — but ONLY in the CC6
//             autonomous posture; in propose-and-approve it still surfaces.
//   * gate  — everything else → the A2 machine_exec approval (verbatim argv +
//             step-up). This is the default; unknown ⇒ gated, never run.
//
// Pure + exhaustive + fail-closed. Mirrored by adapters/claude-code/cc_denylist.py
// (the host guard hook's twin) — keep them in sync, like host-planner.ts ↔
// arturita-host/safety.mjs. Precedence is ALWAYS deny > allow > gate: a
// denylisted command is refused even if it also matches an allow pattern.

export type CommandDecision = 'deny' | 'allow' | 'gate'

export interface CommandVerdict {
  decision: CommandDecision
  reason: string
  category?: string
}

export interface CommandPolicy {
  /** per-agent allowlist (regex source strings). When omitted, DEFAULT_ALLOWLIST is used. */
  allowlist?: string[]
  /** operator-added extra deny patterns (regex source strings), merged with the built-in denylist. */
  extraDenylist?: string[]
}

interface Rule { re: RegExp; reason: string; category: string }

// ── The denylist — catastrophic / self-protection / exfil (exhaustive) ───────
// Each pattern is tested case-insensitively against the whole normalized command
// AND each shell segment. Keep entries narrow enough to avoid false denies but
// broad enough to catch obvious variants.
const DENYLIST: Rule[] = [
  // Filesystem catastrophe
  { re: /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf][a-z]*\s+(-[a-z]*\s+)*(\/|~|\/\*|\$HOME|\.\.)(\s|$)/i, reason: 'recursive force-delete of / ~ or a parent', category: 'fs-catastrophe' },
  { re: /\brm\s+-[a-z]*[rf][a-z]*\s+-[a-z]*[rf][a-z]*\s+\/(\s|$)/i, reason: 'recursive force-delete of /', category: 'fs-catastrophe' },
  { re: /\bfind\s+(\/|~|\$HOME)\s+.*-delete/i, reason: 'find -delete from root/home', category: 'fs-catastrophe' },
  { re: /\b(shred|wipe)\b/i, reason: 'secure-erase utility', category: 'fs-catastrophe' },
  // Disk / partition / raw devices
  { re: /\bdd\b[^\n]*\bof=\/dev\//i, reason: 'dd writing to a raw device', category: 'disk' },
  { re: /\bmkfs(\.[a-z0-9]+)?\b/i, reason: 'filesystem format', category: 'disk' },
  { re: /\b(fdisk|parted|gpt)\b/i, reason: 'partition editor', category: 'disk' },
  { re: /\bdiskutil\s+(erase|partition|reformat)/i, reason: 'diskutil erase/partition', category: 'disk' },
  { re: />\s*\/dev\/(sd|nvme|disk|hd)[a-z0-9]/i, reason: 'redirect over a raw device', category: 'disk' },
  // Fork bomb
  { re: /:\s*\(\s*\)\s*\{[^}]*\|[^}]*&[^}]*\}\s*;\s*:/, reason: 'fork bomb', category: 'resource' },
  // Privilege escalation / system control
  { re: /\b(sudo|doas)\b/i, reason: 'privilege escalation (sudo/doas)', category: 'privilege' },
  { re: /(^|\s)su\s+-?\s*(root|-)?(\s|$)/i, reason: 'switch user', category: 'privilege' },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: 'power/shutdown control', category: 'system' },
  { re: /\bchmod\s+(-[a-z]*\s+)*[0-7]*777[0-7]*\s+(-[a-z]*\s+)*(\/|~)/i, reason: 'world-writable chmod on / ~', category: 'system' },
  { re: /\bchmod\s+-[a-z]*r[a-z]*\s+[0-7]{3,4}\s+(\/|~)/i, reason: 'recursive chmod on / ~', category: 'system' },
  { re: /\bchown\s+-[a-z]*r/i, reason: 'recursive chown', category: 'system' },
  { re: /\bcsrutil\s+disable/i, reason: 'disable macOS System Integrity Protection', category: 'system' },
  { re: /\bspctl\s+--master-disable/i, reason: 'disable Gatekeeper', category: 'system' },
  { re: /\b(pfctl|iptables|ufw|nftables)\b/i, reason: 'firewall manipulation', category: 'system' },
  { re: /\b(launchctl|systemctl)\s+(unload|disable|stop|remove)/i, reason: 'disable a system service', category: 'system' },
  // Pipe-to-shell / remote code execution
  { re: /\b(curl|wget|fetch)\b[^\n|]*\|\s*(sudo\s+)?(sh|bash|zsh|python[0-9.]*|node|ruby|perl)\b/i, reason: 'download piped straight into a shell', category: 'remote-exec' },
  { re: /\b(sh|bash|zsh)\s+-c\s+["']?\$\((curl|wget|fetch)/i, reason: 'shell -c of a remote fetch', category: 'remote-exec' },
  { re: /\beval\s+["']?\$\((curl|wget|fetch)/i, reason: 'eval of a remote fetch', category: 'remote-exec' },
  { re: /\bbase64\s+(-d|--decode)\b[^\n|]*\|\s*(sh|bash|zsh)/i, reason: 'base64-decode piped into a shell', category: 'remote-exec' },
  // Reverse shells / netcat
  { re: /\bnc\b[^\n]*\s-[a-z]*e\b/i, reason: 'netcat -e (reverse shell)', category: 'reverse-shell' },
  { re: /\/dev\/(tcp|udp)\//i, reason: '/dev/tcp reverse shell', category: 'reverse-shell' },
  { re: /\bbash\s+-i\b[^\n]*(>&|\d>&)/i, reason: 'interactive bash redirected to a socket', category: 'reverse-shell' },
  { re: /\bsocat\b[^\n]*exec/i, reason: 'socat exec (reverse shell)', category: 'reverse-shell' },
  { re: /\bmkfifo\b[^\n]*(nc|netcat|\/dev\/tcp)/i, reason: 'named-pipe reverse shell', category: 'reverse-shell' },
  // Credential / secret exfiltration (mirror of the host self-protection denylist)
  { re: /(\.ssh\b|id_rsa|id_ed25519|\.aws\/credentials|\.gnupg|\.env(\.| |$)|wallet\.dat|keystore|\.metamask|utc--)/i, reason: 'touches a credential / key / secret store', category: 'secret-exfil' },
  { re: /\bsecurity\s+(find-generic-password|find-internet-password|dump-keychain)/i, reason: 'macOS keychain dump', category: 'secret-exfil' },
  { re: /\b(cat|less|more|head|tail|strings)\b[^\n]*(_history|\.history|\.netrc)/i, reason: 'reads a shell-history / netrc file', category: 'secret-exfil' },
  // History / log tampering
  { re: /\bhistory\s+-c\b/i, reason: 'clears shell history', category: 'anti-forensics' },
  { re: /\bunset\s+HISTFILE\b/i, reason: 'disables shell history', category: 'anti-forensics' },
]

// ── The default allowlist — conservative, read-only-ish safe commands ────────
// Used only to grant "run without a per-command approval" in the CC6 autonomous
// posture. Anchored at the start of a segment (the leading binary).
export const DEFAULT_ALLOWLIST: string[] = [
  '^git\\s+(status|diff|log|show|branch|remote|rev-parse|describe|fetch|config\\s+--get)\\b',
  '^ls\\b', '^pwd$', '^echo\\b', '^cat\\s+[^|>]*$', '^head\\b', '^tail\\b', '^wc\\b',
  '^grep\\b', '^rg\\b', '^find\\s+[^|]*-(name|type|path)\\b', '^tree\\b', '^stat\\b', '^file\\b',
  '^npm\\s+(test|run\\s+test|run\\s+build|run\\s+lint|run\\s+typecheck|ci|install|ls)\\b',
  '^pnpm\\s+(test|build|install|lint)\\b', '^yarn\\s+(test|build|install|lint)\\b',
  '^node\\s+--test\\b', '^npx\\s+tsc\\b', '^tsc\\b', '^jest\\b', '^vitest\\b',
  '^python[0-9.]*\\s+-m\\s+(pytest|unittest)\\b', '^pytest\\b', '^ruff\\b', '^mypy\\b',
  '^cargo\\s+(build|test|check|clippy|fmt)\\b', '^go\\s+(build|test|vet|fmt)\\b',
]

// ── Normalization + segmentation ─────────────────────────────────────────────

function normalize(cmd: string): string {
  return String(cmd ?? '').replace(/\s+/g, ' ').trim()
}

/** Split a shell command on chaining operators so the leading-binary rules match
 *  each sub-command (`a && sudo b` → ['a', 'sudo b']). Whole-string rules (pipe-
 *  to-shell) are also checked separately. */
export function splitSegments(cmd: string): string[] {
  return normalize(cmd)
    .split(/\s*(?:&&|\|\||;|\||&|\n)\s*/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function compile(sources: string[] | undefined): RegExp[] {
  const out: RegExp[] = []
  for (const s of sources ?? []) {
    try { out.push(new RegExp(s, 'i')) } catch { /* skip an invalid operator pattern */ }
  }
  return out
}

// ── The decision ─────────────────────────────────────────────────────────────

/**
 * Classify a shell command. Fail-closed: an empty command → `gate` (never run
 * something we can't see). Precedence is deny > allow > gate.
 */
export function evaluateCommand(command: string | null | undefined, policy: CommandPolicy = {}): CommandVerdict {
  const cmd = normalize(command ?? '')
  if (!cmd) return { decision: 'gate', reason: 'empty/blank command — gated (fail-closed)', category: 'empty' }

  const segments = splitSegments(cmd)
  const extra = compile(policy.extraDenylist).map((re) => ({ re, reason: 'operator denylist', category: 'operator' }))
  const rules = [...DENYLIST, ...extra]

  // 1. deny wins — check the whole string and each segment.
  for (const rule of rules) {
    if (rule.re.test(cmd) || segments.some((s) => rule.re.test(s))) {
      return { decision: 'deny', reason: rule.reason, category: rule.category }
    }
  }

  // 2. allow — EVERY segment must match an allow pattern (a chain is only as safe
  //    as its least-safe command). An empty allowlist → nothing is auto-allowed.
  const allow = compile(policy.allowlist ?? DEFAULT_ALLOWLIST)
  if (allow.length > 0 && segments.every((s) => allow.some((re) => re.test(s)))) {
    return { decision: 'allow', reason: 'every segment matches the allowlist', category: 'allowlisted' }
  }

  // 3. everything else → gate (A2 approval).
  return { decision: 'gate', reason: 'not denylisted and not fully allowlisted — requires approval', category: 'gated' }
}

/** Is this command allowed to run without a per-command approval (autonomous)? */
export function isAllowlisted(command: string | null | undefined, policy?: CommandPolicy): boolean {
  return evaluateCommand(command, policy).decision === 'allow'
}

/** Is this command hard-denied (refused pre-approval)? */
export function isDenylisted(command: string | null | undefined, policy?: CommandPolicy): boolean {
  return evaluateCommand(command, policy).decision === 'deny'
}

/** Extract the shell command string from a machine_exec `action` payload, whether
 *  it carries an explicit `command` or an `argv` (e.g. ['sh','-lc', cmd]). */
export function commandFromAction(action: any): string {
  if (!action || typeof action !== 'object') return ''
  if (typeof action.command === 'string' && action.command.trim()) return action.command
  const argv = Array.isArray(action.argv) ? action.argv.map((x: unknown) => String(x)) : []
  if (argv.length === 0) return ''
  // ['sh','-lc','<cmd>'] / ['bash','-c','<cmd>'] → the trailing command string
  const shellIdx = argv.findIndex((a: string) => /^-[a-z]*c$/i.test(a))
  if (shellIdx >= 0 && argv[shellIdx + 1] != null) return String(argv[shellIdx + 1])
  return argv.join(' ')
}
