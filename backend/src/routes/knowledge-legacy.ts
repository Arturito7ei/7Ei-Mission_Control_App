import { FastifyInstance } from 'fastify'
import { db, schema } from '../db/client'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { upsertDocument } from '../services/vector-search'

// ─── KNOWLEDGE (LEGACY) ──────────────────────────────────────────────────────
// NOTE: this knowledgeRoutes is NOT registered anywhere — index.ts registers the
// knowledgeRoutes from './knowledge' instead. Kept (exported, unregistered) when
// routes/all.ts was split into domain modules. chunkText IS used by tests.

function chunkText(text: string, wordsPerChunk: number, overlapWords: number): string[] {
  const words = text.split(/\s+/)
  const chunks: string[] = []
  const step = wordsPerChunk - overlapWords
  for (let i = 0; i < words.length; i += step) {
    chunks.push(words.slice(i, i + wordsPerChunk).join(' '))
    if (i + wordsPerChunk >= words.length) break
  }
  return chunks.length > 0 ? chunks : [text]
}

export { chunkText }

export async function knowledgeRoutes(app: FastifyInstance) {
  app.get('/api/orgs/:orgId/knowledge/browse', async (req, reply) => {
    const { orgId } = req.params as any
    const { folderId = 'root', accessToken } = req.query as any
    if (!accessToken) return reply.code(401).send({ error: 'Google access token required' })
    const q = `'${folderId}' in parents and trashed = false`
    const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,webViewLink,modifiedTime)`
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!res.ok) return reply.code(502).send({ error: 'Google Drive error' })
    const data = await res.json() as any
    return { files: data.files.map((f: any) => ({ id: f.id, name: f.name, webUrl: f.webViewLink, modifiedAt: f.modifiedTime, type: f.mimeType === 'application/vnd.google-apps.folder' ? 'folder' : 'file', mimeType: f.mimeType })), folderId }
  })
  app.get('/api/orgs/:orgId/knowledge/file/:fileId', async (req, reply) => {
    const { fileId } = req.params as any
    const { accessToken, mimeType = 'text/plain' } = req.query as any
    if (!accessToken) return reply.code(401).send({ error: 'Access token required' })
    const url = mimeType.includes('google-apps') ? `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain` : `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!res.ok) return reply.code(502).send({ error: 'Failed to read file' })
    return { content: await res.text(), fileId }
  })
  app.get('/api/orgs/:orgId/knowledge', async (req) => {
    const { orgId } = req.params as any
    return { items: await db.select().from(schema.knowledgeItems).where(eq(schema.knowledgeItems.orgId, orgId)) }
  })
  app.post('/api/orgs/:orgId/knowledge', async (req, reply) => {
    const { orgId } = req.params as any
    const body = req.body as any
    const item = { id: randomUUID(), orgId, name: body.name, type: body.type, mimeType: body.mimeType ?? null, externalId: body.externalId, externalUrl: body.externalUrl ?? null, parentId: null, content: null, backend: body.backend ?? 'google_drive', createdAt: new Date() }
    await db.insert(schema.knowledgeItems).values(item)
    reply.code(201); return { item }
  })
  app.delete('/api/knowledge/:itemId', async (req, reply) => {
    await db.delete(schema.knowledgeItems).where(eq(schema.knowledgeItems.id, (req.params as any).itemId))
    reply.code(204)
  })
  app.post('/api/orgs/:orgId/knowledge/embed', async (req, reply) => {
    const { orgId } = req.params as any
    const { name, text, type = 'document' } = req.body as any
    if (!name || !text) return reply.code(400).send({ error: 'name and text are required' })

    const chunks = chunkText(text, 500, 50)
    const itemId = randomUUID()

    await db.insert(schema.knowledgeItems).values({
      id: itemId, orgId, name, type,
      mimeType: 'text/plain',
      externalId: null, externalUrl: null,
      parentId: null, content: text.slice(0, 2000),
      backend: 'text',
      createdAt: new Date(),
    })

    // Fire-and-forget embedding
    const embedPromises = chunks.map((chunk, i) =>
      upsertDocument({
        id: `${itemId}_chunk_${i}`,
        orgId, text: chunk,
        name: chunks.length > 1 ? `${name} (part ${i + 1})` : name,
        type,
      }).catch(err => console.warn('Embed chunk failed:', err))
    )
    Promise.all(embedPromises).catch(() => {})

    reply.code(201)
    return { item: { id: itemId, name, type, chunkCount: chunks.length } }
  })
}
