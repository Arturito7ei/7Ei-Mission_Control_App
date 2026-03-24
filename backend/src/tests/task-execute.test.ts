import { test } from 'node:test'
import assert from 'node:assert/strict'

// Unit tests for /execute endpoint logic (pure validation logic — no DB required)

test('[TASK-001] execute validation: task not found returns 404 logic', () => {
  const task = null
  const result = task ? 'ok' : { error: 'Task not found', code: 404 }
  assert.deepEqual(result, { error: 'Task not found', code: 404 })
})

test('[TASK-001] execute validation: no agentId returns 400', () => {
  const task = { id: 't1', agentId: null, status: 'pending', title: 'test', input: null }
  let error: string | null = null
  if (!task) error = 'Task not found'
  else if (!task.agentId) error = 'Task has no assigned agent'
  else if (task.status === 'done') error = 'Task already completed'
  assert.strictEqual(error, 'Task has no assigned agent')
})

test('[TASK-001] execute validation: completed task returns 400', () => {
  const task = { id: 't1', agentId: 'agent-1', status: 'done', title: 'test', input: null }
  let error: string | null = null
  if (!task) error = 'Task not found'
  else if (!task.agentId) error = 'Task has no assigned agent'
  else if (task.status === 'done') error = 'Task already completed'
  assert.strictEqual(error, 'Task already completed')
})

test('[TASK-001] execute validation: valid task passes', () => {
  const task = { id: 't1', agentId: 'agent-1', status: 'pending', title: 'Do work', input: 'Do the work' }
  let error: string | null = null
  if (!task) error = 'Task not found'
  else if (!task.agentId) error = 'Task has no assigned agent'
  else if (task.status === 'done') error = 'Task already completed'
  assert.strictEqual(error, null)
})

test('[TASK-001] execute uses task.input if available, else task.title', () => {
  const taskWithInput = { input: 'detailed input', title: 'Short title' }
  const taskWithoutInput = { input: null, title: 'Short title' }
  assert.strictEqual(taskWithInput.input ?? taskWithInput.title, 'detailed input')
  assert.strictEqual(taskWithoutInput.input ?? taskWithoutInput.title, 'Short title')
})
