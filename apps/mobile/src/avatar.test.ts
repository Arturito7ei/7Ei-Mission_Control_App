// MOB-7c — tripwires for the agent-avatar logic.
//
// The valuable one is the CONTRACT test: this file imports the backend's REAL
// avatar guard and asserts the phone's mirror agrees value-for-value. A hand-copy
// of `isSafeAvatarValue` into a fixture would pass forever while the server's
// allow-list drifted underneath it; importing the producer is what makes a change
// to the accepted image types (or the data-URI shape) fail the phone here.
//
// The backend module is pure — it uses only the global `Buffer`, no fastify, no
// db — so it loads under `node --test --experimental-strip-types` outside Metro,
// and Mobile CI (which installs ONLY apps/mobile) can run it. See the parity note
// in CLAUDE.md and mobile-ci-cross-workspace-test-imports.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ALLOWED_AVATAR_TYPES as BE_TYPES,
  isSafeAvatarValue as beIsSafe,
  isAllowedAvatarType as beIsAllowedType,
} from '../../../backend/src/services/agent-avatar.ts'
import {
  ALLOWED_AVATAR_TYPES,
  FALLBACK_EMOJI,
  avatarEmoji,
  avatarImageUri,
  isAllowedAvatarType,
  isSafeAvatarValue,
} from './avatar.ts'

// A 1x1 transparent PNG — a real, valid base64 image data URI.
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

test('[MOB-7c] the allowed image types match the backend exactly', () => {
  assert.deepEqual([...ALLOWED_AVATAR_TYPES], [...BE_TYPES])
})

test('[MOB-7c] isSafeAvatarValue agrees with the backend across the cases that matter', () => {
  const cases: (string | null | undefined)[] = [
    PNG, // valid png
    'data:image/jpeg;base64,/9j/4AAQSkZJRg==', // valid jpeg
    'data:image/webp;base64,UklGRh4AAABXRUJQ', // valid webp
    'data:image/gif;base64,R0lGODlhAQABAAAAACw=', // valid gif
    'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', // svg — script vector, must be rejected
    'data:text/html;base64,PHNjcmlwdD4=', // html, rejected
    'javascript:alert(1)', // not a data URI, rejected
    'https://evil.example/track.png', // remote URL, rejected
    'data:image/png;utf8,notbase64', // right type, wrong encoding, rejected
    '', // empty
    null,
    undefined,
  ]
  for (const v of cases) {
    assert.equal(
      isSafeAvatarValue(v),
      beIsSafe(v),
      `mobile and backend disagree on ${JSON.stringify(v)?.slice(0, 40)}`,
    )
  }
  // And spell out the security-critical verdicts, so the intent is pinned even if
  // the backend guard were ever loosened.
  assert.equal(isSafeAvatarValue(PNG), true)
  assert.equal(isSafeAvatarValue('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='), false)
  assert.equal(isSafeAvatarValue('javascript:alert(1)'), false)
  assert.equal(isSafeAvatarValue('https://evil.example/x.png'), false)
})

test('[MOB-7c] isAllowedAvatarType agrees with the backend, params and case folding', () => {
  for (const t of ['image/png', 'IMAGE/PNG', 'image/jpeg;charset=x', 'image/svg+xml', 'text/html', '', null]) {
    assert.equal(isAllowedAvatarType(t), beIsAllowedType(t), `disagree on ${t}`)
  }
})

test('[MOB-7c] avatarImageUri returns the picture only when present AND safe', () => {
  assert.equal(avatarImageUri({ avatarUrl: PNG, avatarEmoji: '🎯' }), PNG)
  assert.equal(avatarImageUri({ avatarUrl: null, avatarEmoji: '🎯' }), null)
  assert.equal(avatarImageUri({ avatarEmoji: '🎯' }), null)
  // Unsafe values fall through to the emoji, never to <Image>.
  assert.equal(avatarImageUri({ avatarUrl: 'javascript:alert(1)' }), null)
  assert.equal(avatarImageUri({ avatarUrl: 'data:image/svg+xml;base64,PHN2Zz4=' }), null)
})

test('[MOB-7c] avatarEmoji falls back to the shared default', () => {
  assert.equal(avatarEmoji({ avatarEmoji: '🎯' }), '🎯')
  assert.equal(avatarEmoji({ avatarEmoji: '' }), FALLBACK_EMOJI)
  assert.equal(avatarEmoji({ avatarEmoji: null }), FALLBACK_EMOJI)
  assert.equal(avatarEmoji({}), FALLBACK_EMOJI)
  assert.equal(FALLBACK_EMOJI, '🤖')
})
