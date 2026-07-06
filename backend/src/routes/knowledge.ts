import { FastifyInstance } from 'fastify'
import { db, schema } from '../db/client'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { upsertDocument, deleteDocument, searchKnowledge } from '../services/vector-search'
import { extractText, summariseToMarkdown } from '../services/document-ingest'
import { getGoogleConnectorCfg } from './connectors'

export async function knowledgeRoutes(app: FastifyInstance) {
  // Browse Google Drive folder
  app.get('/api/orgs/:orgId/knowledge/browse', async (req, reply) => {
    const { orgId } = req.params as any
    let { folderId = 'root', accessToken } = req.query as any
    if (!accessToken) return reply.code(401).send({ error: 'Google access token required' })
    const gcfg = await getGoogleConnectorCfg(orgId) // MCA-81: toggle + drive scope
    if (!gcfg.services.drive) return reply.code(403).send({ error: 'Drive is disabled in connector settings' })
    // driveScope 'folder' pins the default browse root to the configured folder.
    if (folderId === 'root' && gcfg.driveScope === 'folder' && gcfg.driveFolderId) folderId = gcfg.driveFolderId
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
    const { orgId, fileId } = req.params as any
    const { accessToken, mimeType = 'text/plain' } = req.query as any
    if (!accessToken) return reply.code(401).send({ error: 'Access token required' })
    const gcfg = await getGoogleConnectorCfg(orgId) // MCA-81
    if (!gcfg.services.drive) return reply.code(403).send({ error: 'Drive is disabled in connector settings' })
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

  // Ingest an uploaded document (PDF/DOCX/PPTX/XLSX/TXT/MD): extract text →
  // summarise to Markdown via the org's LLM → store as a knowledge item (+RAG).
  // ?target=mission|culture|knowledge labels the summary. Returns the summary so
  // the web client can drop it into the corresponding org field for review.
  app.post('/api/orgs/:orgId/knowledge/ingest-file', async (req, reply) => {
    const { orgId } = req.params as any
    const target = ((req.query as any)?.target as string) ?? 'knowledge'

    const data = await (req as any).file?.()
    if (!data) return reply.code(400).send({ error: 'No file uploaded' })
    const filename: string = data.filename ?? 'upload'
    const buffer: Buffer = await data.toBuffer()

    // Extract text
    let text: string
    try {
      text = await extractText(buffer, filename)
    } catch (err) {
      req.log.warn({ err }, 'document extraction failed')
      return reply.code(422).send({ error: 'Could not read this file type' })
    }
    if (!text || !text.trim()) return reply.code(422).send({ error: 'No readable text found in file' })

    // Resolve the org's configured model (+ per-org key/base URL) for summarisation
    const org = await db.query.organisations.findFirst({ where: eq(schema.organisations.id, orgId) })
    const agent = await db.query.agents.findFirst({ where: eq(schema.agents.orgId, orgId) })
    const provider = agent?.llmProvider ?? 'anthropic'
    const model = agent?.llmModel ?? 'claude-sonnet-4-20250514'
    const dc = (org?.deployConfig ?? {}) as Record<string, string>

    let summary: string
    try {
      ;({ summary } = await summariseToMarkdown({
        text, filename, target, provider, model,
        orgApiKey: dc[`${provider}_api_key`], baseURL: dc[`${provider}_base_url`],
      }))
    } catch (err) {
      req.log.warn({ err }, 'summarisation failed')
      return reply.code(502).send({ error: 'Summarisation failed — check the org LLM API key' })
    }

    // Store the summary as a shared knowledge item
    const item = {
      id: randomUUID(), orgId,
      name: `${filename} — summary`,
      type: 'summary', mimeType: 'text/markdown',
      externalId: null, externalUrl: null, parentId: null,
      content: summary, backend: 'upload', createdAt: new Date(),
    }
    await db.insert(schema.knowledgeItems).values(item)

    // Fire-and-forget RAG embedding (no-op until Pinecone is configured)
    if (process.env.PINECONE_API_KEY) {
      upsertDocument({ id: item.id, orgId, text: summary, name: item.name, type: 'summary' })
        .catch(err => console.warn('Embed failed (non-critical):', err))
    }

    reply.code(201)
    return { summary, item, target }
  })
}
