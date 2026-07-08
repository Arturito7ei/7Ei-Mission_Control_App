// Arturita E1 — wallet READ + PREPARE + SIMULATE (never sign). Pure helpers.
//
// The hardest constraint and the clearest line (PRD §7.4): Arturita reads
// balances/positions and *constructs* unsigned transactions and *simulates*
// them, decoding calldata to a human-readable summary for the approval card.
// She NEVER imports, stores, generates, or transmits a private key or seed
// phrase; she never signs. This module is pure (no RPC, no keys): the route does
// the RPC I/O and passes raw results in; these helpers assemble the unsigned tx,
// interpret a simulation, decode calldata, check caps, and flag scam patterns.
//
// A hard design invariant lives here too: `assertNoKeyMaterial()` — nothing
// stored in `wallet_intents` may contain private-key/seed material. Backs NFR-2
// alongside the CI secret-scan.

// ─── Units ───────────────────────────────────────────────────────────────────

const WEI_PER_ETH = 10n ** 18n
const WEI_PER_GWEI = 10n ** 9n

function toBigInt(v: string | number | bigint | null | undefined): bigint | null {
  if (v == null) return null
  try {
    if (typeof v === 'bigint') return v
    if (typeof v === 'number') return BigInt(Math.trunc(v))
    const s = String(v).trim()
    if (!s) return null
    return s.startsWith('0x') ? BigInt(s) : BigInt(s)
  } catch { return null }
}

/** Format a wei amount as ETH with up to `dp` decimals (no floating error). */
export function weiToEth(wei: string | number | bigint | null | undefined, dp = 6): string {
  const w = toBigInt(wei)
  if (w == null) return '0'
  const neg = w < 0n
  const abs = neg ? -w : w
  const whole = abs / WEI_PER_ETH
  const frac = abs % WEI_PER_ETH
  let fracStr = frac.toString().padStart(18, '0').slice(0, dp).replace(/0+$/, '')
  const out = fracStr ? `${whole}.${fracStr}` : `${whole}`
  return neg ? `-${out}` : out
}

/** Format a wei gas price as gwei. */
export function weiToGwei(wei: string | number | bigint | null | undefined, dp = 2): string {
  const w = toBigInt(wei)
  if (w == null) return '0'
  const whole = w / WEI_PER_GWEI
  const frac = w % WEI_PER_GWEI
  const fracStr = frac.toString().padStart(9, '0').slice(0, dp).replace(/0+$/, '')
  return fracStr ? `${whole}.${fracStr}` : `${whole}`
}

// ─── Address helpers ─────────────────────────────────────────────────────────

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/

export function isAddress(a: string | null | undefined): boolean {
  return ADDR_RE.test(String(a ?? ''))
}

export function normalizeAddress(a: string | null | undefined): string | null {
  const s = String(a ?? '').trim().toLowerCase()
  return ADDR_RE.test(s) ? s : null
}

/** Short display form: 0x1234…abcd. */
export function shortAddress(a: string | null | undefined): string {
  const s = normalizeAddress(a)
  if (!s) return String(a ?? '')
  return `${s.slice(0, 6)}…${s.slice(-4)}`
}

// ─── Calldata decode (self-hosted, curated selector table) ───────────────────

// 4-byte function selectors → human template. Curated to the surfaces Arturita
// prepares; unknown selectors decode to "unknown call" (flagged as such).
export type AbiType = 'address' | 'uint256' | 'bool'

