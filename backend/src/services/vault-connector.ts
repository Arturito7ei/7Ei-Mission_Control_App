// Obsidian vault connector (Memory tab). The deployed backend can't reach a
// local Obsidian vault, so it reads the shared vault's markdown from its private
// GitHub repo via the Contents API, using a stored GitHub token. Pure helpers
// here; the route wires the token + fetch.

export const VAULT_REPO = process.env.VAULT_REPO ?? 'Arturito7ei/7Ei-MC_TARCO'
export const VAULT_ROOT = process.env.VAULT_ROOT ?? 'vault'

/** Guard against path traversal; only allow the vault root subtree. */
export function isSafeVaultPath(path: string): boolean {
  const p = String(path ?? '').replace(/^\/+/, '')
  if (p.includes('..') || p.includes('\\')) return false
  return p === VAULT_ROOT || p.startsWith(VAULT_ROOT + '/') || p === '' 
}

/** GitHub Contents API URL for a path in the vault repo. */
export function ghContentsUrl(path: string, repo = VAULT_REPO): string {
  const clean = String(path ?? '').replace(/^\/+/, '')
  return `https://api.github.com/repos/${repo}/contents/${encodeURI(clean)}`
}

export interface VaultEntry { name: string; path: string; type: 'dir' | 'file' }

/** Normalise a Contents API directory listing → sorted entries (dirs first, md/dirs only). */
export function parseDirEntries(arr: any[]): VaultEntry[] {
  const entries: VaultEntry[] = (Array.isArray(arr) ? arr : [])
    .filter(e => e && (e.type === 'dir' || (e.type === 'file' && /\.(md|markdown|txt)$/i.test(e.name))))
    .map(e => ({ name: e.name, path: e.path, type: e.type === 'dir' ? 'dir' : 'file' }))
  return entries.sort((a, b) =>
    a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name))
}

/** Decode a Contents API file object → UTF-8 text. */
export function decodeFileContent(obj: any): string {
  if (!obj || typeof obj.content !== 'string') return ''
  return Buffer.from(obj.content, (obj.encoding as BufferEncoding) || 'base64').toString('utf8')
}
