import { FastifyInstance } from 'fastify'
import { db, schema } from '../db/client'
import { eq, and } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { encrypt, decrypt } from '../services/secrets'
import { buildAuthUrl } from '../services/google-auth'
import { getJiraCfg, clearJiraCfg } from './jira'
import { CONNECTORS, getConnector, tokenTestRequest, parseAccount, buildStatus } from '../services/connectors'
import { parseVaultConfig, vaultList } from '../services/vault-connector'

// ─── Connectors tab (unified connection manager) ────────────────────────────
// Token/basic credentials → D4 secret store (AES-256-GCM). Google trio →
// shared oauth_tokens 'google' row. Status, connect, test, disconnect.

const secWhere = (orgId: string, key: string) =>
  and(eq(schema.secrets.orgId, orgId), eq(schema.secrets.scope, 'company'), eq(schema.secrets.key, key))

async function getSecret(orgId: string, key: string): Promise<string | null> {
  const r = await db.query.secrets.findFirst({ where: secWhere(orgId, key) })
  if (!r) return null
  try { return decrypt(r.valueEncrypted) } catch { return null }
}
async function setSecret(orgId: string, key: string, val: string): Promise<void> {
  const r = await db.query.secrets.findFirst({ where: secWhere(orgId, key) })
  const enc = encrypt(val)
  if (r) await db.update(schema.secrets).set({ valueEncrypted: enc }).where(eq(schema.secrets.id, r.id))
  else await db.insert(schema.secrets).values({ id: randomUUID(), orgId, scope: 'company', scopeId: null, key, valueEncrypted: enc, createdAt: new Date() })
}
async function delSecret(orgId: string, key: string): Promise<void> {
  await db.delete(schema.secrets).where(secWhere(orgId, key))
}
async function googleConnected(orgId: string): Promise<boolean> {
  const t = await db.query.oauthTokens.findFirst({ where: and(eq(schema.oauthTokens.orgId, orgId), eq(schema.oauthTokens.provider, 'google')) })
  return !!t
}