// 4-byte function selectors → human name + the ABI param layout. The layout lets
// us decode words DETERMINISTICALLY (which word is an address vs a small uint)
// instead of guessing — a small uint is 24 leading-zero nibbles too. Curated to
// the surfaces Arturita prepares; unknown selectors decode to "unknown call".
export const KNOWN_SELECTORS: Record<string, { name: string; params: AbiType[]; risk?: 'high' }> = {
  '0xa9059cbb': { name: 'transfer(address,uint256)', params: ['address', 'uint256'] },
  '0x095ea7b3': { name: 'approve(address,uint256)', params: ['address', 'uint256'] },
  '0x23b872dd': { name: 'transferFrom(address,address,uint256)', params: ['address', 'address', 'uint256'] },
  '0xa22cb465': { name: 'setApprovalForAll(address,bool)', params: ['address', 'bool'], risk: 'high' },
  '0x42842e0e': { name: 'safeTransferFrom(address,address,uint256)', params: ['address', 'address', 'uint256'] },
  '0x38ed1739': { name: 'swapExactTokensForTokens(...)', params: [] },
  '0x7ff36ab5': { name: 'swapExactETHForTokens(...)', params: [] },
  '0x2e1a7d4d': { name: 'withdraw(uint256)', params: ['uint256'] },
  '0xd0e30db0': { name: 'deposit()', params: [] },
}

// Max uint256 — the "unlimited approval" amount.
const MAX_UINT256 = (2n ** 256n) - 1n
// A common "effectively unlimited" threshold some UIs use.
const UNLIMITED_THRESHOLD = 2n ** 255n

export interface DecodedCalldata {
  selector: string
  method: string
  known: boolean
  /** address parameters found (first N 32-byte words that look like addresses). */
  addresses: string[]
  /** the first uint256 word as a bigint string, when present (amount-ish). */
  amount: string | null
  flags: {
    setApprovalForAll: boolean
    unlimitedApproval: boolean
    approvalForAllTrue: boolean
  }
}

const addrFromWord = (w: string): string | null => {
  if (!/^0{24}[0-9a-fA-F]{40}$/.test(w)) return null
  const addr = '0x' + w.slice(24).toLowerCase()
  return addr === '0x' + '0'.repeat(40) ? null : addr
}
const uintFromWord = (w: string): bigint | null => {
  try { return /^[0-9a-fA-F]{64}$/.test(w) ? BigInt('0x' + w) : null } catch { return null }
}

/** Decode calldata into a method name + params. For KNOWN selectors we decode by
 *  the declared ABI layout (deterministic — no address/uint ambiguity); for
 *  unknown selectors we fall back to a best-effort heuristic and flag
 *  `known:false`. Pure hex parsing — no ABI library, no network. */
export function decodeCalldata(data: string | null | undefined): DecodedCalldata {
  const hex = String(data ?? '').trim()
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  const selector = '0x' + clean.slice(0, 8).toLowerCase()
  const spec = KNOWN_SELECTORS[selector]
  const known = !!spec
  const method = spec ? spec.name : 'unknown call'

  // 32-byte words after the selector.
  const words: string[] = []
  for (let i = 8; i + 64 <= clean.length; i += 64) words.push(clean.slice(i, i + 64))

  const addresses: string[] = []
  let amount: string | null = null
  let unlimitedApproval = false
  let approvalForAllTrue = false
  const setApprovalForAll = selector === '0xa22cb465'
  const isApprove = selector === '0x095ea7b3'

  if (spec && spec.params.length) {
    // Deterministic ABI-layout decode.
    spec.params.forEach((t, i) => {
      const w = words[i]
      if (w == null) return
      if (t === 'address') { const a = addrFromWord(w); if (a) addresses.push(a) }
      else if (t === 'uint256') { const v = uintFromWord(w); if (v != null && amount == null) amount = v.toString(); if (v != null && (v >= UNLIMITED_THRESHOLD || v === MAX_UINT256)) unlimitedApproval = true }
      else if (t === 'bool') { approvalForAllTrue = /0{63}1$/.test(w) }
    })
  } else {
    // Heuristic for unknown selectors: pull address-shaped + first uint word.
    for (const w of words) { const a = addrFromWord(w); if (a) addresses.push(a) }
    for (const w of words) { if (addrFromWord(w)) continue; const v = uintFromWord(w); if (v != null) { if (amount == null) amount = v.toString(); if (v >= UNLIMITED_THRESHOLD) unlimitedApproval = true } }
  }

  return {
    selector,
    method,
    known,
    addresses,
    amount,
    flags: {
      setApprovalForAll,
      unlimitedApproval: isApprove && unlimitedApproval,
      approvalForAllTrue: setApprovalForAll && approvalForAllTrue,
    },
  }
}

