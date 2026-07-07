#!/usr/bin/env node
// 7ei-mc — thin operator CLI over the agent API. Zero dependencies (Node 18+ global fetch).
import { buildRequest, HELP } from './lib.mjs'
import { parseOnboard, orgRequest, agentRequest, ONBOARD_HELP } from './onboard.mjs'

const args = process.argv.slice(2)
if (!args.length || args[0] === 'help' || args[0] === '-h' || args[0] === '--help') { console.log(HELP); process.exit(0) }

const BASE = process.env.MC_BASE_URL || 'https://7ei-backend.fly.dev'
const TOKEN = process.env.MC_AGENT_TOKEN

// ─── onboard: multi-step, Clerk-authed (mint org + agent + token) ────────────
if (args[0] === 'onboard') {
  await runOnboard(args.slice(1))
  process.exit(0)
}

let req
try { req = buildRequest(args) } catch (e) { console.error('✗', e.message, '\n\n' + HELP); process.exit(2) }

// Public endpoints (e.g. openapi) need no auth; everything else needs the agent token.
if (!req.public && !TOKEN) { console.error('MC_AGENT_TOKEN is required (mint one via `onboard` or Cockpit → agent card)'); process.exit(2) }

const res = await fetch(BASE + req.path, {
  method: req.method,
  headers: {
    ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    ...(req.body ? { 'Content-Type': 'application/json' } : {}),
  },
  body: req.body ? JSON.stringify(req.body) : undefined,
})
const text = await res.text()
let out = text; try { out = JSON.stringify(JSON.parse(text), null, 2) } catch {}
console.log(out)
process.exit(res.ok ? 0 : 1)

// ── onboard runner ───────────────────────────────────────────────────────────
async function runOnboard(rest) {
  if (rest[0] === 'help' || rest[0] === '-h' || rest[0] === '--help') { console.log(ONBOARD_HELP); process.exit(0) }

  let cfg
  try { cfg = parseOnboard(rest) } catch (e) { console.error('✗', e.message, '\n\n' + ONBOARD_HELP); process.exit(2) }

  if (cfg.dryRun) {
    const plan = []
    if (cfg.orgName) plan.push(orgRequest(cfg))
    plan.push(agentRequest(cfg, cfg.orgId ?? ':orgId (from the org just created)'))
    console.log('dry run — planned requests (auth: Clerk session JWT):')
    console.log(JSON.stringify(plan, null, 2))
    return
  }

  const clerk = process.env.MC_CLERK_TOKEN
  if (!clerk) {
    console.error('MC_CLERK_TOKEN is required — a Clerk session JWT from the web console.\nCopy it from the app (DevTools → the Authorization bearer sent to the API), then:\n  MC_CLERK_TOKEN=... npx @7ei/mc onboard --org-name "My Org" --name Scout\n\n' + ONBOARD_HELP)
    process.exit(2)
  }

  const call = async (r) => {
    const res = await fetch(BASE + r.path, {
      method: r.method,
      headers: { Authorization: `Bearer ${clerk}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(r.body),
    })
    const text = await res.text()
    let json; try { json = JSON.parse(text) } catch { json = null }
    if (!res.ok) throw new Error(`${r.method} ${r.path} → ${res.status}: ${json?.error ?? text}`)
    return json
  }

  try {
    let orgId = cfg.orgId
    if (cfg.orgName) {
      const { org } = await call(orgRequest(cfg))
      orgId = org.id
      console.log(`✓ org created: ${org.name} (${orgId}) — Arturito auto-hired`)
    }
    const { agent, agentToken } = await call(agentRequest(cfg, orgId))
    console.log(`✓ agent created: ${agent.name} — ${agent.role} (${agent.id})`)
    console.log('\nAgent token (shown once — store it now):\n')
    console.log(`  export MC_AGENT_TOKEN=${agentToken}`)
    console.log(`  export MC_BASE_URL=${BASE}`)
    console.log('\nNext: `7ei-mc me` to verify, then `7ei-mc tasks`.')
  } catch (e) {
    console.error('✗', e.message)
    process.exit(1)
  }
}
