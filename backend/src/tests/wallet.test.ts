import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  weiToEth, weiToGwei, isAddress, normalizeAddress, shortAddress,
  decodeCalldata, buildUnsignedTx, summarizeSimulation, checkCaps,
  detectScamSignals, looksLikeKeyMaterial, assertNoKeyMaterial, KNOWN_SELECTORS,
} from '../services/wallet'

// ─── Units ───────────────────────────────────────────────────────────────────

test('[E1] weiToEth formats without floating error', () => {
  assert.equal(weiToEth('1000000000000000000'), '1')
  assert.equal(weiToEth('500000000000000000'), '0.5')
  assert.equal(weiToEth('1234500000000000000'), '1.2345')
  assert.equal(weiToEth(0), '0')
  assert.equal(weiToEth(null), '0')
  assert.equal(weiToEth('0x2386f26fc10000'), '0.01') // hex 10000000000000000 wei
})

test('[E1] weiToGwei formats gas prices', () => {
  assert.equal(weiToGwei('20000000000'), '20')
  assert.equal(weiToGwei('1500000000'), '1.5')
})

// ─── Addresses ───────────────────────────────────────────────────────────────

test('[E1] address validation + normalization + short form', () => {
  const a = '0xE592427A0AEce92De3Edee1F18E0157C05861564'
  assert.equal(isAddress(a), true)
  assert.equal(isAddress('0x123'), false)
  assert.equal(normalizeAddress(a), a.toLowerCase())
  assert.equal(normalizeAddress('nope'), null)
  assert.equal(shortAddress(a), '0xe592…1564')
})

// ─── Calldata decode ─────────────────────────────────────────────────────────

test('[E1] decodeCalldata recognizes known selectors + extracts address/amount', () => {
  // transfer(0x...recipient, 1000000)
  const recipient = 'e592427a0aece92de3edee1f18e0157c05861564'
  const data = '0xa9059cbb' + '0'.repeat(24) + recipient + (1000000).toString(16).padStart(64, '0')
  const d = decodeCalldata(data)
  assert.equal(d.selector, '0xa9059cbb')
  assert.equal(d.known, true)
  assert.match(d.method, /transfer/)
  assert.ok(d.addresses.includes('0x' + recipient))
  assert.equal(d.amount, '1000000')
})

test('[E1] decodeCalldata flags unlimited approve + setApprovalForAll', () => {
  const spender = '1111111111111111111111111111111111111111'
  const maxUint = 'f'.repeat(64)
  const approve = '0x095ea7b3' + '0'.repeat(24) + spender + maxUint
  const da = decodeCalldata(approve)
  assert.equal(da.flags.unlimitedApproval, true)

  const setAll = '0xa22cb465' + '0'.repeat(24) + spender + '0'.repeat(63) + '1'
  const ds = decodeCalldata(setAll)
  assert.equal(ds.flags.setApprovalForAll, true)
  assert.equal(ds.flags.approvalForAllTrue, true)
})

test('[E1] decodeCalldata marks unknown selectors', () => {
  const d = decodeCalldata('0xdeadbeef' + '0'.repeat(64))
  assert.equal(d.known, false)
  assert.equal(d.method, 'unknown call')
})

// ─── Unsigned tx assembly ────────────────────────────────────────────────────

test('[E1] buildUnsignedTx assembles a key-free unsigned tx; validates addresses', () => {
  const tx = buildUnsignedTx({
    from: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
    to: '0x1111111111111111111111111111111111111111',
    chainId: 1, valueWei: '500000000000000000',
  })
  assert.equal(tx.value, '500000000000000000')
  assert.equal(tx.data, '0x')
  assert.equal(tx.chainId, 1)
  // no signature / key fields anywhere
  assert.ok(!('signature' in tx) && !('privateKey' in tx))
  assert.throws(() => buildUnsignedTx({ from: 'bad', to: tx.to, chainId: 1 }))
  assert.throws(() => buildUnsignedTx({ from: tx.from, to: 'bad', chainId: 1 }))
})

// ─── Simulation summary ──────────────────────────────────────────────────────

test('[E1] summarizeSimulation computes gas cost + revert', () => {
  const s = summarizeSimulation({ gasUsed: 210000, gasPriceWei: '20000000000', ethUsd: 3000 })
  assert.equal(s.ok, true)
  assert.equal(s.gasUsed, '210000')
  // 210000 * 20 gwei = 0.0042 ETH → $12.6
  assert.equal(s.gasCostEth, '0.0042')
  assert.equal(s.gasCostUsd, 12.6)

  const r = summarizeSimulation({ reverted: true, revertReason: 'insufficient balance' })
  assert.equal(r.ok, false)
  assert.equal(r.revertReason, 'insufficient balance')
})

