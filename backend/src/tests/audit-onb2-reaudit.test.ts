// Epic ONB — RE-AUDIT of the #248 hardening (docs/AUDIT-ONB2-hardening.md, R-2).
//
// #248 made `sanitizeBody` recurse, which closed the *structural* half of audit
// finding H-3 (a secret nested inside `agentDefaultsPayload` is no longer copied
// through un-walked). It left the *naming* half open.
//
// `sanitizeBody` decided "is this key a secret?" by substring-matching a hand-written
// list — `key|token|secret|password|apiKey|api_key|refreshToken|accessToken`. But the
// ADAPTER REGISTRY is what actually decides which fields are secrets, and it declares
// `http_webhook.webhookAuthHeader` (`secret: true` — a bearer `Authorization` header
// value) whose name contains none of those substrings. The onboarding document tells
// a joining agent to send exactly those keys inside `agentDefaultsPayload`. So the
// day ONB3 lands the join body and the operator enables the hook, a live bearer
// credential would have been persisted to `audit_logs.metadata` in plaintext.
//
// The registry is now the source of truth for both. These tests are the guard that
// keeps the two from drifting apart again — a NEW adapter that declares a secret
// field with an unguessable name fails here, not in production.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { sanitizeBody } from '../middleware/audit-log'
import { listAdapters, secretFields, allSecretFieldKeys } from '../services/adapter-registry'

test('[ONB2-R2] EVERY secret field any adapter declares is redacted by sanitizeBody', () => {
  const declared = allSecretFieldKeys()
  assert.ok(declared.length > 0, 'the registry declares no secret fields at all — that cannot be right')

  const survivors: string[] = []
  for (const adapter of listAdapters()) {
    for (const key of secretFields(adapter.type)) {
      // Exactly the shape ONB3's join body will carry: the secret sits nested inside
      // `agentDefaultsPayload`, under the key name the registry told the agent to use.
      const canary = `CANARY-${adapter.type}-${key}-MUST-NOT-PERSIST`
      const row = sanitizeBody({
        adapterId: adapter.type,
        agentDefaultsPayload: { [key]: canary },
      })
      if (JSON.stringify(row).includes(canary)) survivors.push(`${adapter.type}.${key}`)
    }
  }

  assert.deepEqual(
    survivors,
    [],
    'these adapter secret fields reach audit_logs.metadata in PLAINTEXT — the registry ' +
    'declares them secret but sanitizeBody does not redact them',
  )
})

test('[ONB2-R2] the webhook Authorization header — the field that proved the gap — is redacted', () => {
  // A regression test with a name, because this is the one that got through: it is
  // `secret: true` in the registry and matches none of key|token|secret|password.
  const out = sanitizeBody({
    adapterId: 'http_webhook',
    agentDefaultsPayload: {
      externalEndpoint: 'https://agent.example.com/work',
      webhookAuthHeader: 'Bearer live-bearer-credential-value',
    },
  })!
  const payload = (out.agentDefaultsPayload as any)

  assert.equal(payload.webhookAuthHeader, '[REDACTED]')
  assert.ok(
    !JSON.stringify(out).includes('live-bearer-credential-value'),
    'the webhook Authorization header survived into the audit row',
  )
  // Still a redaction, not a bulldozer: the non-secret field beside it is preserved.
  assert.equal(payload.externalEndpoint, 'https://agent.example.com/work')
})

test('[ONB2-R2] the depth cap DROPS the subtree — it does not pass it through', () => {
  // Residual #2 from the re-audit brief: confirm '[TRUNCATED]' is containment, not a
  // hole. A secret past MAX_DEPTH must not appear in the row in ANY form — the whole
  // subtree is replaced by the marker, so nothing below the cap can survive, whatever
  // its key is called.
  let deep: any = { webhookAuthHeader: 'DEEP-CANARY', innocuous: 'DEEP-PLAINTEXT' }
  for (let i = 0; i < 12; i++) deep = { level: deep }

  const s = JSON.stringify(sanitizeBody(deep))
  assert.ok(!s.includes('DEEP-CANARY'), 'a secret past the depth cap survived')
  assert.ok(!s.includes('DEEP-PLAINTEXT'), 'the truncated subtree leaked a value instead of being dropped')
  assert.ok(s.includes('[TRUNCATED]'), 'the subtree should be replaced by the truncation marker')
})
