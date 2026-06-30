// Scoped secret store (MCA-PC D4). AES-256-GCM at rest; scoped to company or
// agent; injected into runs via the agent API — never into LLM prompts.
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto'

const KEY = createHash('sha256').update(process.env.SECRETS_ENC_KEY ?? 'dev-7ei-mc-secrets-key').digest() // 32 bytes

/** Encrypt → "iv.tag.ciphertext" (all base64). */
export function encrypt(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', KEY, iv)
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join('.')
}

/** Decrypt an "iv.tag.ciphertext" blob. */
export function decrypt(blob: string): string {
  const [ivb, tagb, encb] = String(blob).split('.')
  const decipher = createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivb, 'base64'))
  decipher.setAuthTag(Buffer.from(tagb, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(encb, 'base64')), decipher.final()]).toString('utf8')
}

/** Mask a value for display — last 4 chars only. */
export function maskValue(v: string): string {
  const s = String(v ?? '')
  return s.length <= 4 ? '••••' : '••••' + s.slice(-4)
}

export interface ScopedSecret { scope: string; scopeId?: string | null; key: string; value: string }

/** Resolve the effective secrets for an agent: company scope first, then agent
 *  scope overrides. Pure (takes already-decrypted values). */
export function resolveSecretsForAgent(secrets: ScopedSecret[], agentId: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const s of secrets) if (s.scope === 'company') out[s.key] = s.value
  for (const s of secrets) if (s.scope === 'agent' && s.scopeId === agentId) out[s.key] = s.value
  return out
}
