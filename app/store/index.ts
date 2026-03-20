import { create } from 'zustand'
import type { Org, Agent, Task, Project, Skill, Message, Department } from '../lib/api'

interface AppState {
  currentOrg: Org | null
  orgs: Org[]
  departments: Department[]
  setCurrentOrg: (org: Org | null) => void
  setOrgs: (orgs: Org[]) => void
  setDepartments: (d: Department[]) => void
  agents: Agent[]
  setAgents: (agents: Agent[]) => void
  updateAgent: (id: string, data: Partial<Agent>) => void
  removeAgent: (id: string) => void
  tasks: Task[]
  setTasks: (tasks: Task[]) => void
  addTask: (task: Task) => void
  updateTask: (id: string, data: Partial<Task>) => void
  projects: Project[]
  setProjects: (projects: Project[]) => void
  skills: Skill[]
  setSkills: (skills: Skill[]) => void
  messages: Record<string, Message[]>
  setMessages: (agentId: string, msgs: Message[]) => void
  addMessage: (agentId: string, msg: Message) => void
  appendToLastMessage: (agentId: string, chunk: string) => void
  isLoading: boolean
  setLoading: (v: boolean) => void
}

export const useStore = create<AppState>((set) => ({
  currentOrg: null,
  orgs: [],
  departments: [],
  setCurrentOrg: (org) => set({ currentOrg: org }),
  setOrgs: (orgs) => set({ orgs }),
  setDepartments: (departments) => set({ departments }),

  agents: [],
  setAgents: (agents) => set({ agents }),
  updateAgent: (id, data) => set((s) => ({ agents: s.agents.map((a) => a.id === id ? { ...a, ...data } : a) })),
  removeAgent: (id) => set((s) => ({ agents: s.agents.filter((a) => a.id !== id) })),

  tasks: [],
  setTasks: (tasks) => set({ tasks }),
  addTask: (task) => set((s) => ({ tasks: [task, ...s.tasks] })),
  updateTask: (id, data) => set((s) => ({ tasks: s.tasks.map((t) => t.id === id ? { ...t, ...data } : t) })),

  projects: [],
  setProjects: (projects) => set({ projects }),

  skills: [],
  setSkills: (skills) => set({ skills }),

  messages: {},
  setMessages: (agentId, msgs) => set((s) => ({ messages: { ...s.messages, [agentId]: msgs } })),
  addMessage: (agentId, msg) => set((s) => ({ messages: { ...s.messages, [agentId]: [...(s.messages[agentId] ?? []), msg] } })),
  appendToLastMessage: (agentId, chunk) =>
    set((s) => {
      const msgs = [...(s.messages[agentId] ?? [])]
      if (msgs.length > 0 && msgs[msgs.length - 1].role === 'assistant') {
        msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], content: msgs[msgs.length - 1].content + chunk }
      }
      return { messages: { ...s.messages, [agentId]: msgs } }
    }),

  isLoading: false,
  setLoading: (v) => set({ isLoading: v }),
}))
