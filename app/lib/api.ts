const BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3001'

let _getToken: (() => Promise<string | null>) | null = null
export function setTokenGetter(fn: () => Promise<string | null>) { _getToken = fn }

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const token = await _getToken?.()
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options?.headers ?? {}),
    },
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error((err as any).error ?? 'Request failed')
  }
  return res.json()
}

export interface Org { id: string; name: string; description?: string; logoUrl?: string; ownerId: string; createdAt: string; agentCount?: number; activeAgents?: number; taskCount?: number; pendingTasks?: number }
export interface Department { id: string; orgId: string; name: string; createdAt: string }
export interface Agent { id: string; orgId: string; departmentId?: string; name: string; role: string; personality?: string; cv?: string; termsOfReference?: string; llmModel: string; skills: string[]; status: string; avatarEmoji: string; agentType: string; advisorPersona?: string; createdAt: string }
export interface Message { id: string; agentId: string; taskId?: string; role: string; content: string; createdAt: string; agentName?: string; agentEmoji?: string }
export interface Task { id: string; agentId: string; orgId: string; projectId?: string; title: string; input?: string; output?: string; status: string; priority: string; kanbanColumn: string; tokensUsed?: number; costUsd?: number; durationMs?: number; llmModel?: string; createdAt: string }
export interface Project { id: string; orgId: string; name: string; description?: string; createdAt: string }
export interface Skill { id: string; name: string; description?: string; domain: string; content: string; source: string; createdAt: string }
export interface KnowledgeItem { id: string; name: string; type: string; mimeType?: string; externalUrl?: string; backend: string }
export interface CostData { agentId?: string; agentName?: string; avatarEmoji?: string; totalCost: number; totalTokens: number; taskCount?: number; date?: string }
export interface Notification { id: string; type: string; title: string; body: string; agentEmoji: string; agentName: string; cost?: number; timestamp: string }
export interface GmailThread { id: string; messages: GmailMessage[] }
export interface GmailMessage { id: string; threadId: string; from: string; to: string; subject: string; date: string; snippet: string; body: string }
export interface JiraIssue { id: string; key: string; summary: string; status?: string; priority?: string; issueType?: string; assignee?: string; created: string; updated: string; url?: string }
export interface MemoryEntry { key: string; value: string; createdAt: string; updatedAt: string }
export interface UsageStats { requestsThisMinute: number; tokensToday: number; costToday: number; concurrentTasks: number; limits: Record<string, number> }

