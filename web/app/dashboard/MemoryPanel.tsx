'use client'
import { useCallback, useEffect, useState } from 'react'

// Memory tab — browses the shared Obsidian vault (the 7Ei-MC_TARCO repo) through
// the backend vault connector. Left: folder tree. Right: rendered markdown.

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'
type Getter = () => Promise<string | null>
async function call<T>(path: string, token: string | null): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? 'Request failed')
  return res.json()
}
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Minimal, safe markdown → HTML (escape first, then format a useful subset).
function mdToHtml(md: string): string {
  const lines = esc(md).split('\n')
  const out: string[] = []
  let inCode = false, inList = false
  const inline = (t: string) => t
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/\[\[([^\]]+)\]\]/g, '<span class="wl">$1</span>')
  for (const raw of lines) {
    if (/^```/.test(raw)) { if (inList) { out.push('</ul>'); inList = false } inCode = !inCode; out.push(inCode ? '<pre>' : '</pre>'); continue }
    if (inCode) { out.push(raw); continue }
    const h = raw.match(/^(#{1,4})\s+(.*)/)
    if (h) { if (inList) { out.push('</ul>'); inList = false } out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue }
    if (/^\s*[-*]\s+/.test(raw)) { if (!inList) { out.push('<ul>'); inList = true } out.push(`<li>${inline(raw.replace(/^\s*[-*]\s+/, ''))}</li>`); continue }
    if (inList) { out.push('</ul>'); inList = false }
    if (/^\s*---\s*$/.test(raw)) { out.push('<hr/>'); continue }
    if (raw.trim() === '') { out.push('') ; continue }
    out.push(`<p>${inline(raw)}</p>`)
  }
  if (inList) out.push('</ul>'); if (inCode) out.push('</pre>')
  return out.join('\n')
}

type Entry = { name: string; path: string; type: 'dir' | 'file' }

export default function MemoryPanel({ orgId, getToken }: { orgId: string; getToken: Getter }) {
  const [path, setPath] = useState('vault')
  const [entries, setEntries] = useState<Entry[]>([])
  const [file, setFile] = useState<{ path: string; html: string } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const loadDir = useCallback(async (p: string) => {
    setLoading(true); setErr(null)
    try { const r = await call<{ entries: Entry[] }>(`/api/orgs/${orgId}/memory/tree?path=${encodeURIComponent(p)}`, await getToken()); setEntries(r.entries); setPath(p) }
    catch (e: any) { setErr(e?.message ?? 'Failed') }
    setLoading(false)
  }, [orgId, getToken])

  const openFile = async (p: string) => {
    setLoading(true); setErr(null)
    try { const r = await call<{ markdown: string }>(`/api/orgs/${orgId}/memory/file?path=${encodeURIComponent(p)}`, await getToken()); setFile({ path: p, html: mdToHtml(r.markdown) }) }
    catch (e: any) { setErr(e?.message ?? 'Failed') }
    setLoading(false)
  }

  useEffect(() => { loadDir('vault') }, [loadDir])

  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null
  const crumbs = path.split('/')

  return (
    <div style={s.page}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h1 style={s.h1}>Memory <span style={s.pill}>Obsidian vault · 7Ei-MC_TARCO</span></h1>
        <button style={s.ghost} onClick={() => { setFile(null); loadDir(path) }}>↻ Refresh</button>
      </div>
      {err && <div style={s.err}>⚠ {err}{/vault token/i.test(err) && <div style={{ marginTop: 6, color: '#888' }}>Add a company secret <code style={s.code}>GITHUB_VAULT_TOKEN</code> in the Cockpit → Secrets panel (a GitHub PAT with read access to the vault repo).</div>}</div>}

      <div style={s.split}>
        <div style={s.tree}>
          <div style={s.crumbs}>
            {crumbs.map((c, i) => <span key={i}><a style={s.crumb} onClick={() => { setFile(null); loadDir(crumbs.slice(0, i + 1).join('/')) }}>{c}</a>{i < crumbs.length - 1 ? ' / ' : ''}</span>)}
          </div>
          {parent && <div style={s.row} onClick={() => { setFile(null); loadDir(parent) }}>↩ ..</div>}
          {entries.map(e => (
            <div key={e.path} style={{ ...s.row, ...(file?.path === e.path ? s.rowSel : {}) }}
              onClick={() => e.type === 'dir' ? (setFile(null), loadDir(e.path)) : openFile(e.path)}>
              {e.type === 'dir' ? '📁' : '📄'} {e.name}
            </div>
          ))}
          {!entries.length && !loading && <div style={{ color: '#555', fontSize: 12, padding: 6 }}>empty</div>}
        </div>
        <div style={s.viewer}>
          {loading && <div style={{ color: '#555', fontSize: 12 }}>Loading…</div>}
          {!file && !loading && <div style={{ color: '#888', fontSize: 13 }}>Pick a note on the left to read it. Protocols, memory, agent registry, and company docs all live in the shared vault.</div>}
          {file && <div style={s.md} dangerouslySetInnerHTML={{ __html: file.html }} />}
        </div>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  page: { padding: 28, maxWidth: 1200, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 },
  h1: { fontSize: 28, fontWeight: 800, margin: 0, letterSpacing: -0.5, display: 'flex', alignItems: 'center', gap: 10 },
  pill: { fontSize: 11, color: '#888', background: '#111', border: '1px solid #222', borderRadius: 999, padding: '2px 10px', fontWeight: 500 },
  ghost: { background: '#1a1a1a', border: '1px solid #333', color: '#FFB800', padding: '9px 14px', borderRadius: 9, cursor: 'pointer', fontSize: 13, fontWeight: 600 },
  err: { background: '#2a1414', border: '1px solid #5a2a2a', color: '#ff8080', borderRadius: 8, padding: '10px 12px', fontSize: 13 },
  code: { background: '#000', border: '1px solid #222', borderRadius: 4, padding: '1px 5px', fontSize: 11, color: '#FFB800' },
  split: { display: 'grid', gridTemplateColumns: '280px 1fr', gap: 14, alignItems: 'start' },
  tree: { background: '#0d0d0d', border: '1px solid #222', borderRadius: 12, padding: 10, maxHeight: '70vh', overflow: 'auto' },
  crumbs: { fontSize: 11, color: '#888', padding: '4px 6px 8px', borderBottom: '1px solid #1a1a1a', marginBottom: 6, wordBreak: 'break-all' },
  crumb: { color: '#4aa8ff', cursor: 'pointer' },
  row: { fontSize: 13, padding: '6px 8px', borderRadius: 7, cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  rowSel: { background: '#211c08', color: '#FFB800' },
  viewer: { background: '#111', border: '1px solid #222', borderRadius: 12, padding: '18px 22px', minHeight: '40vh', maxHeight: '70vh', overflow: 'auto' },
  md: { fontSize: 14, lineHeight: 1.65, color: '#d6d6de' },
}
