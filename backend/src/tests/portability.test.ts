import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildExport, remapImport } from '../services/portability.ts'

const sample = {
  org: { id: 'o1', name: 'Acme', mission: 'win', telegramBotToken: 'SECRET', ownerId: 'u1' },
  agents: [
    { id: 'ceo', name: 'CEO', role: 'CEO', reportsTo: null, apiTokenHash: 'HASH', llmProvider: 'anthropic', llmModel: 'm', skills: [] },
    { id: 'eng', name: 'Eng', role: 'Engineer', reportsTo: 'ceo', externalEndpoint: 'http://x', heartbeatEverySec: 60 },
  ],
  goals: [{ id: 'g1', title: 'Root', parentGoalId: null, ownerAgentId: 'ceo' }, { id: 'g2', title: 'Sub', parentGoalId: 'g1', ownerAgentId: null }],
  budgets: [{ scope: 'agent', scopeId: 'eng', limitUsd: 50, hardStop: true }, { scope: 'company', scopeId: null, limitUsd: 500 }],
  routines: [{ id: 'r1', title: 'Daily', cronExpression: '0 8 * * *', triggerType: 'cron', agentId: 'eng', enabled: true, webhookToken: 'OLD' }],
}

describe('[MCA-PC D3] buildExport', () => {
  const b = buildExport(sample as any)
  it('scrubs secrets', () => {
    assert.equal((b.org as any).telegramBotToken, undefined)
    assert.equal((b.org as any).ownerId, undefined)
    assert.equal((b.agents[0] as any).apiTokenHash, undefined)
    assert.equal((b.agents[1] as any).externalEndpoint, undefined)
    assert.equal((b.routines[0] as any).webhookToken, undefined)
  })
  it('keeps refIds and references', () => {
    assert.equal(b.agents[1].refId, 'eng')
    assert.equal(b.agents[1].reportsTo, 'ceo')
    assert.equal(b.goals[1].parentGoalId, 'g1')
  })
})

describe('[MCA-PC D3] remapImport', () => {
  let n = 0
  const gen = () => `new${n++}`
  const r = remapImport(buildExport(sample as any), 'ORG2', gen)
  it('remaps agent ids + reportsTo into the new org', () => {
    const ceo = r.agents.find(a => a.name === 'CEO')!, eng = r.agents.find(a => a.name === 'Eng')!
    assert.equal(eng.orgId, 'ORG2')
    assert.equal(eng.reportsTo, ceo.id)
    assert.notEqual(ceo.id, 'ceo')
  })
  it('remaps goal parent + owner refs', () => {
    const root = r.goals.find(g => g.title === 'Root')!, sub = r.goals.find(g => g.title === 'Sub')!
    assert.equal(sub.parentGoalId, root.id)
    assert.equal(root.ownerAgentId, r.agents.find(a => a.name === 'CEO')!.id)
  })
  it('remaps agent-scoped budget; company budget stays null', () => {
    const ab = r.budgets.find(b => b.scope === 'agent')!, cb = r.budgets.find(b => b.scope === 'company')!
    assert.equal(ab.scopeId, r.agents.find(a => a.name === 'Eng')!.id)
    assert.equal(cb.scopeId, null)
  })
  it('remaps routine agent + drops old token', () => {
    assert.equal(r.routines[0].agentId, r.agents.find(a => a.name === 'Eng')!.id)
    assert.equal(r.routines[0].webhookToken, null)  // cron → no token
  })
})