export async function connectorRoutes(app: FastifyInstance) {
  // Status for all six connectors.
  app.get('/api/orgs/:orgId/connectors', async (req) => {
    const { orgId } = req.params as any
    const [ghTok, ghAcc, hfTok, hfAcc, jcfg, gConn, vaultTok, vaultRaw] = await Promise.all([
      getSecret(orgId, 'GITHUB_TOKEN'), getSecret(orgId, 'GITHUB_ACCOUNT'),
      getSecret(orgId, 'HUGGINGFACE_TOKEN'), getSecret(orgId, 'HUGGINGFACE_ACCOUNT'),
      getJiraCfg(orgId), googleConnected(orgId),
      getSecret(orgId, 'GITHUB_VAULT_TOKEN'), getSecret(orgId, 'VAULT_CONFIG'),
    ])
    const vcfg = parseVaultConfig(vaultRaw)
    const byId: Record<string, { connected: boolean; detail?: string | null }> = {
      github: { connected: !!ghTok, detail: ghAcc },
      huggingface: { connected: !!hfTok, detail: hfAcc },
      jira: { connected: !!jcfg, detail: jcfg ? `${jcfg.email} · ${jcfg.domain} (${jcfg.defaultProjectKey})` : null },
      gmail: { connected: gConn, detail: gConn ? 'Google account' : null },
      gcal: { connected: gConn, detail: gConn ? 'Google account' : null },
      gdrive: { connected: gConn, detail: gConn ? 'Google account' : null },
      obsidian: { connected: !!vaultTok, detail: vaultTok ? `${vcfg.repo} · ${vcfg.root}/ (${vcfg.branch})` : null },
    }
    return { connectors: CONNECTORS.map(m => buildStatus(m, byId[m.id])) }
  })

  // Connect: token/basic validate + persist; oauth returns an authorize URL.
  app.post('/api/orgs/:orgId/connectors/:id/connect', async (req, reply) => {
    const { orgId, id } = req.params as any
    const meta = getConnector(id)
    if (!meta) return reply.code(404).send({ error: 'Unknown connector' })
    const body = (req.body ?? {}) as any

    if (meta.authType === 'oauth') return { authUrl: buildAuthUrl(orgId) }

    if (id === 'obsidian') {
      const repo = String(body.repo ?? '').trim()
      const token = String(body.token ?? '').trim()
      if (!repo || !token) return reply.code(400).send({ error: 'repo (owner/name) and token required' })
      const cfg = { repo, root: (String(body.root ?? '').trim() || 'vault'), branch: (String(body.branch ?? '').trim() || 'main') }
      let check
      try { check = await vaultList(token, cfg, cfg.root) } catch { return reply.code(502).send({ error: 'GitHub unreachable' }) }
      if (!check.ok) return reply.code(401).send({ error: `Cannot read ${repo}/${cfg.root} (GitHub ${check.status}) — check repo, root, branch, and token scope` })
      await setSecret(orgId, 'VAULT_CONFIG', JSON.stringify(cfg))
      await setSecret(orgId, 'GITHUB_VAULT_TOKEN', token)
      return { connected: true, detail: `${repo} · ${cfg.root}/ (${check.entries?.length ?? 0} items)` }
    }

    if (meta.authType === 'token') {
      const token = String(body.token ?? '').trim()
      if (!token) return reply.code(400).send({ error: 'token required' })
      const tr = tokenTestRequest(id, token)!
      let res: Response
      try { res = await fetch(tr.url, { headers: tr.headers }) } catch { return reply.code(502).send({ error: `${meta.name} unreachable` }) }
      if (!res.ok) return reply.code(401).send({ error: `Invalid ${meta.name} token` })
      const acct = parseAccount(id, await res.json().catch(() => ({})))
      await setSecret(orgId, meta.secretKey!, token)
      if (meta.accountKey) await setSecret(orgId, meta.accountKey, acct)
      return { connected: true, detail: acct || null }
    }

    // basic → Jira
    const { domain, email, apiToken, defaultProjectKey } = body
    if (!domain || !email || !apiToken) return reply.code(400).send({ error: 'domain, email, apiToken required' })
    const auth = 'Basic ' + Buffer.from(`${email}:${apiToken}`).toString('base64')
    let res: Response
    try { res = await fetch(`https://${domain}.atlassian.net/rest/api/3/myself`, { headers: { Authorization: auth, Accept: 'application/json' } }) }
    catch { return reply.code(502).send({ error: 'Jira unreachable' }) }
    if (!res.ok) return reply.code(401).send({ error: 'Invalid Jira credentials' })
    const user = await res.json() as any
    const cfg = { domain, email, apiToken, defaultProjectKey: defaultProjectKey || 'O7MC' }
    await setSecret(orgId, 'JIRA_CONNECTION', JSON.stringify(cfg))
    return { connected: true, detail: `${user.displayName} · ${domain}` }
  })

  // Live re-test of a stored connection.
  app.post('/api/orgs/:orgId/connectors/:id/test', async (req, reply) => {
    const { orgId, id } = req.params as any
    const meta = getConnector(id)
    if (!meta) return reply.code(404).send({ error: 'Unknown connector' })

    if (meta.authType === 'token') {
      const tok = await getSecret(orgId, meta.secretKey!)
      if (!tok) return reply.code(400).send({ ok: false, error: 'not connected' })
      const tr = tokenTestRequest(id, tok)!
      const res = await fetch(tr.url, { headers: tr.headers })
      if (!res.ok) return reply.code(502).send({ ok: false, error: `${meta.name} auth failed` })
      return { ok: true, detail: parseAccount(id, await res.json().catch(() => ({}))) || null }
    }
    if (id === 'obsidian') {
      const token = await getSecret(orgId, 'GITHUB_VAULT_TOKEN')
      if (!token) return reply.code(400).send({ ok: false, error: 'not connected' })
      const cfg = parseVaultConfig(await getSecret(orgId, 'VAULT_CONFIG'))
      const r = await vaultList(token, cfg, cfg.root)
      if (!r.ok) return reply.code(502).send({ ok: false, error: `GitHub ${r.status}` })
      return { ok: true, detail: `${cfg.repo} · ${cfg.root}/ (${r.entries?.length ?? 0} items)` }
    }
    if (id === 'jira') {
      const cfg = await getJiraCfg(orgId)
      if (!cfg) return reply.code(400).send({ ok: false, error: 'not connected' })
      const auth = 'Basic ' + Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString('base64')
      const res = await fetch(`https://${cfg.domain}.atlassian.net/rest/api/3/myself`, { headers: { Authorization: auth, Accept: 'application/json' } })
      if (!res.ok) return reply.code(502).send({ ok: false, error: 'Jira auth failed' })
      const u = await res.json() as any
      return { ok: true, detail: `${u.displayName} · ${cfg.domain}` }
    }
    const conn = await googleConnected(orgId)
    return { ok: conn, detail: conn ? 'Google connected' : 'not connected' }
  })

  // Disconnect.
  app.delete('/api/orgs/:orgId/connectors/:id', async (req, reply) => {
    const { orgId, id } = req.params as any
    const meta = getConnector(id)
    if (!meta) return reply.code(404).send({ error: 'Unknown connector' })
    if (meta.authType === 'token') {
      await delSecret(orgId, meta.secretKey!)
      if (meta.accountKey) await delSecret(orgId, meta.accountKey)
    } else if (id === 'jira') {
      await clearJiraCfg(orgId)
    } else if (id === 'obsidian') {
      await delSecret(orgId, 'VAULT_CONFIG')
      await delSecret(orgId, 'GITHUB_VAULT_TOKEN')
    } else if (meta.authType === 'oauth') {
      await db.delete(schema.oauthTokens).where(and(eq(schema.oauthTokens.orgId, orgId), eq(schema.oauthTokens.provider, 'google')))
    }
    reply.code(204)
  })
}
