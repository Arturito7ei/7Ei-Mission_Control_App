#!/usr/bin/env node
// 7ei-mc — thin operator CLI over the agent API. Zero dependencies (Node 18+ global fetch).
import { buildRequest, HELP } from './lib.mjs'

const args = process.argv.slice(2)
if (!args.length || args[0] === 'help' || args[0] === '-h' || args[0] === '--help') { console.log(HELP); process.exit(0) }

const BASE = process.env.MC_BASE_URL || 'https://7ei-backend.fly.dev'
const TOKEN = process.env.MC_AGENT_TOKEN

let req
try { req = buildRequest(args) } catch (e) { console.error('✗', e.message, '\n\n' + HELP); process.exit(2) }

// Public endpoints (e.g. openapi) need no auth; everything else needs the agent token.
if (!req.public && !TOKEN) { console.error('MC_AGENT_TOKEN is required (mint one in Cockpit → agent card)'); process.exit(2) }

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
