import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SCOPES, buildAuthUrl } from '../services/google-auth'

test('Google OAuth scopes cover Drive, Gmail, Calendar, and identity', () => {
  for (const s of [
    'drive.readonly', 'drive.file',
    'gmail.readonly', 'gmail.send',
    'calendar.events',
    'userinfo.email',
  ]) assert.ok(SCOPES.includes(s), `missing scope: ${s}`)
})

test('buildAuthUrl requests offline access + incremental scopes', () => {
  process.env.GOOGLE_CLIENT_ID = 'test-client'
  process.env.PUBLIC_URL = 'https://api.example.com'
  const url = buildAuthUrl('org-1')
  assert.match(url, /access_type=offline/)
  assert.match(url, /include_granted_scopes=true/)
  assert.match(url, /state=org-1/)
  assert.match(url, /gmail\.send/)
})
