#!/usr/bin/env node
// 7ei-mc — thin operator CLI over the agent API. Zero dependencies (Node 18+ global fetch).
import { writeFileSync, rmSync } from 'node:fs'
import { buildRequest, HELP } from './lib.mjs'
import { parseOnboard, orgRequest, agentRequest, ONBOARD_HELP } from './onboard.mjs'
import {
  parseInviteCreate, inviteCreateRequest, INVITE_HELP,
  parseAgentOnboard, joinRequestPlan, claimRequestPlan, mcEnvLines, AGENT_ONBOARD_HELP,
} from './invite.mjs'

const args = process.argv.slice(2)
if (!args.length || args[0] === 'help' || args[0] === '-h' || args[0] === '--help') { console.log(HELP); process.exit(0) }

const BASE = process.env.MC_BASE_URL || 'https://7ei-backend.fly.dev'
const TOKEN = process.env.MC_AGENT_TOKEN

// ─── invite: create an invite (operator, Clerk-authed) — ONB6 ────────────────
if (args[0] === 'invite') {
  await runInvite(args.slice(1))
  process.exit(0)
}

// ─── onboard: Clerk-authed operator mint, OR — with --invite — the agent-side
//     client (join → poll → claim → write chmod-600 mc.env). ONB6. ────────────
if (args[0] === 'onboard') {
  if (args.includes('--invite')) { await runAgentOnboard(args.slice(1)); process.exit(0) }
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

// ── invite runner: mint an invite (operator, Clerk-authed) ─────────────────────
async function runInvite(rest) {
  const sub = rest[0]
  if (!sub || sub === 'help' || sub === '-h' || sub === '--help') { console.log(INVITE_HELP); process.exit(sub ? 0 : 2) }
  if (sub !== 'create') { console.error('✗ unknown invite subcommand:', sub, '\n\n' + INVITE_HELP); process.exit(2) }

  let cfg
  try { cfg = parseInviteCreate(rest.slice(1)) } catch (e) { console.error('✗', e.message, '\n\n' + INVITE_HELP); process.exit(2) }

  const plan = inviteCreateRequest(cfg)
  if (cfg.dryRun) {
    console.log('dry run — planned request (auth: Clerk session JWT):')
    console.log(JSON.stringify(plan, null, 2))
    return
  }

  const clerk = process.env.MC_CLERK_TOKEN
  if (!clerk) {
    console.error('MC_CLERK_TOKEN is required — a Clerk session JWT from the web console.\n\n' + INVITE_HELP)
    process.exit(2)
  }

  const res = await fetch(BASE + plan.path, {
    method: plan.method,
    headers: { Authorization: `Bearer ${clerk}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(plan.body),
  })
  const text = await res.text()
  let json; try { json = JSON.parse(text) } catch { json = null }
  if (!res.ok) { console.error(`✗ ${plan.method} ${plan.path} → ${res.status}: ${json?.error ?? text}`); process.exit(1) }

  // The invite token + the onboarding prompt exist ONLY in this response. There is
  // NO agent key here — the key is minted only when the joining agent claims it.
  console.log(`✓ invite created (${json.invite?.status ?? 'active'}) — shown ONCE, not recoverable\n`)
  console.log(`Invite token:   ${json.inviteToken}`)
  console.log(`Onboarding doc: ${json.onboardingTextUrl}`)
  if (json.joinEnabled === false) {
    console.log('\n⚠ The public join endpoint is CLOSED on this deployment (hosted profile).')
    console.log('  The invite + prompt are ready; agents cannot join until remote onboarding is enabled.')
  }
  console.log('\n─── Paste this prompt into the agent you want to onboard ───\n')
  console.log(json.onboardingPrompt)
  console.log('\n────────────────────────────────────────────────────────────')
}

// ── agent-side onboard: join → poll → claim → write chmod-600 mc.env ──────────
async function runAgentOnboard(rest) {
  if (rest[0] === 'help' || rest[0] === '-h' || rest[0] === '--help') { console.log(AGENT_ONBOARD_HELP); process.exit(0) }

  let cfg
  try { cfg = parseAgentOnboard(rest) } catch (e) { console.error('✗', e.message, '\n\n' + AGENT_ONBOARD_HELP); process.exit(2) }
  const base = (cfg.mcApiUrl || BASE).replace(/\/+$/, '')

  const join = joinRequestPlan(cfg)
  if (cfg.dryRun) {
    console.log('dry run — planned join request (public, invite-token-bearer):')
    console.log(JSON.stringify({ ...join, url: base + join.path }, null, 2))
    return
  }

  const post = async (plan) => {
    const res = await fetch(base + plan.path, {
      method: plan.method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(plan.body),
    })
    const text = await res.text()
    let json; try { json = JSON.parse(text) } catch { json = null }
    return { status: res.status, ok: res.ok, json, text }
  }

  // 1) Join.
  console.log(`→ submitting join request to ${base} as "${cfg.agentName}" (${cfg.adapterType})…`)
  const j = await post(join)
  if (!j.ok) { console.error(`✗ join refused (${j.status}): ${j.json?.error ?? j.text}`); process.exit(1) }
  const requestId = j.json?.requestId
  const claimSecret = j.json?.claimSecret
  if (!requestId) { console.error('✗ no requestId in join response'); process.exit(1) }
  console.log(`✓ join request ${requestId} submitted — waiting for a human to approve.`)
  if (!claimSecret) {
    console.log('The claim step is not open on this deployment, so no claim secret was issued.')
    console.log('Tell your operator you are approved-and-waiting; there is no key to claim yet.')
    process.exit(0)
  }

  // 2) Poll the claim until a human approves (every failure is one flat 404).
  const deadline = Date.now() + cfg.maxWaitSeconds * 1000
  const claimPlan = claimRequestPlan(requestId, claimSecret)
  let token = null
  while (Date.now() < deadline) {
    const c = await post(claimPlan)
    if (c.ok && c.json?.token) { token = c.json.token; break }
    process.stdout.write('.')
    await new Promise((r) => setTimeout(r, cfg.pollSeconds * 1000))
  }
  process.stdout.write('\n')
  if (!token) {
    console.error(`✗ gave up after ${cfg.maxWaitSeconds}s — the request was not approved (or the claim secret expired).`)
    console.error('  Confirm with your operator that you were approved, then re-run.')
    process.exit(1)
  }

  // 3) Write the token to a chmod-600 mc.env. NEVER print it.
  // Remove any pre-existing file FIRST: writeFileSync's `mode` is honoured only when
  // the file is created, so overwriting a mc.env another run (or tool) left behind
  // world-readable would write the fresh agent token while keeping those loose perms.
  // Deleting first makes the 0o600 apply atomically at creation, with no exposure window.
  rmSync(cfg.out, { force: true })
  writeFileSync(cfg.out, mcEnvLines(cfg, base, token), { mode: 0o600 })
  console.log(`✓ onboarded — wrote ${cfg.out} (chmod 600). The agent token is in the file and was never printed.`)
  console.log(`  Source it and start your adapter: set -a; source ${cfg.out}; set +a`)
  console.log('  You start in low-trust review — your first actions may be queued for human approval.')
}
