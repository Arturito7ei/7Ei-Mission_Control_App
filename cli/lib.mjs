// Pure request-builder for the 7ei-mc CLI (MCA-ADAPT S2.3).
// Maps argv → { method, path, body? } against the agent API. No IO here → unit-testable.

function need(v, name) { if (!v) throw new Error(`missing ${name}`) }
const q = (p) => encodeURIComponent(p ?? '')

export function buildRequest(args) {
  const [cmd, ...rest] = args
  switch (cmd) {
    case 'me':
      return { method: 'GET', path: '/api/agent/me' }
    case 'tasks':
      return { method: 'GET', path: `/api/agent/tasks?state=${q(rest[0] || 'assigned')}` }
    case 'claim':
      need(rest[0], 'taskId'); return { method: 'POST', path: `/api/agent/tasks/${rest[0]}/claim` }
    case 'result':
      need(rest[0], 'taskId')
      return { method: 'POST', path: `/api/agent/tasks/${rest[0]}/result`, body: { status: rest[1] || 'done', output: rest.slice(2).join(' ') } }
    case 'comment':
      need(rest[0], 'taskId'); return { method: 'POST', path: `/api/agent/tasks/${rest[0]}/comment`, body: { body: rest.slice(1).join(' ') } }
    case 'heartbeat':
      return { method: 'POST', path: '/api/agent/heartbeat', body: { status: rest[0] || 'green' } }
    case 'runlog':
      need(rest[0], 'runId'); return { method: 'POST', path: `/api/agent/runs/${rest[0]}/log`, body: { log: rest.slice(1).join(' ') } }
    case 'mem': {
      const sub = rest[0]
      if (sub === 'tree') return { method: 'GET', path: `/api/agent/memory/tree?path=${q(rest[1] || 'vault')}` }
      if (sub === 'read') { need(rest[1], 'path'); return { method: 'GET', path: `/api/agent/memory/file?path=${q(rest[1])}` } }
      if (sub === 'write') { need(rest[1], 'path'); return { method: 'PUT', path: '/api/agent/memory/file', body: { path: rest[1], markdown: rest.slice(2).join(' ') } } }
      throw new Error('mem <tree|read|write>')
    }
    default:
      throw new Error(`unknown command: ${cmd ?? '(none)'}`)
  }
}

export const HELP = `7ei-mc — operator CLI for the 7Ei Mission Control agent API
env: MC_BASE_URL (default https://7ei-backend.fly.dev), MC_AGENT_TOKEN (required)

  me                                     who am I
  tasks [assigned|in_progress|open|all]  my queue
  claim <taskId>                         atomic checkout (returns runId + sessionState)
  result <taskId> <done|failed> <text>   report a result
  comment <taskId> <text...>             comment on a ticket
  heartbeat [green|amber|stale]          liveness
  runlog <runId> <msg...>                append a run log line
  mem tree [path]                        list the shared vault
  mem read <path>                        read a note
  mem write <path> <markdown...>         write a note (commits to the vault)`
