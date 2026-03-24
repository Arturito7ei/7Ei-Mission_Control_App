import { FastifyInstance } from 'fastify'
import { db, schema } from '../db/client'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { upsertDocument, deleteDocument, searchKnowledge } from '../services/vector-search'

export async function knowledgeRoutes(app: FastifyInstance) {
  // Browse Google Drive folder
  app.get('/api/orgs/:orgId/knowledge/browse', async (req, reply) => {
    const { orgId } = req.params as any
    const { folderId = 'root', accessToken } = req.query as any
    if (!accessToken) return reply.code(401).send({ error: 'Google access token required' })
    const q = `'${folderId}' in parents and trashed = false`
    const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,webViewLink,modifiedTime)`
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!res.ok) return reply.code(502).send({ error: 'Google Drive error' })
    const data = await res.json() as any
    return {
      files: data.files.map((f: any) => ({
        id: f.id, name: f.name, webUrl: f.webViewLink, modifiedAt: f.modifiedTime,
        type: f.mimeType === 'application/vnd.google-apps.folder' ? 'folder' : 'file',
        mimeType: f.mimeType,
      })),
      folderId,
    }
  })

  // Read file content
  app.get('/api/orgs/:orgId/knowledge/file/:fileId', async (req, reply) => {
    const { fileId } = req.params as any
    const { accessToken, mimeType = 'text/plain' } = req.query as any
    if (!accessToken) return reply.code(401).send({ error: 'Access token required' })
    const url = mimeType.includes('google-apps')
      ? `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`
      : `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!res.ok) return reply.code(502).send({ error: 'Failed to read file' })
    return { content: await res.text(), fileId }
  })

  // List saved knowledge items
  app.get('/api/orgs/:orgId/knowledge', async (req) => {
    const { orgId } = req.params as any
    return { items: await db.select().from(schema.knowledgeItems).where(eq(schema.knowledgeItems.orgId, orgId)) }
  })

  // Save item + index in Pinecone
  app.post('/api/orgs/:orgId/knowledge', async (req, reply) => {
    const { orgId } = req.params as any
    const body = req.body as any
    const item = {
      id: randomUUID(), orgId, name: body.name, type: body.type,
      mimeType: body.mimeType ?? null, externalId: body.externalId,
      externalUrl: body.externalUrl ?? null, parentId: null,
      content: body.content ?? null, backend: body.backend ?? 'google_drive',
      createdAt: new Date(),
    }
    await db.insert(schema.knowledgeItems).values(item)

    // Index in Pinecone if content provided
    if (body.content) {
      await upsertDocument({
        id: item.id, orgId, text: body.content,
        name: body.name, type: body.type, externalUrl: body.externalUrl,
      }).catch(err => console.warn('Vector index failed (non-critical):', err))
    }

    reply.code(201)
    return { item }
  })

  // Semantic search
  app.get('/api/orgs/:orgId/knowledge/search', async (req) => {
    const { orgId } = req.params as any
    const { q, topK = '5' } = req.query as any
    if (!q) return { results: [] }
    const results = await searchKnowledge(q, orgId, Number(topK))
    return { results, query: q }
  })

  // Delete item + remove from Pinecone
  app.delete('/api/knowledge/:itemId', async (req, reply) => {
    const { itemId } = req.params as any
    await Promise.all([
      db.delete(schema.knowledgeItems).where(eq(schema.knowledgeItems.id, itemId)),
      deleteDocument(itemId),
    ])
    reply.code(204)
  })

  // Upload .md or text file — stores content + fires RAG embed
  app.post('/api/orgs/:orgId/knowledge/upload', async (req, reply) => {
    const { orgId } = req.params as any
    const { name, content, mimeType = 'text/markdown' } = req.body as any
    if (!name || !content) return reply.code(400).send({ error: 'name and content required' })

    const item = {
      id: randomUUID(), orgId, name, type: 'document',
      mimeType, externalId: null, externalUrl: null,
      parentId: null, content,
      backend: 'upload',
      createdAt: new Date(),
    }
    await db.insert(schema.knowledgeItems).values(item)

    // Fire-and-forget RAG embedding
    if (process.env.PINECONE_API_KEY) {
      upsertDocument({ id: item.id, orgId, text: content, name, type: 'document' })
        .catch(err => console.warn('Embed failed (non-critical):', err))
    }

    reply.code(201)
    return { item }
  })

  // Read raw content of a knowledge item
  app.get('/api/knowledge/:itemId/content', async (req, reply) => {
    const { itemId } = req.params as any
    const item = await db.query.knowledgeItems.findFirst({ where: eq(schema.knowledgeItems.id, itemId) })
    if (!item) return reply.code(404).send({ error: 'Not found' })
    return { content: item.content, name: item.name, mimeType: item.mimeType }
  })
}