// ─── Unsigned tx assembly ────────────────────────────────────────────────────

export interface UnsignedTx {
  from: string
  to: string
  value: string        // wei, decimal string
  data: string         // 0x… calldata (or '0x')
  chainId: number
  nonce?: number | null
  gas?: string | null
  maxFeePerGas?: string | null
  maxPriorityFeePerGas?: string | null
}

/** Assemble an UNSIGNED transaction object. No key, no signature, ever. Validates
 *  addresses and normalizes fields; throws on a bad address (fail closed). */
export function buildUnsignedTx(input: {
  from: string
  to: string
  chainId: number
  valueWei?: string | number | bigint
  data?: string
  nonce?: number | null
  gas?: string | null
  maxFeePerGas?: string | null
  maxPriorityFeePerGas?: string | null
}): UnsignedTx {
  const from = normalizeAddress(input.from)
  const to = normalizeAddress(input.to)
  if (!from) throw new Error('buildUnsignedTx: invalid from address')
  if (!to) throw new Error('buildUnsignedTx: invalid to address')
  const value = (toBigInt(input.valueWei ?? 0) ?? 0n).toString()
  const data = input.data && input.data.startsWith('0x') ? input.data : '0x'
  return {
    from, to, value, data, chainId: Number(input.chainId),
    nonce: input.nonce ?? null,
    gas: input.gas ?? null,
    maxFeePerGas: input.maxFeePerGas ?? null,
    maxPriorityFeePerGas: input.maxPriorityFeePerGas ?? null,
  }
}

// ─── Simulation summary ──────────────────────────────────────────────────────

export interface SimulationSummary {
  ok: boolean            // false = the tx would revert
  revertReason: string | null
  gasUsed: string | null
  gasPriceWei: string | null
  gasCostEth: string | null
  gasCostUsd: number | null
}

/** Interpret a raw simulation result (from eth_call + estimateGas + gas price,
 *  fetched by the route) into a display summary. Pure. */
export function summarizeSimulation(raw: {
  reverted?: boolean
  revertReason?: string | null
  gasUsed?: string | number | null
  gasPriceWei?: string | number | null
  ethUsd?: number | null
}): SimulationSummary {
  const gasUsed = toBigInt(raw.gasUsed ?? null)
  const gasPrice = toBigInt(raw.gasPriceWei ?? null)
  const costWei = gasUsed != null && gasPrice != null ? gasUsed * gasPrice : null
  const gasCostEth = costWei != null ? weiToEth(costWei, 6) : null
  const gasCostUsd = costWei != null && raw.ethUsd != null ? Number(weiToEth(costWei, 8)) * raw.ethUsd : null
  return {
    ok: !raw.reverted,
    revertReason: raw.revertReason ?? null,
    gasUsed: gasUsed?.toString() ?? null,
    gasPriceWei: gasPrice?.toString() ?? null,
    gasCostEth,
    gasCostUsd: gasCostUsd != null ? Math.round(gasCostUsd * 100) / 100 : null,
  }
}

// ─── Caps + allowlist ────────────────────────────────────────────────────────

export interface WalletCaps {
  perTxUsd?: number | null
  perDayUsd?: number | null
  allowlist?: string[] | null   // destination addresses allowed for higher amounts
}

export interface CapCheck {
  withinPerTx: boolean
  withinPerDay: boolean
  destinationAllowed: boolean
  overCap: boolean            // any cap exceeded → step-up required (A2)
  reasons: string[]
}

/** Check a prepared tx against per-tx / per-day caps + a destination allowlist.
 *  `spentTodayUsd` is the running total the route supplies. Pure. */
