import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isSafeVaultPath, ghContentsUrl, parseDirEntries, decodeFileContent } from '../services/vault-connector.ts'

describe('[Memory] isSafeVaultPath', () => {
  it('allows the vault subtree', () => {
    assert.equal(isSafeVaultPath('vault'), true)
    assert.equal(isSafeVaultPath('vault/Protocols/MOC-Protocols.md'), true)
  })
  it('blocks traversal + outside paths', () => {
    assert.equal(isSafeVaultPath('vault/../secrets'), false)
    assert.equal(isSafeVaultPath('etc/passwd'), false)
    assert.equal(isSafeVaultPath('vault\\x'), false)
  })
})

describe('[Memory] ghContentsUrl', () => {
  it('builds a Contents API URL for the vault repo', () => {
    assert.equal(ghContentsUrl('vault/Memory'), 'https://api.github.com/repos/Arturito7ei/7Ei-MC_TARCO/contents/vault/Memory')
  })
})

describe('[Memory] parseDirEntries', () => {
  it('keeps dirs + markdown, sorts dirs first', () => {
    const out = parseDirEntries([
      { name: 'recent.md', path: 'vault/Memory/recent.md', type: 'file' },
      { name: 'image.png', path: 'vault/Memory/image.png', type: 'file' },
      { name: 'sub', path: 'vault/Memory/sub', type: 'dir' },
    ])
    assert.deepEqual(out.map(e => e.name), ['sub', 'recent.md'])  // png filtered, dir first
  })
})

describe('[Memory] decodeFileContent', () => {
  it('decodes base64 content', () => {
    const obj = { content: Buffer.from('# Hello', 'utf8').toString('base64'), encoding: 'base64' }
    assert.equal(decodeFileContent(obj), '# Hello')
  })
  it('returns empty on missing content', () => assert.equal(decodeFileContent({}), ''))
})
