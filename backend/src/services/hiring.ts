// Goal-driven hiring (MCA-PC A2). Pure helpers: build the proposal prompt from
// org context + the existing org chart, and parse/normalise the LLM's JSON.

export const HIRE_RUNTIMES = ['internal', 'openclaw', 'cursor', 'claude_code', 'custom'] as const
export type HireRuntime = (typeof HIRE_RUNTIMES)[number]

export interface HireProposal {
  name: string
  title: string
  role: string
  jobDescription: string
  avatarEmoji: string
  llmProvider: string
  llmModel: string
  skills: string[]
  runtime: HireRuntime
  reportsTo: string | null   // existing agent id, or null
  termsOfReference: string
}

export interface ExistingAgent { id: string; name: string; role: string; title?: string | null }

/** System + user prompt that asks the model to design one agent for the org. */
export function buildHirePrompt(
  prompt: string,
  org: { mission?: string | null; culture?: string | null } | null,
  agents: ExistingAgent[],
): { system: string; user: string } {
  const roster = agents.length
    ? agents.map(a => `- id=${a.id} · ${a.name} · ${a.title || a.role}`).join('\n')
    : '(no agents yet — this may be the first hire)'
  const system = [
    'You are 7Ei’s head of org design. Design ONE agent for the company from the request.',
    'Pick a fitting title, a concise role, a one-paragraph job description, an emoji, and 2–5 skills.',
    'Choose a runtime: "internal" (the app runs it via its LLM) unless the request clearly implies a',
    'self-hosted coding/ops agent — then use "openclaw" | "cursor" | "claude_code" | "custom".',
    'Choose a sensible manager from the existing roster and return their EXACT id in reportsTo, or null',
    'if it should report to no one. Return ONLY a JSON object, no markdown, with keys:',
    '{ "name", "title", "role", "jobDescription", "avatarEmoji", "llmProvider", "llmModel",',
    '  "skills": string[], "runtime", "reportsTo": string|null, "termsOfReference" }',
  ].join('\n')
  const user = [
    org?.mission ? `Org mission: ${org.mission}` : '',
    org?.culture ? `Org culture: ${org.culture}` : '',
    `Existing org chart:\n${roster}`,
    '',
    `Request: ${prompt}`,
  ].filter(Boolean).join('\n')
  return { system, user }
}

const DEFAULTS = { provider: 'anthropic', model: 'claude-sonnet-4-20250514' }

/** Parse the model output into a normalised proposal with safe defaults. */
export function parseHireProposal(raw: string): HireProposal {
  let obj: any = {}
  try { obj = JSON.parse(String(raw).replace(/```json|```/g, '').trim()) } catch { obj = {} }
  const runtime: HireRuntime = HIRE_RUNTIMES.includes(obj.runtime) ? obj.runtime : 'internal'
  const skills = Array.isArray(obj.skills) ? obj.skills.filter((s: any) => typeof s === 'string').slice(0, 8) : []
  const name = (obj.name && String(obj.name).trim()) || 'New Agent'
  return {
    name,
    title: (obj.title && String(obj.title).trim()) || (obj.role && String(obj.role).trim()) || 'Team Member',
    role: (obj.role && String(obj.role).trim()) || obj.title || 'Team Member',
    jobDescription: typeof obj.jobDescription === 'string' ? obj.jobDescription : '',
    avatarEmoji: (typeof obj.avatarEmoji === 'string' && obj.avatarEmoji.trim()) || '🤖',
    llmProvider: (typeof obj.llmProvider === 'string' && obj.llmProvider.trim()) || (runtime === 'openclaw' ? 'minimax' : DEFAULTS.provider),
    llmModel: (typeof obj.llmModel === 'string' && obj.llmModel.trim()) || (runtime === 'openclaw' ? 'MiniMax-Text-01' : DEFAULTS.model),
    skills,
    runtime,
    reportsTo: typeof obj.reportsTo === 'string' && obj.reportsTo.trim() ? obj.reportsTo.trim() : null,
    termsOfReference: typeof obj.termsOfReference === 'string' ? obj.termsOfReference : '',
  }
}

export const isExternalRuntime = (r: string | null | undefined) => !!r && r !== 'internal'
