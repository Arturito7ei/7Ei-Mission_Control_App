import { FastifyInstance } from 'fastify'
import { MODEL_CATALOGUE } from '../services/llm-router'

export async function modelRoutes(app: FastifyInstance) {
  // List all available models grouped by provider
  app.get('/api/models', async () => ({ models: MODEL_CATALOGUE }))

  // List models for a specific provider
  app.get('/api/models/:provider', async (req, reply) => {
    const { provider } = req.params as any
    const models = MODEL_CATALOGUE[provider as keyof typeof MODEL_CATALOGUE]
    if (!models) return reply.code(404).send({ error: 'Provider not found' })
    return { provider, models }
  })
}
