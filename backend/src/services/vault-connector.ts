// Obsidian vault connector — shared agent memory. The deployed backend can't
// reach a local Obsidian vault, so it reads/writes the shared vault's markdown
// through its Git host (GitHub Contents API) using a stored token. The vault is
// per-org configurable (repo/root/branch) via the Connectors tab's Obsidian card.

export const VAULT_REPO = process.env.VAULT_REPO ?? 'Arturito7ei/7Ei-MC_TARCO'
export const VAULT_ROOT = process.env.VAULT_ROOT ?? 'vault'
export const VAULT_BRANCH = process.env.VAULT_BRANCH ?? 'main'

export interface VaultConfig { repo: string; root: string; branch: string }

export function defaultVaultConfig(): VaultConfig {
  return { repo: VAULT_REPO, root: VAULT_ROOT, branch: VAULT_BRANCH }
}

/** Merge a stored VAULT_CONFIG JSON blob with defaults. */
export function parseVaultConfig(json: string | null | undefined): VaultConfig {
  const d = defaultVaultConfig()
  if (!json) return d
  try {
    const o = JSON.parse(json)
    return { repo: o.repo || d.repo, root: (o.root ?? d.root) || d.root, branch: o.branch || d.branch }
  } catch { return d }
}

/** Guard against path traversal; only allow the configured vault-root subtree. */
export function isSafeVaultPath(path: string, root: string = VAULT_ROOT): boolean {
  const p = String(path ?? '').replace(/^\/+/, '')
  if (p.includes('..') || p.includes('\\')) return false
  const r = String(root ?? '').replace(/^\/+|\/+$/g, '')
  return p === r || p.startsWith(r + '/') || p === ''
}

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|txt)$/i.test(String(path ?? ''))
}

/** GitHub Contents API URL for a path in a repo (optionally at a ref/branch). */
export function ghContentsUrl(path: string, repo: string = VAULT_REPO, ref?: string): string {
  const clean = String(path ?? '').replace(/^\/+/, '')
  const base = `https://api.github.com/repos/${repo}/contents/${encodeURI(clean)}`
  return ref ? `${base}?ref=${encodeURIComponent(ref)}` : base
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

/** Build the PUT body for a Contents API write (create or update). */
export function ghPutBody(markdown: string, message: string, branch: string, sha?: string, committer?: { name: string; email: string }): Record<string, any> {
  const body: Record<string, any> = { message, content: Buffer.from(markdown ?? '', 'utf8').toString('base64'), branch }
  if (sha) body.sha = sha
  if (committer) body.committer = committer
  return body
}

// ─── Thin IO helpers (token = GitHub PAT with repo access) ──────────────────
const ghHeaders = (token: string) => ({ Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': '7ei-mc' })

export async function vaultList(token: string, cfg: VaultConfig, path: string): Promise<{ ok: boolean; status: number; entries?: VaultEntry[] }> {
  const res = await fetch(ghContentsUrl(path || cfg.root, cfg.repo, cfg.branch), { headers: ghHeaders(token) })
  if (!res.ok) return { ok: false, status: res.status }
  return { ok: true, status: 200, entries: parseDirEntries(await res.json() as any) }
}

export async function vaultRead(token: string, cfg: VaultConfig, path: string): Promise<{ ok: boolean; status: number; markdown?: string }> {
  const res = await fetch(ghContentsUrl(path, cfg.repo, cfg.branch), { headers: ghHeaders(token) })
  if (!res.ok) return { ok: false, status: res.status }
  return { ok: true, status: 200, markdown: decodeFileContent(await res.json() as any) }
}

/** Recursively list markdown blob paths under the vault root in ONE Git Trees
 *  API call (vs one Contents call per directory) — feeds the native graph build. */
export async function vaultTree(token: string, cfg: VaultConfig): Promise<{ ok: boolean; status: number; paths?: string[] }> {
  const res = await fetch(`https://api.github.com/repos/${cfg.repo}/git/trees/${encodeURIComponent(cfg.branch)}?recursive=1`, { headers: ghHeaders(token) })
  if (!res.ok) return { ok: false, status: res.status }
  const j = await res.json() as any
  const root = String(cfg.root ?? '').replace(/^\/+|\/+$/g, '')
  const paths = (Array.isArray(j?.tree) ? j.tree : [])
    .filter((t: any) => t?.type === 'blob' && /\.(md|markdown)$/i.test(t.path) && (!root || t.path === root || t.path.startsWith(root + '/')))
    .map((t: any) => t.path as string)
  return { ok: true, status: 200, paths }
}

export async function vaultWrite(
  token: string, cfg: VaultConfig, path: string, markdown: string, message: string,
  committer?: { name: string; email: string },
): Promise<{ ok: boolean; status: number; commit?: string; error?: string }> {
  const clean = String(path ?? '').replace(/^\/+/, '')
  // Look up existing sha (required to update an existing file).
  let sha: string | undefined
  const head = await fetch(ghContentsUrl(clean, cfg.repo, cfg.branch), { headers: ghHeaders(token) })
  if (head.ok) { try { sha = (await head.json() as any).sha } catch {} }
  const res = await fetch(`https://api.github.com/repos/${cfg.repo}/contents/${encodeURI(clean)}`, {
    method: 'PUT', headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(ghPutBody(markdown, message, cfg.branch, sha, committer)),
  })
  if (!res.ok) return { ok: false, status: res.status, error: `GitHub ${res.status}` }
  const j = await res.json().catch(() => ({})) as any
  return { ok: true, status: res.status, commit: j?.commit?.sha }
}
