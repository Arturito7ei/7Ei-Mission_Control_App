import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { operatorBranch, worktreePath, workspaceRuntime } from '../services/workspaces.ts'

describe('[MCA-PC D1] operatorBranch', () => {
  it('is deterministic with prefix + short id', () => {
    assert.equal(operatorBranch('abcdef12-3456-7890', { prefix: 'cursor' }), 'cursor/abcdef12')
  })
  it('includes a slugged title when provided', () => {
    assert.equal(operatorBranch('abcdef12-0000', { prefix: 'cc', title: 'Add Login!' }), 'cc/add-login-abcdef12')
  })
  it('defaults the prefix to op', () => {
    assert.match(operatorBranch('abcdef1234'), /^op\/abcdef12$/)
  })
})

describe('[MCA-PC D1] worktreePath', () => {
  it('nests under .worktrees', () => {
    assert.equal(worktreePath('/repo', 'abcdef12-99'), '/repo/.worktrees/task-abcdef12')
  })
})

describe('[MCA-PC D1] workspaceRuntime', () => {
  it('resolves repo, base, branch, worktree', () => {
    const r = workspaceRuntime({ id: 'w1', name: 'app', repoUrl: 'git@x', baseBranch: 'develop' }, 'abcdef12-1', 'claw')
    assert.equal(r.workspaceId, 'w1')
    assert.equal(r.baseBranch, 'develop')
    assert.equal(r.branch, 'claw/abcdef12')
  })
  it('defaults baseBranch to main', () => {
    assert.equal(workspaceRuntime({ id: 'w', name: 'n' }, 't1').baseBranch, 'main')
  })
})
