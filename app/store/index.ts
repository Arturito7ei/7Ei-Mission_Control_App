import { create } from 'zustand'
import { Agent, Message, Task, Project, Org, Department, Skill } from '../lib/api'

// ─── OnboardingConfig ─────────────────────────────────────────────────────────
// Collected during the Arturito onboarding wizard.
// Persisted in store so org/create.tsx and other screens can pre-fill from it.

export type OnboardingConfig = {
  orgName: string
  orgDescription: string
  /** Shared knowledge base injected into every agent (mission, vision) */
  mission: string
  /** Shared knowledge base injected into every agent (culture, values) */
  culture: string
  /** Where agents are hosted */
  deployMode: 'cloud' | 'local' | null
  /** Cloud provider — only set when deployMode === 'cloud' */
  cloudProvider: 'aws' | 'gcp' | 'azure' | 'oracle' | null
  /** Preferred LLM — only set when deployMode === 'cloud' */
  preferredLlm: 'claude' | 'gpt4o' | 'gemini' | null
  /** First specialist agent to create after org setup */
  firstAgentRole: 'marketing' | 'engineering' | 'finance' | 'operations' | null
}

// ─── App state ────────────────────────────────────────────────────────────────

interface AppState {
  // Onboarding
  onboardingConfig: OnboardingConfig | null
  setOnboardingConfig: (config: OnboardingConfig) => void

  // Orgs
  orgs: Org[]
  currentOrg: Org | null
  setOrgs: (orgs: Org[]) => void
  setCurrentOrg: (org: Org | null) => void

  // Departments
  departments: Department[]
  setDepartments: (d: Department[]) => void

  // Agents
  agents: Agent[]
  setAgents: (agents: Agent[]) => void
  updateAgent: (id: string, patch: Partial<Agent>) => void

  // Messages (keyed by agentId)
  messages: Record<string, Message[]>
  setMessages: (agentId: string, msgs: Message[]) => void
  addMessage: (agentId: string, msg: Message) => void
  appendToLastMessage: (agentId: string, token: string) => void

  // Tasks
  tasks: Task[]
  setTasks: (tasks: Task[]) => void
  updateTask: (id: string, patch: Partial<Task>) => void
  addTask: (task: Task) => void

  // Projects
  projects: Project[]
  setProjects: (projects: Project[]) => void

  // Skills
  skills: Skill[]
  setSkills: (skills: Skill[]) => void

  // UI state
  isLoading: boolean
  setIsLoading: (loading: boolean) => void
  error: string | null
  setError: (error: string | null) => void
}

export const useStore = create<AppState>((set) => ({
  // Onboarding
  onboardingConfig: null,
  setOnboardingConfig: (onboardingConfig) => set({ onboardingConfig }),

  // Orgs
  orgs: [],
  currentOrg: null,
  setOrgs: (orgs) => set({ orgs }),
  setCurrentOrg: (currentOrg) => set({ currentOrg }),

  // Departments
  departments: [],
  setDepartments: (departments) => set({ departments }),

  // Agents
  agents: [],
  setAgents: (agents) => set({ agents }),
  updateAgent: (id, patch) =>
    set((state) => ({
      agents: state.agents.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    })),

  // Messages
  messages: {},
  setMessages: (agentId, msgs) =>
    set((state) => ({ messages: { ...state.messages, [agentId]: msgs } })),
  addMessage: (agentId, msg) =>
    set((state) => ({
      messages: {
        ...state.messages,
        [agentId]: [...(state.messages[agentId] ?? []), msg],
      },
    })),
  appendToLastMessage: (agentId, token) =>
    set((state) => {
      const msgs = [...(state.messages[agentId] ?? [])]
      if (msgs.length === 0) return {}
      const last = msgs[msgs.length - 1]
      msgs[msgs.length - 1] = { ...last, content: last.content + token }
      return { messages: { ...state.messages, [agentId]: msgs } }
    }),

  // Tasks
  tasks: [],
  setTasks: (tasks) => set({ tasks }),
  updateTask: (id, patch) =>
    set((state) => ({
      tasks: state.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    })),
  addTask: (task) =>
    set((state) => ({ tasks: [task, ...state.tasks] })),

  // Projects
  projects: [],
  setProjects: (projects) => set({ projects }),

  // Skills
  skills: [],
  setSkills: (skills) => set({ skills }),

  // UI
  isLoading: false,
  setIsLoading: (isLoading) => set({ isLoading }),
  error: null,
  setError: (error) => set({ error }),
}))
