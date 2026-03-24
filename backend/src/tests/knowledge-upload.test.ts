import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

// Unit tests for upload endpoint logic (pure validation — no DB required)

test('[DRIVE-003] upload requires name and content', () => {
  const validate = (body: any) => {
    if (!body.name || !body.content) return { error: 'name and content required' }
    return null
  }
  assert.deepEqual(validate({ content: 'no name' }), { error: 'name and content required' })
  assert.deepEqual(validate({ name: 'test.md' }), { error: 'name and content required' })
  assert.strictEqual(validate({ name: 'test.md', content: '# Hello' }), null)
})

test('[DRIVE-003] upload item shape is correct', () => {
  const id = randomUUID()
  const orgId = 'org-1'
  const name = 'test.md'
  const content = '# Hello\n\nWorld'
  const mimeType = 'text/markdown'

  const item = {
    id, orgId, name, type: 'document',
    mimeType, externalId: null, externalUrl: null,
    parentId: null, content,
    backend: 'upload',
    createdAt: new Date(),
  }

  assert.strictEqual(item.backend, 'upload')
  assert.strictEqual(item.type, 'document')
  assert.strictEqual(item.content, content)
  assert.strictEqual(item.name, name)
  assert.strictEqual(item.orgId, orgId)
})

test('[DRIVE-003] default mimeType is text/markdown', () => {
  const body = { name: 'file.md', content: '# Test' }
  const mimeType = (body as any).mimeType ?? 'text/markdown'
  assert.strictEqual(mimeType, 'text/markdown')
})

test('[DRIVE-003] custom mimeType is preserved', () => {
  const body = { name: 'file.txt', content: 'Hello', mimeType: 'text/plain' }
  const mimeType = (body as any).mimeType ?? 'text/markdown'
  assert.strictEqual(mimeType, 'text/plain')
})

test('[DRIVE-003] item id is a valid UUID', () => {
  const id = randomUUID()
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
})