// ─── Caps + allowlist ────────────────────────────────────────────────────────

test('[E1] checkCaps enforces per-tx, per-day, and allowlist', () => {
  const caps = { perTxUsd: 1000, perDayUsd: 2000, allowlist: ['0x1111111111111111111111111111111111111111'] }
  const ok = checkCaps({ valueUsd: 500, to: '0x1111111111111111111111111111111111111111', spentTodayUsd: 100, caps })
  assert.equal(ok.overCap, false)

  const overTx = checkCaps({ valueUsd: 1500, to: '0x1111111111111111111111111111111111111111', spentTodayUsd: 0, caps })
  assert.equal(overTx.withinPerTx, false)
  assert.equal(overTx.overCap, true)

  const overDay = checkCaps({ valueUsd: 500, to: '0x1111111111111111111111111111111111111111', spentTodayUsd: 1800, caps })
  assert.equal(overDay.withinPerDay, false)

  const notAllowed = checkCaps({ valueUsd: 100, to: '0x2222222222222222222222222222222222222222', spentTodayUsd: 0, caps })
  assert.equal(notAllowed.destinationAllowed, false)
  assert.equal(notAllowed.overCap, true)
})

test('[E1] empty allowlist means no allowlist restriction', () => {
  const c = checkCaps({ valueUsd: 100, to: '0x2222222222222222222222222222222222222222', spentTodayUsd: 0, caps: { perTxUsd: 1000 } })
  assert.equal(c.destinationAllowed, true)
  assert.equal(c.overCap, false)
})

// ─── Scam guards ─────────────────────────────────────────────────────────────

test('[E1] detectScamSignals flags new address / unknown contract', () => {
  const decoded = decodeCalldata('0xa9059cbb' + '0'.repeat(24) + '1'.repeat(40) + (1).toString(16).padStart(64, '0'))
  const s = detectScamSignals({ decoded, to: '0x9999999999999999999999999999999999999999', knownAddresses: [], contractLabeled: false })
  assert.equal(s.newAddress, true)
  assert.equal(s.unknownContract, true)
  assert.ok(s.warnings.some(w => /never-before-seen/i.test(w)))
})

test('[E1] detectScamSignals catches the drain pattern (blanket approval to new unknown)', () => {
  const spender = '9'.repeat(40)
  const setAll = '0xa22cb465' + '0'.repeat(24) + spender + '0'.repeat(63) + '1'
  const decoded = decodeCalldata(setAll)
  const s = detectScamSignals({ decoded, to: '0x9999999999999999999999999999999999999999', knownAddresses: [], contractLabeled: false })
  assert.equal(s.setApprovalForAll, true)
  assert.equal(s.drainPattern, true)
  assert.ok(s.warnings.some(w => /drain/i.test(w)))
})

test('[E1] a known address + labeled contract is not flagged new/unknown', () => {
  const to = '0x1111111111111111111111111111111111111111'
  const decoded = decodeCalldata('0xa9059cbb' + '0'.repeat(24) + '1'.repeat(40) + (1).toString(16).padStart(64, '0'))
  const s = detectScamSignals({ decoded, to, knownAddresses: [to], contractLabeled: true })
  assert.equal(s.newAddress, false)
  assert.equal(s.unknownContract, false)
  assert.equal(s.drainPattern, false)
})

// ─── No-key-material invariant (NFR-2) ───────────────────────────────────────

test('[E1] looksLikeKeyMaterial detects private keys + seed phrases', () => {
  assert.equal(looksLikeKeyMaterial('0x' + 'a'.repeat(64)), true)
  assert.equal(looksLikeKeyMaterial('witch collapse practice feed shame open despair creek road again ice least'), true)
  assert.equal(looksLikeKeyMaterial('Swap 0.5 ETH → 1180 USDC'), false)
  assert.equal(looksLikeKeyMaterial('0x1234'), false)
})

test('[E1] assertNoKeyMaterial throws when a field carries key material', () => {
  assert.throws(() => assertNoKeyMaterial({ decoded: 'ok', note: '0x' + 'b'.repeat(64) }), /no key custody/i)
  assert.doesNotThrow(() => assertNoKeyMaterial({ decoded: 'Swap 0.5 ETH', label: 'Uniswap V3' }))
})

test('[E1] KNOWN_SELECTORS marks setApprovalForAll high-risk', () => {
  assert.equal(KNOWN_SELECTORS['0xa22cb465'].risk, 'high')
})
