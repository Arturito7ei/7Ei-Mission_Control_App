'use client'
// Epic AG / AG3 — Instructions tab: the agent's managed markdown bundle.
// Left: the Files panel (AGENTS.md is the ENTRY file; byte sizes; "+" adds an
// extra .md). Right: a viewer/editor for the selected file.
//
// Markdown is rendered from the pure `lib/markdown` parser into React elements —
// file content is never injected as HTML.
import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { parseMarkdown, type Block, type Inline } from '@/lib/markdown'
import { Button, Card, Skeleton, TextArea, TextInput } from '../ui'
import { Modal, ModalTitle, FormLabel, sx } from '../cockpit/shared'
import { tk, text, space } from '../tokens'
import { ax, type Getter } from './shared'

type FileMeta = { path: string; bytes: number; managed: boolean; entry: boolean; stored: boolean; updatedAt: number | null }

const fmtBytes = (n: number) => (n < 1024 ? `${n}B` : `${(n / 1024).toFixed(1)}KB`)

export default function InstructionsTab({ orgId, agentId, getToken }: { orgId: string; agentId: string; getToken: Getter }) {
  const [files, setFiles] = useState<FileMeta[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [stored, setStored] = useState(true)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [newName, setNewName] = useState('')

  const base = `/api/orgs/${orgId}/agents/${agentId}/files`

  const loadFiles = useCallback(async () => {
    setErr(null)
    try {
      const { files: f } = await api<{ files: FileMeta[] }>(base, { token: await getToken() })
      setFiles(f)
      setSelected(cur => cur && f.some(x => x.path === cur) ? cur : (f[0]?.path ?? null))
    } catch (e: any) { setErr(e?.message ?? 'Could not load the instructions bundle.') }
  }, [base, getToken])

  useEffect(() => { loadFiles() }, [loadFiles])

  // Load the selected file's content (a managed file that was never saved comes
  // back with its generated default and stored:false).
  useEffect(() => {
    if (!selected) return
    let cancelled = false
    ;(async () => {
      try {
        const r = await api<{ content: string; stored: boolean }>(`${base}/content?path=${encodeURIComponent(selected)}`, { token: await getToken() })
        if (cancelled) return
        setContent(r.content); setStored(r.stored); setDraft(r.content); setEditing(false)
      } catch (e: any) { if (!cancelled) setErr(e?.message ?? 'Could not read that file.') }
    })()
    return () => { cancelled = true }
  }, [selected, base, getToken])

  const save = async (path: string, body: string) => {
    setBusy(true); setErr(null)
    try {
      await api(`${base}`, { token: await getToken(), method: 'PUT', body: JSON.stringify({ path, content: body }) })
      setContent(body); setStored(true); setEditing(false)
      await loadFiles()
    } catch (e: any) { setErr(e?.message ?? 'Could not save that file.') }
    setBusy(false)
  }

  const addFile = async () => {
    const name = newName.trim()
    if (!name) return
    const path = /\.md$/i.test(name) ? name : `${name}.md`
    setAddOpen(false); setNewName('')
    await save(path, `# ${path.replace(/\.md$/i, '')}\n\n`)
    setSelected(path)
  }

  const remove = async (path: string) => {
    setBusy(true); setErr(null)
    try {
      await api(`${base}?path=${encodeURIComponent(path)}`, { token: await getToken(), method: 'DELETE' })
      setSelected(null)
      await loadFiles()
    } catch (e: any) { setErr(e?.message ?? 'Could not delete that file.') }
    setBusy(false)
  }

  if (err && !files) return <div style={ax.err}>{err}</div>
  if (!files) return <div style={{ display: 'flex', gap: space.lg }}><Skeleton w={240} h={200} /><Skeleton h={200} /></div>

  const current = files.find(f => f.path === selected)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space.md }}>
      {err && <div style={ax.err}>{err}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(200px, 260px) 1fr', gap: space.lg, alignItems: 'start' }}>

        {/* ── Files panel ──────────────────────────────────────────────── */}
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: `${space.md}px ${space.lg}px`, borderBottom: `1px solid ${tk.line}` }}>
            <span style={{ fontSize: text.sm.fontSize, fontWeight: 700 }}>Files</span>
            <Button aria-label="Add a markdown file" title="Add a .md file" onClick={() => setAddOpen(true)}
              style={{ height: 22, padding: `0 ${space.sm}px` }}>＋</Button>
          </div>
          {files.map(f => {
            const on = f.path === selected
            return (
              <button key={f.path} onClick={() => setSelected(f.path)} aria-current={on}
                style={{
                  display: 'flex', alignItems: 'center', gap: space.sm, width: '100%', textAlign: 'left',
                  padding: `${space.sm}px ${space.lg}px`, cursor: 'pointer',
                  background: on ? 'var(--accent-dim)' : 'transparent',
                  border: 'none', borderLeft: `2px solid ${on ? tk.accent : 'transparent'}`,
                  color: on ? tk.text : tk.textDim, fontSize: text.sm.fontSize, fontWeight: on ? 700 : 500,
                }}>
                <span aria-hidden="true" style={{ opacity: f.stored ? 1 : 0.45 }}>📄</span>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.path}</span>
                {f.entry
                  ? <span style={{ ...sx.badge, color: tk.accent, borderColor: 'var(--accent-line)' }}>ENTRY</span>
                  : <span style={{ fontSize: text.xs.fontSize, color: tk.muted }}>{fmtBytes(f.bytes)}</span>}
              </button>
            )
          })}
          <p style={{ ...ax.empty, fontSize: text.xs.fontSize, padding: `${space.md}px ${space.lg}px`, borderTop: `1px solid ${tk.line}` }}>
            Saved files are sent to the agent as its instructions. A file that has never been saved shows a suggested default and changes nothing.
          </p>
        </Card>

        {/* ── Viewer / editor ──────────────────────────────────────────── */}
        <Card style={{ display: 'flex', flexDirection: 'column', gap: space.md, minHeight: 320 }}>
          {!current ? <p style={ax.empty}>Select a file.</p> : (
            <>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: space.md }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: text.md.fontSize, fontWeight: 700, fontFamily: 'monospace' }}>{current.path}</div>
                  <div style={{ fontSize: text.xs.fontSize, color: tk.muted }}>
                    markdown file · {fmtBytes(current.bytes)}{!stored && ' · not saved yet (suggested default)'}
                  </div>
                </div>
                {editing ? (
                  <div style={{ display: 'flex', gap: space.sm }}>
                    <Button onClick={() => { setDraft(content); setEditing(false) }} disabled={busy}>Cancel</Button>
                    <Button variant="primary" onClick={() => save(current.path, draft)} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: space.sm }}>
                    <Button onClick={() => { setDraft(content); setEditing(true) }}>Edit</Button>
                    {!current.managed && <Button variant="danger" onClick={() => remove(current.path)} disabled={busy}>Delete</Button>}
                  </div>
                )}
              </div>

              {editing
                ? <TextArea value={draft} onChange={e => setDraft(e.target.value)} spellCheck={false}
                    aria-label={`${current.path} contents`}
                    style={{ minHeight: 380, fontFamily: 'monospace', fontSize: text.sm.fontSize, lineHeight: 1.6 }} />
                : <Markdown src={content} />}
            </>
          )}
        </Card>
      </div>

      {addOpen && (
        <Modal onClose={() => setAddOpen(false)}>
          <ModalTitle onClose={() => setAddOpen(false)}>Add a markdown file</ModalTitle>
          <FormLabel>File name
            <TextInput autoFocus value={newName} placeholder="NOTES.md"
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') addFile() }} />
          </FormLabel>
          <p style={{ ...ax.empty, fontSize: text.xs.fontSize }}>A bare file name ending in .md — no folders.</p>
          <div style={{ display: 'flex', gap: space.sm, justifyContent: 'flex-end' }}>
            <Button onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={addFile} disabled={!newName.trim()}>Add</Button>
          </div>
        </Modal>
      )}
    </div>
  )
}

