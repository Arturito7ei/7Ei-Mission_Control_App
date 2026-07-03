'use client'
import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { tk, ui, text, space } from './tokens'
import { Button } from './ui'

// Memory tab — browses the shared Obsidian vault (the 7Ei-MC_TARCO repo) through
// the backend vault connector. Left: folder tree. Right: rendered markdown.
// MCA-79: shared api() client + tokens + density scale.

type Getter = () => Promise<string | null>

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
    try { const r = await api<{ entries: Entry[] }>(`/api/orgs/${orgId}/memory/tree?path=${encodeURIComponent(p)}`, { token: await getToken() }); setEntries(r.entries); setPath(p) }
    catch (e: any) { setErr(e?.message ?? 'Failed') }
    setLoading(false)
  }, [orgId, getToken])

  const openFile = async (p: string) => {
    setLoading(true); setErr(null)
    try { const r = await api<{ markdown: string }>(`/api/orgs/${orgId}/memory/file?path=${encodeURIComponent(p)}`, { token: await getToken() }); setFile({ path: p, html: mdToHtml(r.markdown) }) }
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
        <Button style={{ color: tk.accent }} onClick={() => { setFile(null); loadDir(path) }}>↻ Refresh</Button>
      </div>
      {err && <div style={s.err}>⚠ {err}{/vault token/i.test(err) && <div style={{ marginTop: 6, color: tk.muted }}>Add a company secret <code style={s.code}>GITHUB_VAULT_TOKEN</code> in the Cockpit → Secrets panel (a GitHub PAT with read access to the vault repo).</div>}</div>}

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
          {!entries.length && !loading && <div style={{ color: tk.mutedSoft, fontSize: text.sm.fontSize, padding: space.sm }}>empty</div>}
        </div>
        <div style={s.viewer}>
          {loading && <div style={{ color: tk.mutedSoft, fontSize: text.sm.fontSize }}>Loading…</div>}
          {!file && !loading && <div style={{ color: tk.muted, fontSize: text.md.fontSize }}>Pick a note on the left to read it. Protocols, memory, agent registry, and company docs all live in the shared vault.</div>}
          {file && <div style={s.md} dangerouslySetInnerHTML={{ __html: file.html }} />}
        </div>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  page: { ...ui.page, maxWidth: 1200, gap: space.lg },
  h1: ui.h1,
  pill: ui.sub,
  err: ui.err,
  code: { background: '#000', border: `1px solid ${tk.line}`, borderRadius: 4, padding: '1px 5px', fontSize: text.xs.fontSize, color: tk.accent },
  split: { display: 'grid', gridTemplateColumns: '280px 1fr', gap: space.lg, alignItems: 'start' },
  tree: { background: tk.surface, border: `1px solid ${tk.line}`, borderRadius: tk.r.lg, padding: space.md, maxHeight: '70vh', overflow: 'auto' },
  crumbs: { fontSize: text.xs.fontSize, color: tk.muted, padding: '4px 6px 8px', borderBottom: `1px solid ${tk.lineSoft}`, marginBottom: space.sm, wordBreak: 'break-all' },
  crumb: { color: tk.blue, cursor: 'pointer' },
  row: { fontSize: text.md.fontSize, lineHeight: text.md.lineHeight, padding: `${space.xs}px ${space.md}px`, borderRadius: 7, cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  rowSel: { background: '#211c08', color: tk.accent },
  viewer: { background: tk.surfaceHigh, border: `1px solid ${tk.line}`, borderRadius: tk.r.lg, padding: `${space.lg}px ${space.xl}px`, minHeight: '40vh', maxHeight: '70vh', overflow: 'auto' },
  md: { fontSize: text.lg.fontSize, lineHeight: 1.6, color: '#d6d6de' },
}
