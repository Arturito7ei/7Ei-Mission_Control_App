// Workspaces & runtime (MCA-PC D1). The control plane models workspaces and
// operator branches; self-hosted runtimes do the actual `git worktree` work.

export interface Workspace {
  id: string; name: string; repoUrl?: string | null; baseBranch?: string | null
}

const slug = (s: string) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24)

/** Deterministic operator branch for a task: "<prefix>/<slug>-<taskShort>". */
export function operatorBranch(taskId: string, opts?: { prefix?: string; title?: string }): string {
  const prefix = (opts?.prefix || 'op').replace(/\/+$/, '')
  const short = String(taskId).replace(/-/g, '').slice(0, 8)
  const title = opts?.title ? `${slug(opts.title)}-` : ''
  return `${prefix}/${title}${short}`
}

/** Isolated worktree path under a base checkout for a task. */
export function worktreePath(baseDir: string, taskId: string): string {
  const short = String(taskId).replace(/-/g, '').slice(0, 8)
  return `${String(baseDir).replace(/\/+$/, '')}/.worktrees/task-${short}`
}

/** Build the runtime payload a self-hosted agent needs to materialise a workspace. */
export function workspaceRuntime(ws: Workspace, taskId: string, branchPrefix?: string): {
  workspaceId: string; name: string; repoUrl: string | null; baseBranch: string; branch: string; worktree: string
} {
  const base = ws.baseBranch || 'main'
  return {
    workspaceId: ws.id, name: ws.name, repoUrl: ws.repoUrl ?? null, baseBranch: base,
    branch: operatorBranch(taskId, { prefix: branchPrefix || 'op' }),
    worktree: worktreePath('.', taskId),
  }
}
