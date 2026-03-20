import { FastifyInstance } from 'fastify'
import { getMemory, setMemoryEntry, deleteMemoryEntry, clearMemory, bulkSetMemory } from '../services/memory'

export async function memoryRoutes(app: FastifyInstance) {
  app.get('/api/agents/:agentId/memory', async (req) => {
    const { agentId } = req.params as any
    const memory = await getMemory(agentId)
    return { memory, count: Object.keys(memory).length }
  })
  app.post('/api/agents/:agentId/memory', async (req, reply) => {
    const { agentId } = req.params as any
    const { key, value } = req.body as any
    if (!key || !value) return reply.code(400).send({ error: 'key and value required' })
    await setMemoryEntry(agentId, key, value)
    return { ok: true, key }
  })
  app.put('/api/agents/:agentId/memory', async (req) => {
    const { agentId } = req.params as any
    const { entries } = req.body as any
    await bulkSetMemory(agentId, entries)
    return { ok: true, count: Object.keys(entries).length }
  })
  app.delete('/api/agents/:agentId/memory/:key', async (req, reply) => {
    const { agentId, key } = req.params as any
    await deleteMemoryEntry(agentId, key)
    reply.code(204)
  })
  app.delete('/api/agents/:agentId/memory', async (req, reply) => {
    const { agentId } = req.params as any
    await clearMemory(agentId)
    reply.code(204)
  })
}