export const api = {
  orgs: {
    list: () => request<{ orgs: Org[] }>('/api/orgs'),
    listForSwitch: () => request<{ orgs: Org[] }>('/api/orgs/switch/list'),
    create: (d: { name: string; description?: string }) => request<{ org: Org }>('/api/orgs', { method: 'POST', body: JSON.stringify(d) }),
    get: (id: string) => request<{ org: Org }>(`/api/orgs/${id}`),
    update: (id: string, d: Partial<Org>) => request(`/api/orgs/${id}`, { method: 'PATCH', body: JSON.stringify(d) }),
    delete: (id: string) => request(`/api/orgs/${id}`, { method: 'DELETE' }),
    duplicate: (id: string, name?: string) => request<{ orgId: string; name: string; agentsCopied: number }>(`/api/orgs/${id}/duplicate`, { method: 'POST', body: JSON.stringify({ name }) }),
    departments: {
      list: (orgId: string) => request<{ departments: Department[] }>(`/api/orgs/${orgId}/departments`),
      create: (orgId: string, name: string) => request<{ department: Department }>(`/api/orgs/${orgId}/departments`, { method: 'POST', body: JSON.stringify({ name }) }),
      delete: (orgId: string, deptId: string) => request(`/api/orgs/${orgId}/departments/${deptId}`, { method: 'DELETE' }),
    },
  },
  agents: {
    list: (orgId: string) => request<{ agents: Agent[] }>(`/api/orgs/${orgId}/agents`),
    get: (id: string) => request<{ agent: Agent }>(`/api/agents/${id}`),
    create: (orgId: string, d: Partial<Agent>) => request<{ agent: Agent }>(`/api/orgs/${orgId}/agents`, { method: 'POST', body: JSON.stringify(d) }),
    update: (id: string, d: Partial<Agent>) => request<{ agent: Agent }>(`/api/agents/${id}`, { method: 'PATCH', body: JSON.stringify(d) }),
    setStatus: (id: string, status: string) => request(`/api/agents/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }),
    delete: (id: string) => request(`/api/agents/${id}`, { method: 'DELETE' }),
    templates: () => request<{ templates: Record<string, any> }>('/api/agent-templates'),
    messages: (id: string) => request<{ messages: Message[] }>(`/api/agents/${id}/messages`),
    assignSkill: (agentId: string, skillId: string) => request(`/api/agents/${agentId}/skills`, { method: 'POST', body: JSON.stringify({ skillId }) }),
    chat: (id: string, input: string, history?: Array<{ role: string; content: string }>) =>
      request<{ output: string; taskId: string; tokensUsed: number; costUsd: number; memorySaved?: Record<string, string> }>(`/api/agents/${id}/chat`, { method: 'POST', body: JSON.stringify({ input, history }) }),
    transfer: (agentId: string, targetOrgId: string) => request(`/api/agents/${agentId}/transfer`, { method: 'POST', body: JSON.stringify({ targetOrgId }) }),
    clone: (agentId: string, targetOrgId: string) => request<{ agent: Agent }>(`/api/agents/${agentId}/clone`, { method: 'POST', body: JSON.stringify({ targetOrgId }) }),
    memory: {
      get: (agentId: string) => request<{ memory: Record<string, MemoryEntry>; count: number }>(`/api/agents/${agentId}/memory`),
      set: (agentId: string, key: string, value: string) => request(`/api/agents/${agentId}/memory`, { method: 'POST', body: JSON.stringify({ key, value }) }),
      delete: (agentId: string, key: string) => request(`/api/agents/${agentId}/memory/${encodeURIComponent(key)}`, { method: 'DELETE' }),
      clear: (agentId: string) => request(`/api/agents/${agentId}/memory`, { method: 'DELETE' }),
    },
  },
  tasks: {
    list: (orgId: string, filters?: { agentId?: string; status?: string; projectId?: string }) => {
      const p = new URLSearchParams(Object.fromEntries(Object.entries(filters ?? {}).filter(([, v]) => v)))
      return request<{ tasks: Task[] }>(`/api/orgs/${orgId}/tasks?${p}`)
    },
    create: (orgId: string, d: any) => request<{ task: Task }>(`/api/orgs/${orgId}/tasks`, { method: 'POST', body: JSON.stringify(d) }),
    update: (id: string, d: Partial<Task>) => request(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(d) }),
    move: (id: string, column: string) => request(`/api/tasks/${id}/move`, { method: 'PATCH', body: JSON.stringify({ column }) }),
    delete: (id: string) => request(`/api/tasks/${id}`, { method: 'DELETE' }),
  },
  projects: {
    list: (orgId: string) => request<{ projects: Project[] }>(`/api/orgs/${orgId}/projects`),
    create: (orgId: string, d: { name: string; description?: string }) => request<{ project: Project }>(`/api/orgs/${orgId}/projects`, { method: 'POST', body: JSON.stringify(d) }),
    board: (id: string) => request<{ board: Record<string, Task[]> }>(`/api/projects/${id}/board`),
    update: (id: string, d: any) => request(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(d) }),
    delete: (id: string) => request(`/api/projects/${id}`, { method: 'DELETE' }),
  },
  costs: {
    get: (orgId: string, groupBy: string, period = '30d') => request<{ costs: CostData[]; totals: any }>(`/api/orgs/${orgId}/costs?groupBy=${groupBy}&period=${period}`),
  },
  skills: {
    list: () => request<{ skills: Skill[] }>('/api/skills'),
    create: (d: any) => request<{ skill: Skill }>('/api/skills', { method: 'POST', body: JSON.stringify(d) }),
    update: (id: string, d: Partial<Skill>) => request(`/api/skills/${id}`, { method: 'PATCH', body: JSON.stringify(d) }),
    sync: () => request<{ synced: number }>('/api/skills/sync', { method: 'POST' }),
    delete: (id: string) => request(`/api/skills/${id}`, { method: 'DELETE' }),
  },
  knowledge: {
    list: (orgId: string) => request<{ items: KnowledgeItem[] }>(`/api/orgs/${orgId}/knowledge`),
    browse: (orgId: string, folderId: string, token: string) => request<{ files: any[] }>(`/api/orgs/${orgId}/knowledge/browse?folderId=${folderId}&accessToken=${token}`),
    save: (orgId: string, d: any) => request(`/api/orgs/${orgId}/knowledge`, { method: 'POST', body: JSON.stringify(d) }),
    delete: (itemId: string) => request(`/api/knowledge/${itemId}`, { method: 'DELETE' }),
  },
  comms: {
    inbox: (orgId: string, limit = 50) => request<{ messages: Message[] }>(`/api/orgs/${orgId}/inbox?limit=${limit}`),
    sendInternal: (orgId: string, agentId: string, body: string) => request(`/api/orgs/${orgId}/inbox/send`, { method: 'POST', body: JSON.stringify({ channel: 'internal', agentId, to: 'self', body }) }),
    gmail: {
      threads: (orgId: string, accessToken: string) => request<{ threads: any[] }>(`/api/orgs/${orgId}/gmail/threads?accessToken=${accessToken}`),
      thread: (orgId: string, threadId: string, accessToken: string) => request<{ thread: GmailThread }>(`/api/orgs/${orgId}/gmail/threads/${threadId}?accessToken=${accessToken}`),
      send: (orgId: string, d: { accessToken: string; to: string; subject: string; body: string; threadId?: string }) => request(`/api/orgs/${orgId}/gmail/send`, { method: 'POST', body: JSON.stringify(d) }),
    },
    telegram: {
      register: (orgId: string, botToken: string) => request(`/api/orgs/${orgId}/telegram/register`, { method: 'POST', body: JSON.stringify({ botToken }) }),
      send: (orgId: string, d: { botToken: string; chatId: string; text: string }) => request(`/api/orgs/${orgId}/telegram/send`, { method: 'POST', body: JSON.stringify(d) }),
    },
    meet: {
      create: (orgId: string, d: { accessToken: string; summary?: string; attendees?: string[] }) => request<{ meetLink: string; htmlLink: string }>(`/api/orgs/${orgId}/meet/create`, { method: 'POST', body: JSON.stringify(d) }),
    },
  },
  notifications: {
    register: (userId: string, token: string) => request('/api/notifications/register', { method: 'POST', body: JSON.stringify({ userId, token }) }),
    list: (orgId: string) => request<{ notifications: Notification[] }>(`/api/orgs/${orgId}/notifications`),
  },
  jira: {
    connect: (orgId: string, d: { domain: string; email: string; apiToken: string; defaultProjectKey?: string }) =>
      request<{ ok: boolean; jiraUser: string }>(`/api/orgs/${orgId}/jira/connect`, { method: 'POST', body: JSON.stringify(d) }),
    status: (orgId: string) => request<{ connected: boolean; domain?: string; defaultProjectKey?: string }>(`/api/orgs/${orgId}/jira/status`),
    disconnect: (orgId: string) => request(`/api/orgs/${orgId}/jira/connect`, { method: 'DELETE' }),
    issues: (orgId: string, filters?: { projectKey?: string; status?: string; maxResults?: number }) => {
      const p = new URLSearchParams(Object.fromEntries(Object.entries(filters ?? {}).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])))
      return request<{ issues: JiraIssue[]; total: number }>(`/api/orgs/${orgId}/jira/issues?${p}`)
    },
    createIssue: (orgId: string, d: { summary: string; description?: string; issueType?: string; priority?: string; agentId?: string }) =>
      request<{ issue: { id: string; key: string; url: string } }>(`/api/orgs/${orgId}/jira/issues`, { method: 'POST', body: JSON.stringify(d) }),
    addComment: (orgId: string, key: string, body: string) => request(`/api/orgs/${orgId}/jira/issues/${key}/comments`, { method: 'POST', body: JSON.stringify({ body }) }),
    transitions: (orgId: string, key: string) => request<{ transitions: any[] }>(`/api/orgs/${orgId}/jira/issues/${key}/transitions`),
    transition: (orgId: string, key: string, transitionId: string) => request(`/api/orgs/${orgId}/jira/issues/${key}/transitions`, { method: 'POST', body: JSON.stringify({ transitionId }) }),
    sync: (orgId: string, agentId: string, projectKey?: string) => request<{ synced: number }>(`/api/orgs/${orgId}/jira/sync`, { method: 'POST', body: JSON.stringify({ agentId, projectKey }) }),
    fromTask: (orgId: string, taskId: string) => request<{ issue: { key: string; url: string } }>(`/api/orgs/${orgId}/jira/from-task/${taskId}`, { method: 'POST' }),
  },
  usage: {
    get: (orgId: string) => request<{ usage: UsageStats }>(`/api/orgs/${orgId}/usage`),
  },
}

export function createAgentStream(agentId: string): WebSocket {
  const wsUrl = BASE_URL.replace(/^http/, 'ws')
  return new WebSocket(`${wsUrl}/api/agents/${agentId}/stream`)
}
