// S5 hygiene — /inbox/count must not select task.output for badge polling.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const TASKS = readFileSync(new URL('../routes/tasks.ts', import.meta.url), 'utf8')

test('[S5-hygiene] inboxCountCols omits output', () => {
  const m = /const inboxCountCols = \{([\s\S]*?)\n  \}/.exec(TASKS)
  assert.ok(m, 'inboxCountCols block missing — re-anchor test')
  assert.ok(!m![1].includes('output'), 'inboxCountCols still selects output')
})

test('[S5-hygiene] GET /inbox/count uses inboxCountCols, not inboxCols', () => {
  const countRoute = TASKS.slice(TASKS.indexOf("app.get('/api/orgs/:orgId/inbox/count'"))
  assert.ok(countRoute.includes('inboxCountCols'), '/inbox/count must use inboxCountCols')
  const selectLine = countRoute.split('\n').find((l) => l.includes('db.select(')) ?? ''
  assert.ok(selectLine.includes('inboxCountCols'), 'count route select must be inboxCountCols')
  assert.ok(!selectLine.includes('inboxCols'), 'count route must not select inboxCols')
})

test('[S5-hygiene] GET /inbox still selects output for failed-row preview', () => {
  const m = /const inboxCols = \{([\s\S]*?)\n  \}/.exec(TASKS)
  assert.ok(m, 'inboxCols block missing — re-anchor test')
  assert.ok(m![1].includes('output'), 'GET /inbox inboxCols must still select output for buildInbox')
})
