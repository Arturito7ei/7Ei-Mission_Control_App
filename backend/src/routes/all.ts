// Barrel — routes/all.ts was split into domain modules (refactor/split-all-routes).
// Every symbol previously defined here is re-exported so existing imports from
// './routes/all' keep resolving. Prefer importing from the domain module directly.

export { orgRoutes } from './orgs'
export { AGENT_TEMPLATES, agentRoutes } from './agents'
export { taskRoutes } from './tasks'
export { projectRoutes } from './projects'
export { costRoutes } from './costs'
export { skillRoutes } from './skills'
export { chunkText, knowledgeRoutes } from './knowledge-legacy'
export { authRoutes } from './auth-google'
export { maskKey, credentialRoutes } from './credentials'
