// Governance & approvals (MCA-PC B2). Pure helpers: agent run-gating and
// parsing of approval directives an agent can emit to request sign-off.

export const TERMINAL_STATUS = ['terminated'] as const
export const PAUSED_STATUS = ['paused'] as const

/** Whether an agent in this status may execute work. */
export function canAgentRun(status: string | null | undefined): boolean {
  return status !== 'paused' && status !== 'terminated'
}

export interface ApprovalDirective { type: string; summary: string }

// [APPROVAL: <type> | <summary>] — agents emit this to request human sign-off
// for a sensitive/irreversible action (spend, external action, hire, etc.).
const APPROVAL_RE = /\[APPROVAL:\s*([^|\]]+?)\s*\|\s*([^\]]+?)\s*\]/gi

export function parseApprovalDirectives(output: string): ApprovalDirective[] {
  const out: ApprovalDirective[] = []
  let m: RegExpExecArray | null
  APPROVAL_RE.lastIndex = 0
  while ((m = APPROVAL_RE.exec(output ?? '')) !== null) {
    out.push({ type: m[1].trim().toLowerCase().replace(/\s+/g, '_'), summary: m[2].trim() })
  }
  return out
}

export function stripApprovalDirectives(output: string): string {
  return (output ?? '').replace(APPROVAL_RE, '').replace(/\n{3,}/g, '\n\n').trim()
}

export const APPROVAL_STATUS = ['pending', 'approved', 'rejected'] as const
export type ApprovalStatus = (typeof APPROVAL_STATUS)[number]