export function checkCaps(input: {
  valueUsd: number
  to: string
  spentTodayUsd: number
  caps: WalletCaps | null | undefined
}): CapCheck {
  const caps = input.caps ?? {}
  const reasons: string[] = []
  const withinPerTx = caps.perTxUsd == null || input.valueUsd <= caps.perTxUsd
  if (!withinPerTx) reasons.push(`Exceeds per-tx cap $${caps.perTxUsd} (tx $${input.valueUsd.toFixed(2)}).`)
  const withinPerDay = caps.perDayUsd == null || input.spentTodayUsd + input.valueUsd <= caps.perDayUsd
  if (!withinPerDay) reasons.push(`Exceeds per-day cap $${caps.perDayUsd} (today $${input.spentTodayUsd.toFixed(2)} + $${input.valueUsd.toFixed(2)}).`)
  const to = normalizeAddress(input.to)
  const allowlist = (caps.allowlist ?? []).map(a => normalizeAddress(a)).filter(Boolean) as string[]
  // Allowlist only gates when configured; empty allowlist = no allowlist restriction.
  const destinationAllowed = allowlist.length === 0 || (to != null && allowlist.includes(to))
  if (!destinationAllowed) reasons.push('Destination is not on the address allowlist.')
  const overCap = !withinPerTx || !withinPerDay || !destinationAllowed
  return { withinPerTx, withinPerDay, destinationAllowed, overCap, reasons }
}

// ─── Scam / phishing guards ──────────────────────────────────────────────────

export interface ScamSignals {
  newAddress: boolean
  setApprovalForAll: boolean
  unlimitedApproval: boolean
  unknownContract: boolean
  drainPattern: boolean
  warnings: string[]
}

/** Derive scam-guard signals from decoded calldata + context. Feeds A2's
 *  wallet_tx warnings. `knownAddresses` is the operator's seen-before set. */
export function detectScamSignals(input: {
  decoded: DecodedCalldata
  to: string
  knownAddresses?: string[] | null
  contractLabeled?: boolean
}): ScamSignals {
  const to = normalizeAddress(input.to)
  const known = new Set((input.knownAddresses ?? []).map(a => normalizeAddress(a)).filter(Boolean) as string[])
  const newAddress = to != null && !known.has(to)
  const setApprovalForAll = input.decoded.flags.setApprovalForAll && input.decoded.flags.approvalForAllTrue
  const unlimitedApproval = input.decoded.flags.unlimitedApproval
  const unknownContract = !input.contractLabeled || !input.decoded.known
  // Drain pattern: approve/setApprovalForAll to a brand-new, unlabeled address.
  const drainPattern = (setApprovalForAll || unlimitedApproval) && newAddress && unknownContract

  const warnings: string[] = []
  if (newAddress) warnings.push('Destination is a never-before-seen address.')
  if (setApprovalForAll) warnings.push('setApprovalForAll(true) — grants control of ALL tokens in a collection.')
  if (unlimitedApproval) warnings.push('Unlimited token approval — the spender can move any amount.')
  if (unknownContract) warnings.push('Destination contract is unknown / unlabeled.')
  if (drainPattern) warnings.push('Matches a drain pattern (blanket approval to a new, unknown address).')
  return { newAddress, setApprovalForAll, unlimitedApproval, unknownContract, drainPattern, warnings }
}

// ─── No-key-material invariant (NFR-2) ───────────────────────────────────────

// A raw private key is 0x + 64 hex; a seed phrase is 12/24 BIP-39-ish words.
const PRIVKEY_RE = /\b0x[0-9a-fA-F]{64}\b/
const SEED_RE = /\b([a-z]{3,10}\s+){11,}[a-z]{3,10}\b/i

/** Does this value look like private-key or seed material? Used to guarantee
 *  nothing stored in wallet_intents carries a key (NFR-2). Note: a 32-byte tx
 *  hash is also 0x+64hex, so callers pass ONLY fields that must never contain a
 *  key (decoded summary, labels) — not txhashes. */
export function looksLikeKeyMaterial(value: string | null | undefined): boolean {
  const s = String(value ?? '')
  return PRIVKEY_RE.test(s) || SEED_RE.test(s)
}

/** Throw if any provided field looks like key material. Fail-closed guard the
 *  route calls before persisting a wallet intent. */
export function assertNoKeyMaterial(fields: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'string' && looksLikeKeyMaterial(v)) {
      throw new Error(`refusing to persist wallet intent: field "${k}" looks like private-key/seed material (no key custody — NFR-2)`)
    }
  }
}
