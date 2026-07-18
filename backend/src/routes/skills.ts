import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db, schema } from '../db/client'
import { eq, and } from 'drizzle-orm'
import { randomUUID } from 'crypto'

// ─── SKILLS ──────────────────────────────────────────────────────────────────

const SKILL_LIBRARY_REPO = 'Arturito7ei/skill-library'

// GC-0b — WHY THIS SCHEMA AND THE GLOBAL-SKILL RULE EXIST.
//
// `PATCH /api/skills/:skillId` was `db.update(skills).set(req.body as any)`, and on
// this table that is the worst instance of the class, for a reason specific to skills:
// a skill's `content` is PROMPT MATERIAL FED TO AGENTS. Rewriting it is not a data
// edit, it is an INSTRUCTION-INJECTION path into every agent that loads the skill.
//
// And the membership gate does not merely mis-order here — for a GLOBAL skill it
// STANDS DOWN ENTIRELY. `RECORD_ORG_ROUTES` marks `/api/skills/` `nullOrgIsGlobal`,
// so `resolveRequestOrg` returns `{ scoped: false }` for a row with `orgId == null`
// (middleware/rbac.ts). That is correct for READS — the library is deliberately a
// global shared catalogue, `orgId` is a tag rather than a boundary — but the same
// stand-down applied to the WRITE, so ANY AUTHENTICATED USER, INCLUDING ONE
// BELONGING TO NO ORG AT ALL, could rewrite shared-library prompt text.
//
// THE RULE THIS IMPLEMENTS: a GLOBAL skill (`orgId == null`) is NOT editable through
// this route by anyone. Its write path is the SYNC surface — `POST /api/skills/sync`
// (the GitHub skill-library) and `POST /api/skills/obsidian-sync` (the vault) — which
// is where library content legitimately comes from. An ORG-OWNED skill (`orgId` set)
// stays editable by a member of that org, which the gate already enforces correctly.
//
// Why refuse rather than raise the role to owner: `requireOrgRole('owner')` CANNOT be
// expressed on this path. It reads `:orgId` from the URL, and on a path without one it
// silently no-ops — the documented R-4 trap, an owner gate that enforces nothing. A
// global skill has no org to be an owner OF. Fail-closed is the only honest option at
// this path, and it costs nothing: no client PATCHes a skill (web and mobile call only
// `POST /api/skills/sync`), so this removes an attack surface, not a feature.
const SkillPatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().nullable().optional(),
  domain: z.string().min(1).max(100).optional(),
  content: z.string().max(200_000).optional(),
})
// Deliberately absent, and each for its own reason:
//   • `orgId`       — the tenant boundary, BIDIRECTIONALLY. It would let an org skill be
//                     re-homed into another org, and — the subtler direction — let a
//                     member PROMOTE their org's skill to GLOBAL by writing `null`,
//                     pushing their own prompt text into every other org's library.
//   • `id`          — identity; rewriting it orphans every agent reference to the skill.
//   • `createdAt`   — immutable provenance.
//   • `source`      — provenance the UI trusts to label a skill `github` / `obsidian` /
//                     `custom`; a writable `source` lets hand-written text impersonate
//                     synced library content.
//   • `githubPath`  — the sync JOIN KEY. `POST /api/skills/sync` upserts by it, so a
//                     writable `githubPath` re-points which library file overwrites this
//                     row on the next sync — a write primitive aimed at the sync itself.
//   • `lastSyncedAt`— sync bookkeeping; a forged value misreports staleness.

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
  app.patch('/api/skills/:skillId', async (req, reply) => {
    const { skillId } = req.params as any
    // Read the row FIRST: the global-vs-org decision is a property of the record, and
    // the gate above has already stood down if this skill is global (see the schema
    // comment). 404 rather than a silent no-op `{ok:true}` on a missing skill.
    const skill = await db.query.skills.findFirst({ where: eq(schema.skills.id, skillId) })
    if (!skill) return reply.code(404).send({ error: 'Not found' })
    if (skill.orgId == null) {
      return reply.code(403).send({ error: 'Global library skills are read-only; they are maintained by sync.' })
    }
    const parsed = SkillPatchSchema.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid skill' })
    const patch = parsed.data
    if (Object.keys(patch).length > 0) {
      await db.update(schema.skills).set(patch).where(eq(schema.skills.id, skillId))
    }
    return { ok: true }
  })
  app.delete('/api/skills/:skillId', async (req, reply) => {
    const { skillId } = req.params as any
    // The SAME gate stand-down reaches DELETE, and destructively: an unaffiliated
    // authed user could drop a shared-library skill out from under every org that
    // uses it. Global skills are sync-owned here too.
    const skill = await db.query.skills.findFirst({ where: eq(schema.skills.id, skillId) })
    if (!skill) return reply.code(404).send({ error: 'Not found' })
    if (skill.orgId == null) {
      return reply.code(403).send({ error: 'Global library skills are read-only; they are maintained by sync.' })
    }
    await db.delete(schema.skills).where(eq(schema.skills.id, skillId))
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
