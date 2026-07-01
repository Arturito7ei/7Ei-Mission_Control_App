import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseVaultConfig, defaultVaultConfig, isSafeVaultPath, isMarkdownPath, ghContentsUrl, ghPutBody } from '../services/vault-connector'

test('parseVaultConfig merges with defaults and tolerates junk', () => {
  const d = defaultVaultConfig()
  assert.deepEqual(parseVaultConfig(null), d)
  assert.deepEqual(parseVaultConfig('not json'), d)
  assert.deepEqual(parseVaultConfig('{"repo":"o/r","root":"notes","branch":"dev"}'), { repo: 'o/r', root: 'notes', branch: 'dev' })
  // partial → fill from defaults
  assert.equal(parseVaultConfig('{"repo":"o/r"}').branch, d.branch)
})

test('isSafeVaultPath honours a custom root and blocks traversal', () => {
  assert.ok(isSafeVaultPath('notes/a.md', 'notes'))
  assert.ok(isSafeVaultPath('notes', 'notes'))
  assert.ok(isSafeVaultPath('', 'notes'))
  assert.equal(isSafeVaultPath('other/a.md', 'notes'), false)
  assert.equal(isSafeVaultPath('notes/../secret', 'notes'), false)
  assert.equal(isSafeVaultPath('notes\\a.md', 'notes'), false)
})

test('isMarkdownPath matches md/markdown/txt only', () => {
  assert.ok(isMarkdownPath('vault/x.md'))
  assert.ok(isMarkdownPath('a.markdown'))
  assert.ok(isMarkdownPath('a.txt'))
  assert.equal(isMarkdownPath('a.png'), false)
})

test('ghContentsUrl appends ref when given a branch', () => {
  assert.equal(ghContentsUrl('vault/a.md', 'o/r'), 'https://api.github.com/repos/o/r/contents/vault/a.md')
  assert.match(ghContentsUrl('vault/a.md', 'o/r', 'main'), /\?ref=main$/)
})

test('ghPutBody base64-encodes content and includes sha on update', () => {
  const create = ghPutBody('hello', 'msg', 'main')
  assert.equal(create.branch, 'main')
  assert.equal(Buffer.from(create.content, 'base64').toString('utf8'), 'hello')
  assert.equal(create.sha, undefined)
  const update = ghPutBody('hi', 'msg', 'main', 'abc123')
  assert.equal(update.sha, 'abc123')
})
