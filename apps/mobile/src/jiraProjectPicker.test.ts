import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  resolveJiraProjectSelection as webResolve,
  jiraProjectLabel as webLabel,
} from '../../../web/app/dashboard/assistant.logic.ts'

import { resolveJiraProjectSelection, jiraProjectLabel } from './jiraProjectPicker.ts'

const PROJECTS = [
  { id: '1', key: 'MCA', name: 'Mission Control' },
  { id: '2', key: 'OS', name: '7Ei OS' },
] as const

test('[GC-3 parity] resolveJiraProjectSelection agrees with the desk', () => {
  for (const saved of [null, 'OS', 'GONE'] as const) {
    for (const def of [null, 'MCA'] as const) {
      assert.equal(
        resolveJiraProjectSelection(PROJECTS, saved, def),
        webResolve(PROJECTS, saved, def),
      )
    }
  }
})

test('[GC-3 parity] jiraProjectLabel agrees with the desk', () => {
  for (const key of ['MCA', 'MISSING', '']) {
    assert.equal(jiraProjectLabel(PROJECTS, key), webLabel(PROJECTS, key))
  }
})
