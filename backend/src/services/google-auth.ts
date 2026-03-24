const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const SCOPES = 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file'

export function buildAuthUrl(orgId: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: `${process.env.PUBLIC_URL}/api/auth/google/callback`,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state: orgId,
  })
  return `${GOOGLE_AUTH_URL}?${params}`
}

export async function exchangeCode(code: string): Promise<{
  accessToken: string; refreshToken: string; expiresAt: Date
}> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: `${process.env.PUBLIC_URL}/api/auth/google/callback`,
      grant_type: 'authorization_code',
    }),
  })
  if (!res.ok) throw new Error(`Google token exchange failed: ${res.status}`)
  const data = await res.json() as any
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + (data.expires_in ?? 3600) * 1000),
  }
}

export async function refreshAccessToken(refreshToken: string): Promise<{
  accessToken: string; expiresAt: Date
}> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      grant_type: 'refresh_token',
    }),
  })
  if (!res.ok) throw new Error(`Google token refresh failed: ${res.status}`)
  const data = await res.json() as any
  return {
    accessToken: data.access_token,
    expiresAt: new Date(Date.now() + (data.expires_in ?? 3600) * 1000),
  }
}

export async function ensureFreshToken(token: {
  accessToken: string; refreshToken: string | null; expiresAt: Date | null
}): Promise<{ accessToken: string; expiresAt: Date }> {
  if (token.expiresAt && token.expiresAt > new Date(Date.now() + 60000)) {
    return { accessToken: token.accessToken, expiresAt: token.expiresAt }
  }
  if (!token.refreshToken) throw new Error('Token expired and no refresh token')
  return refreshAccessToken(token.refreshToken)
}

export async function searchDriveFiles(
  accessToken: string, query: string, maxResults: number
): Promise<Array<{ id: string; name: string; snippet: string }>> {
  const q = `fullText contains '${query.replace(/'/g, "\\'")}' and trashed = false`
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType)&pageSize=${maxResults}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) return []
  const data = await res.json() as any
  const results: Array<{ id: string; name: string; snippet: string }> = []
  for (const file of (data.files ?? []).slice(0, maxResults)) {
    try {
      const exportUrl = file.mimeType?.includes('google-apps')
        ? `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=text/plain`
        : `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`
      const contentRes = await fetch(exportUrl, { headers: { Authorization: `Bearer ${accessToken}` } })
      if (contentRes.ok) {
        const text = await contentRes.text()
        results.push({ id: file.id, name: file.name, snippet: text.slice(0, 500) })
      }
    } catch { /* skip unreadable files */ }
  }
  return results
}
