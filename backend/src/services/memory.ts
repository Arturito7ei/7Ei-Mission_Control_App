import { db, schema } from '../db/client'
import { eq } from 'drizzle-orm'
import Anthropic from '@anthropic-ai/sdk'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export interface MemoryEntry {
  key: string; value: string; createdAt: string; updatedAt: string
}

export async function getMemory(agentId: string): Promise<Record<string, MemoryEntry>> {
  const agent = await db.query.agents.findFirst({ where: eq(schema.agents.id, agentId) })
  if (!agent || !agent.memoryLongTerm) return {}
  return agent.memoryLongTerm as Record<string, MemoryEntry>
}

export async function setMemoryEntry(agentId: string, key: string, value: string): Promise<void> {
  const current = await getMemory(agentId)
  const now = new Date().toISOString()
  current[key] = { key, value, createdAt: current[key]?.createdAt ?? now, updatedAt: now }
  await db.update(schema.agents).set({ memoryLongTerm: current as any }).where(eq(schema.agents.id, agentId))
}

export async function deleteMemoryEntry(agentId: string, key: string): Promise<void> {
  const current = await getMemory(agentId)
  delete current[key]
  await db.update(schema.agents).set({ memoryLongTerm: current as any }).where(eq(schema.agents.id, agentId))
}

export async function clearMemory(agentId: string): Promise<void> {
  await db.update(schema.agents).set({ memoryLongTerm: {} as any }).where(eq(schema.agents.id, agentId))
}

export async function bulkSetMemory(agentId: string, entries: Record<string, string>): Promise<void> {
  const current = await getMemory(agentId)
  const now = new Date().toISOString()
  for (const [key, value] of Object.entries(entries)) {
    current[key] = { key, value, createdAt: current[key]?.createdAt ?? now, updatedAt: now }
  }
  await db.update(schema.agents).set({ memoryLongTerm: current as any }).where(eq(schema.agents.id, agentId))
}

export function formatMemoryForPrompt(memory: Record<string, MemoryEntry>): string {
  const entries = Object.values(memory)
  if (entries.length === 0) return ''
  const lines = entries.map(e => `- ${e.key}: ${e.value}`)
  return `\nLong-term memory (things I remember about this user and context):\n${lines.join('\n')}\n`
}

export function extractMemoryInstructions(output: string): { toSave: Record<string, string>; cleanedOutput: string } {
  const toSave: Record<string, string> = {}
  const pattern = /\[REMEMBER:\s*([^=\]]+?)\s*=\s*([^\]]+?)\]/gi
  let match
  while ((match = pattern.exec(output)) !== null) {
    const key = match[1].trim(); const value = match[2].trim()
    if (key && value) toSave[key] = value
  }
  const cleanedOutput = output.replace(pattern, '').replace(/\n{3,}/g, '\n\n').trim()
  return { toSave, cleanedOutput }
}

// ─ Memory compression — summarises when > COMPRESS_THRESHOLD entries ────────────
const COMPRESS_THRESHOLD = 50

export async function compressMemoryIfNeeded(agentId: string): Promise<void> {
  const memory = await getMemory(agentId)
  const entries = Object.values(memory)
  if (entries.length < COMPRESS_THRESHOLD) return

  const memoryText = entries.map(e => `${e.key}: ${e.value}`).join('\n')

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `The following is a list of memory entries for an AI agent. Compress them into at most 30 concise key-value pairs, merging related entries and keeping only the most important facts. Return ONLY a JSON object like {"key": "value"}. No explanation.\n\n${memoryText}`,
      }],
    })

    const raw = response.content[0].type === 'text' ? response.content[0].text : '{}'
    const cleaned = raw.replace(/```json|```/g, '').trim()
    const compressed: Record<string, string> = JSON.parse(cleaned)

    // Rebuild with compressed entries, preserving timestamps
    const now = new Date().toISOString()
    const newMemory: Record<string, MemoryEntry> = {}
    for (const [key, value] of Object.entries(compressed)) {
      newMemory[key] = { key, value, createdAt: memory[key]?.createdAt ?? now, updatedAt: now }
    }
    await db.update(schema.agents).set({ memoryLongTerm: newMemory as any }).where(eq(schema.agents.id, agentId))
    console.log(`Memory compressed: ${entries.length} → ${Object.keys(newMemory).length} entries for agent ${agentId}`)
  } catch (err) {
    console.warn('Memory compression failed (non-critical):', err)
  }
}
