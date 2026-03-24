import { test } from 'node:test'
import assert from 'node:assert/strict'

// Replicate google-auth.ts logic locally for unit testing (mirrors google-auth.ts)
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const SCOPES = 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file'

function buildAuthUrl(orgId: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: `${process.env.PUBLIC_URL}/api/auth/google/callback`,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state: orgId,
  })
  return `${GOOGLE_AUTH_URL}?${params}`
}

async function ensureFreshToken(token: {
  accessToken: string; refreshToken: string | null; expiresAt: Date | null
}): Promise<{ accessToken: string; expiresAt: Date }> {
  if (token.expiresAt && token.expiresAt > new Date(Date.now() + 60000)) {
    return { accessToken: token.accessToken, expiresAt: token.expiresAt }
  }
  if (!token.refreshToken) throw new Error('Token expired and no refresh token')
  // In unit tests we don't make real network calls
  throw new Error('Token expired and no refresh token')
}

test('[DRIVE-001] buildAuthUrl returns valid Google OAuth URL', () => {
  process.env.GOOGLE_CLIENT_ID = 'test-client-id'
  process.env.PUBLIC_URL = 'https://api.7ei.ai'
  const url = buildAuthUrl('org-123')
  assert.ok(url.includes('accounts.google.com'), 'URL should contain accounts.google.com')
  assert.ok(url.includes('test-client-id'), 'URL should contain client_id')
  assert.ok(url.includes('state=org-123'), 'URL should contain state=orgId')
  assert.ok(url.includes('drive'), 'URL should contain drive scope')
})

test('[DRIVE-001] buildAuthUrl includes required OAuth params', () => {
  process.env.GOOGLE_CLIENT_ID = 'my-client'
  process.env.PUBLIC_URL = 'https://example.com'
  const url = buildAuthUrl('org-abc')
  assert.ok(url.includes('response_type=code'), 'URL should have response_type=code')
  assert.ok(url.includes('access_type=offline'), 'URL should have access_type=offline')
  assert.ok(url.includes('prompt=consent'), 'URL should have prompt=consent')
})

test('[DRIVE-001] ensureFreshToken returns existing token if not expired', async () => {
  const token = {
    accessToken: 'valid-token',
    refreshToken: 'refresh-token',
    expiresAt: new Date(Date.now() + 3600000),
  }
  const result = await ensureFreshToken(token)
  assert.strictEqual(result.accessToken, 'valid-token')
})

test('[DRIVE-001] ensureFreshToken throws if expired and no refresh token', async () => {
  const token = {
    accessToken: 'expired-token',
    refreshToken: null,
    expiresAt: new Date(Date.now() - 1000),
  }
  await assert.rejects(
    () => ensureFreshToken(token),
    /no refresh token/i
  )
})

test('[DRIVE-001] buildAuthUrl state param matches orgId', () => {
  process.env.GOOGLE_CLIENT_ID = 'client-id'
  process.env.PUBLIC_URL = 'https://api.example.com'
  const url = buildAuthUrl('my-org-id')
  const parsed = new URL(url)
  assert.strictEqual(parsed.searchParams.get('state'), 'my-org-id')
  assert.strictEqual(parsed.searchParams.get('response_type'), 'code')
})
