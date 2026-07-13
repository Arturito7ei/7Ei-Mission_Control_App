import { test } from 'node:test'
import assert from 'node:assert/strict'
import { adapterProfile, mcEnv, runBlock } from './adapterProfile.ts'

test('[CC4] claude_code resolves the claude-code adapter (not OpenClaw)', () => {
  const p = adapterProfile('claude_code')
  assert.equal(p.adapter, 'adapters/claude-code/cc_adapter.py')
  assert.equal(p.runner, 'python3')
})

test('[CC4] each runtime maps to its own adapter', () => {
  assert.equal(adapterProfile('openclaw').adapter, 'adapters/openclaw/mc_adapter.py')
  assert.equal(adapterProfile('cursor').adapter, 'adapters/cursor/cursor_adapter.py')
  assert.equal(adapterProfile('claude_code').adapter, 'adapters/claude-code/cc_adapter.py')
})

test('[CC4] unknown runtime falls back to openclaw', () => {
  assert.equal(adapterProfile('k8s').adapter, 'adapters/openclaw/mc_adapter.py')
  assert.equal(adapterProfile(null).adapter, 'adapters/openclaw/mc_adapter.py')
})

test('[CC4] claude_code env is propose-and-approve (plan mode), never autonomous', () => {
  const env = mcEnv('claude_code', 'https://api', 'mca_x')
  assert.match(env, /MC_BASE_URL=https:\/\/api/)
  assert.match(env, /MC_AGENT_TOKEN=mca_x/)
  assert.match(env, /CC_PERMISSION_MODE=plan/)
  assert.match(env, /MC_WORKDIR=/)
  // never ship an autonomous flag from the wizard
  assert.equal(/CC_AUTONOMOUS/.test(env), false)
  assert.equal(/bypassPermissions/.test(env), false)
})

test('[CC4] claude_code env does NOT carry the OpenClaw shell flags', () => {
  const env = mcEnv('claude_code', 'https://api', 'mca_x')
  assert.equal(/MC_ALLOW_SHELL/.test(env), false)
  assert.equal(/MC_EXECUTOR/.test(env), false)
})

test('[CC4] runBlock points at the right adapter + sources mc.env', () => {
  const block = runBlock('claude_code', 'https://api', 'mca_x')
  assert.match(block, /# mc\.env/)
  assert.match(block, /set -a; source mc\.env; set \+a/)
  assert.match(block, /python3 adapters\/claude-code\/cc_adapter\.py/)
})

test('[CC4] openclaw block keeps its existing shape (no regression)', () => {
  const env = mcEnv('openclaw', 'https://api', 'mca_x')
  assert.match(env, /MC_EXECUTOR=auto/)
  assert.match(env, /MC_ALLOW_SHELL=1/)
  assert.match(env, /MC_WORKDIR=/)
  assert.match(runBlock('openclaw', 'https://api', 'mca_x'), /python3 adapters\/openclaw\/mc_adapter\.py/)
})

test('[CC4] cursor block uses the inbox env + cursor adapter', () => {
  assert.match(mcEnv('cursor', 'https://api', 'mca_x'), /MC_INBOX=\$PWD\/coordination\/inbox/)
  assert.match(runBlock('cursor', 'https://api', 'mca_x'), /python3 adapters\/cursor\/cursor_adapter\.py/)
})
