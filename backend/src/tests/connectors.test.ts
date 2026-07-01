import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONNECTORS, GOOGLE_MEMBERS, getConnector, tokenTestRequest, parseAccount, buildStatus } from '../services/connectors'

test('registry has the expected connectors, unique ids', () => {
  const ids = CONNECTORS.map(c => c.id)
  assert.deepEqual(ids.sort(), ['gcal', 'gdrive', 'github', 'gmail', 'huggingface', 'jira', 'obsidian'])
  assert.equal(new Set(ids).size, ids.length)
})

test('obsidian is a basic connector with vault fields', () => {
  const o = getConnector('obsidian')!
  assert.equal(o.authType, 'basic')
  assert.deepEqual(o.fields, ['repo', 'root', 'branch', 'token'])
  assert.equal(o.category, 'Memory')
})

test('google members are the three google connectors', () => {
  assert.deepEqual(GOOGLE_MEMBERS.sort(), ['gcal', 'gdrive', 'gmail'])
})

test('token connectors carry a secret key; basic/oauth do not', () => {
  assert.equal(getConnector('github')!.secretKey, 'GITHUB_TOKEN')
  assert.equal(getConnector('huggingface')!.secretKey, 'HUGGINGFACE_TOKEN')
  assert.equal(getConnector('jira')!.authType, 'basic')
  assert.equal(getConnector('gmail')!.provider, 'google')
})

test('tokenTestRequest builds Bearer requests for token connectors only', () => {
  const gh = tokenTestRequest('github', 'abc')!
  assert.equal(gh.url, 'https://api.github.com/user')
  assert.equal(gh.headers.Authorization, 'Bearer abc')
  const hf = tokenTestRequest('huggingface', 'xyz')!
  assert.match(hf.url, /huggingface\.co\/api\/whoami-v2/)
  assert.equal(tokenTestRequest('jira', 't'), null)
  assert.equal(tokenTestRequest('gmail', 't'), null)
})

test('parseAccount extracts the right field per provider', () => {
  assert.equal(parseAccount('github', { login: 'octocat' }), 'octocat')
  assert.equal(parseAccount('huggingface', { name: 'arturito' }), 'arturito')
  assert.equal(parseAccount('github', null), '')
})

test('buildStatus composes a clean status row', () => {
  const s = buildStatus(getConnector('github')!, { connected: true, detail: 'octocat' })
  assert.equal(s.id, 'github'); assert.equal(s.connected, true); assert.equal(s.detail, 'octocat')
  assert.equal(s.category, 'Dev')
  const d = buildStatus(getConnector('gmail')!, { connected: false })
  assert.equal(d.connected, false); assert.equal(d.detail, null)
})