// ─── markdown rendering (React elements — never HTML injection) ──────────────

function Spans({ spans }: { spans: Inline[] }) {
  return (
    <>
      {spans.map((s, i) => {
        if (s.kind === 'code') return <code key={i} style={{ ...sx.code, color: tk.accent }}>{s.text}</code>
        if (s.kind === 'strong') return <strong key={i}>{s.text}</strong>
        return <span key={i}>{s.text}</span>
      })}
    </>
  )
}

function Markdown({ src }: { src: string }) {
  const blocks: Block[] = parseMarkdown(src)
  if (blocks.length === 0) return <p style={ax.empty}>This file is empty.</p>
  const H = { 1: 20, 2: 16, 3: 14 } as const
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space.md, fontSize: text.md.fontSize, lineHeight: 1.65, color: tk.text }}>
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'heading': {
            const Tag = (`h${b.level}`) as 'h1' | 'h2' | 'h3'
            return <Tag key={i} style={{ margin: 0, fontSize: H[b.level], fontWeight: 800, fontFamily: 'monospace' }}><Spans spans={b.spans} /></Tag>
          }
          case 'list':
            return b.ordered
              ? <ol key={i} style={{ margin: 0, paddingLeft: 22 }}>{b.items.map((it, j) => <li key={j}><Spans spans={it} /></li>)}</ol>
              : <ul key={i} style={{ margin: 0, paddingLeft: 22 }}>{b.items.map((it, j) => <li key={j}><Spans spans={it} /></li>)}</ul>
          case 'code':
            return <pre key={i} style={{ ...sx.pre, margin: 0, overflowX: 'auto' }}>{b.text}</pre>
          case 'quote':
            return <blockquote key={i} style={{ margin: 0, paddingLeft: space.lg, borderLeft: `2px solid var(--accent-line)`, color: tk.textDim }}><Spans spans={b.spans} /></blockquote>
          case 'rule':
            return <hr key={i} style={{ border: 'none', borderTop: `1px solid ${tk.line}`, width: '100%', margin: 0 }} />
          default:
            return <p key={i} style={{ margin: 0 }}><Spans spans={b.spans} /></p>
        }
      })}
    </div>
  )
}
