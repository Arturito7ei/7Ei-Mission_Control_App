'use client'
// AAD-2 — the desk's role signal.
//
// WHY THIS FILE EXISTS. The web had no shared "what am I in this org" source.
// The one `isOwner` in the codebase was read out of an API response body inside
// `cockpit/ActivityLogSection.tsx` and kept to itself, so an owner-gated control
// anywhere else had nothing to ask. This hoists exactly that signal — no new
// auth path, no new endpoint, no client-side role guess.
//
// THE SOURCE. `GET /api/orgs/:orgId/activity` computes `isOwner` SERVER-SIDE
// from the caller's real identity (`enforceOrgRole({ minRole: 'owner' })`,
// routes/activity.ts) and returns it alongside the feed. We ask for the smallest
// possible page — `?limit=1&kind=task` narrows the k-way merge to the single
// tasks source — because we want the header, not the body.
//
// WHY NOT `/api/users/:userId/orgs` (the phone's source)? It needs the Clerk
// userId, which the desk's `useAuth` shim does not expose, and which does not
// exist at all in the PACKAGED loopback profile (Epic H6). The activity route
// derives the role from whatever identity actually authenticated the request, so
// it is correct under BOTH auth modes. The phone keeps its own source; both
// agree because both are the server's answer, not a client inference.
//
// FAIL CLOSED. Unresolved (in flight, error, no org) is `null`, never `true`.
// Callers must treat `null` as "do not offer", not as "probably fine".
import { useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import type { Getter } from './cockpit/shared'

export interface OrgRoleState {
  /** true = owner · false = known non-owner · null = not yet known / unresolved. */
  isOwner: boolean | null
  /** The role string, for the pure `canDeleteAgent` helper. null when unresolved. */
  role: 'owner' | 'member' | null
  loading: boolean
}

export function useOrgRole(orgId: string | null | undefined, getToken: Getter): OrgRoleState {
  const [isOwner, setIsOwner] = useState<boolean | null>(null)
  const [loading, setLoading] = useState(true)
  // The effect must depend on `orgId` ALONE. Clerk's `getToken` is stable, but the
  // packaged shim (and any future one) rebuilds it every render, and a getToken in
  // the dep array would then re-fire this on every render — a request loop in a
  // hook whose whole job is to be cheap. The ref keeps the latest one reachable
  // without making its identity a trigger.
  const tokenRef = useRef(getToken)
  tokenRef.current = getToken

  useEffect(() => {
    let cancelled = false
    if (!orgId) { setIsOwner(null); setLoading(false); return }
    setLoading(true)
    ;(async () => {
      try {
        const r = await api<{ isOwner?: boolean }>(`/api/orgs/${orgId}/activity?limit=1&kind=task`, { token: await tokenRef.current() })
        if (!cancelled) setIsOwner(typeof r.isOwner === 'boolean' ? r.isOwner : null)
      } catch {
        // A 403 here means "not a member", which is also not an owner — but we
        // cannot tell it apart from a network failure, so both stay UNKNOWN and
        // the caller offers nothing. Never fall through to `true`.
        if (!cancelled) setIsOwner(null)
      }
      if (!cancelled) setLoading(false)
    })()
    return () => { cancelled = true }
  }, [orgId])

  return { isOwner, role: isOwner === true ? 'owner' : isOwner === false ? 'member' : null, loading }
}
