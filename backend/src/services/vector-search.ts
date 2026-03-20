// ─── Pinecone Vector Search ───────────────────────────────────────────────────────
// Semantic search over knowledge base items
// Embeddings via Anthropic (claude-3-haiku) or OpenAI text-embedding-3-small
// Storage: Pinecone serverless (us-east-1)

const PINECONE_BASE = `https://controller.${process.env.PINECONE_ENVIRONMENT ?? 'us-east-1-aws'}.pinecone.io`
const PINECONE_INDEX = process.env.PINECONE_INDEX ?? '7ei-knowledge'
const INDEX_DIMENSION = 1536  // matches text-embedding-3-small and many Anthropic embeddings

function pineconeHeaders() {
  return {
    'Api-Key': process.env.PINECONE_API_KEY ?? '',
    'Content-Type': 'application/json',
  }
}

function indexBase(): string {
  return `https://${PINECONE_INDEX}-${process.env.PINECONE_PROJECT_ID ?? ''}.svc.${process.env.PINECONE_ENVIRONMENT ?? 'us-east-1-aws'}.pinecone.io`
}

// ─ Embeddings ──────────────────────────────────────────────────────

export async function embedText(text: string): Promise<number[]> {
  // Use OpenAI embeddings if key is set, otherwise stub with random (for dev)
  const openaiKey = process.env.OPENAI_API_KEY
  if (openaiKey) {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: text.slice(0, 8192) }),
    })
    if (!res.ok) throw new Error('Embedding failed')
    const data = await res.json() as any
    return data.data[0].embedding as number[]
  }
  // Fallback: deterministic pseudo-embedding (dev mode, not semantically meaningful)
  console.warn('No OPENAI_API_KEY — using stub embeddings (dev mode)')
  const arr = new Array(INDEX_DIMENSION).fill(0)
  for (let i = 0; i < text.length && i < INDEX_DIMENSION; i++) {
    arr[i % INDEX_DIMENSION] += text.charCodeAt(i) / 1000
  }
  const norm = Math.sqrt(arr.reduce((s: number, v: number) => s + v * v, 0)) || 1
  return arr.map((v: number) => v / norm)
}

// ─ Index management ─────────────────────────────────────────────────

export async function ensureIndex(): Promise<void> {
  if (!process.env.PINECONE_API_KEY) return
  try {
    const res = await fetch(`${PINECONE_BASE}/databases/${PINECONE_INDEX}`, {
      headers: pineconeHeaders(),
    })
    if (res.status === 404) {
      await fetch(`${PINECONE_BASE}/databases`, {
        method: 'POST',
        headers: pineconeHeaders(),
        body: JSON.stringify({
          name: PINECONE_INDEX, dimension: INDEX_DIMENSION,
          metric: 'cosine', spec: { serverless: { cloud: 'aws', region: 'us-east-1' } },
        }),
      })
      console.log('Pinecone index created:', PINECONE_INDEX)
    }
  } catch (err) {
    console.warn('Pinecone index check failed (non-critical):', err)
  }
}

// ─ Upsert document ───────────────────────────────────────────────────

export async function upsertDocument(doc: {
  id: string; orgId: string; text: string
  name: string; type?: string; externalUrl?: string
}): Promise<void> {
  if (!process.env.PINECONE_API_KEY) return
  const embedding = await embedText(doc.text)
  const res = await fetch(`${indexBase()}/vectors/upsert`, {
    method: 'POST',
    headers: pineconeHeaders(),
    body: JSON.stringify({
      vectors: [{
        id: doc.id,
        values: embedding,
        metadata: { orgId: doc.orgId, name: doc.name, type: doc.type ?? 'file', externalUrl: doc.externalUrl ?? '' },
      }],
    }),
  })
  if (!res.ok) console.warn('Pinecone upsert failed:', await res.text())
}

// ─ Delete document ───────────────────────────────────────────────────

export async function deleteDocument(id: string): Promise<void> {
  if (!process.env.PINECONE_API_KEY) return
  await fetch(`${indexBase()}/vectors/delete`, {
    method: 'POST',
    headers: pineconeHeaders(),
    body: JSON.stringify({ ids: [id] }),
  })
}

// ─ Semantic search ──────────────────────────────────────────────────

export interface SearchResult {
  id: string; score: number
  name: string; type: string; externalUrl: string
}

export async function searchKnowledge(query: string, orgId: string, topK = 5): Promise<SearchResult[]> {
  if (!process.env.PINECONE_API_KEY) return []
  const embedding = await embedText(query)
  const res = await fetch(`${indexBase()}/query`, {
    method: 'POST',
    headers: pineconeHeaders(),
    body: JSON.stringify({
      vector: embedding,
      topK,
      includeMetadata: true,
      filter: { orgId: { '$eq': orgId } },
    }),
  })
  if (!res.ok) return []
  const data = await res.json() as any
  return (data.matches ?? []).map((m: any) => ({
    id: m.id, score: m.score,
    name: m.metadata?.name ?? 'Untitled',
    type: m.metadata?.type ?? 'file',
    externalUrl: m.metadata?.externalUrl ?? '',
  }))
}
