import { FastifyInstance } from 'fastify'
import { db, schema } from '../db/client'
import { eq, and } from 'drizzle-orm'
import { randomUUID } from 'crypto'

// ─── SKILLS ──────────────────────────────────────────────────────────────────

const SKILL_LIBRARY_REPO = 'Arturito7ei/skill-library'

export async function skillRoutes(app: FastifyInstance) {
  app.get('/api/skills', async () => ({ skills: await db.select().from(schema.skills) }))
  app.post('/api/skills', async (req, reply) => {
    const body = req.body as any
    const skill = { id: randomUUID(), name: body.name, description: body.description ?? null, domain: body.domain, content: body.content, source: body.source ?? 'custom', githubPath: null, orgId: body.orgId ?? null, lastSyncedAt: null, createdAt: new Date() }
    await db.insert(schema.skills).values(skill)
    reply.code(201); return { skill }
  })
  app.get('/api/skills/:skillId', async (req, reply) => {
    const { skillId } = req.params as any
    const skill = await db.query.skills.findFirst({ where: eq(schema.skills.id, skillId) })
    if (!skill) return reply.code(404).send({ error: 'Not found' })
    return { skill }
  })
  app.patch('/api/skills/:skillId', async (req) => {
    await db.update(schema.skills).set(req.body as any).where(eq(schema.skills.id, (req.params as any).skillId))
    return { ok: true }
  })
  app.delete('/api/skills/:skillId', async (req, reply) => {
    await db.delete(schema.skills).where(eq(schema.skills.id, (req.params as any).skillId))
    reply.code(204)
  })
  app.post('/api/skills/sync', async (_req, reply) => {
    const headers: Record<string, string> = { Accept: 'application/vnd.github.v3+json' }
    if (process.env.GITHUB_TOKEN) headers.Authorization = `token ${process.env.GITHUB_TOKEN}`
    try {
      const res = await fetch(`https://api.github.com/repos/${SKILL_LIBRARY_REPO}/contents`, { headers })
      if (!res.ok) return reply.code(502).send({ error: 'GitHub fetch failed' })
      const dirs = (await res.json() as any[]).filter((f: any) => f.type === 'dir')
      let synced = 0
      for (const dir of dirs) {
        const fr = await fetch(`https://api.github.com/repos/${SKILL_LIBRARY_REPO}/contents/${dir.path}/SKILL.md`, { headers })
        if (!fr.ok) continue
        const fd = await fr.json() as any
        const content = Buffer.from(fd.content, 'base64').toString('utf-8')
        const name = content.split('\n').find((l: string) => l.startsWith('# '))?.replace('# ', '').trim() ?? dir.name
        const description = content.split('\n').find((l: string) => l.startsWith('> '))?.replace('> ', '').trim()
        const existing = await db.query.skills.findFirst({ where: eq(schema.skills.githubPath, dir.path) })
        if (existing) { await db.update(schema.skills).set({ content, lastSyncedAt: new Date() }).where(eq(schema.skills.id, existing.id)) }
        else { await db.insert(schema.skills).values({ id: randomUUID(), name, description: description ?? null, domain: 'integration', content, source: 'github', githubPath: dir.path, orgId: null, lastSyncedAt: new Date(), createdAt: new Date() }) }
        synced++
      }
      return { synced }
    } catch (err: any) { return reply.code(500).send({ error: err.message }) }
  })

  // ── Obsidian Vault Sync ────────────────────────────────────────────────
  // POST /api/skills/obsidian-sync
  // Body: { skills: Array<{ name, description?, domain, content, vaultPath } }
  // Upserts by (name + source='obsidian').
  app.post('/api/skills/obsidian-sync', async (req, reply) => {
    const body = req.body as any
    const skills: Array<{ name: string; description?: string; domain: string; content: string; vaultPath: string }> = body?.skills ?? []
    if (!Array.isArray(skills)) return reply.code(400).send({ error: 'skills must be an array' })
    let synced = 0
    for (const s of skills) {
      if (!s.name || !s.content) continue
      const existing = await db.query.skills.findFirst({
        where: and(eq(schema.skills.name, s.name), eq(schema.skills.source, 'obsidian'))
      })
      if (existing) {
        await db.update(schema.skills).set({
          description: s.description ?? existing.description,
          domain: s.domain ?? existing.domain,
          content: s.content,
          githubPath: s.vaultPath ?? existing.githubPath,
          lastSyncedAt: new Date(),
        }).where(eq(schema.skills.id, existing.id))
      } else {
        await db.insert(schema.skills).values({
          id: randomUUID(),
          name: s.name,
          description: s.description ?? null,
          domain: s.domain ?? 'integration',
          content: s.content,
          source: 'obsidian',
          githubPath: s.vaultPath ?? null,
          orgId: null,
          lastSyncedAt: new Date(),
          createdAt: new Date(),
        })
      }
      synced++
    }
    return { synced }
  })
}
