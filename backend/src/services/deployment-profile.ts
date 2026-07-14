// Epic ONB / ONB1 — the DEPLOYMENT PROFILE abstraction.
//
// Mission Control runs in exactly one of two profiles, chosen by config, and the
// onboarding posture is DERIVED from the profile rather than hardcoded anywhere:
//
//   * `hosted`   — multi-tenant on a public URL (today: 7ei-backend.fly.dev).
//                  Public agent onboarding is OFF by default; turning it on
//                  requires an explicit enable AND every hardening requirement
//                  satisfied. A public join endpoint on a public backend is a
//                  real attack surface (DESIGN-agent-onboarding §4.2).
//   * `packaged` — single-tenant, installed on the operator's own machine (the
//                  future .dmg — Epic H). Loopback is trusted, like Paperclip's
//                  `local_trusted` mode; onboarding is reachable from localhost.
//
// This module is PURE: it reads a plain env-like record and returns a decision.
// Nothing here touches the network, the DB, or `process` — the route layer feeds
// `process.env` in. That keeps the posture snapshot-testable and lets the config
// bundle (services/config-bundle.ts) carry it between machines verbatim.
//
// The four operator-approved posture defaults are encoded here as INVARIANTS —
// they are not env-tunable:
//   1. public join endpoint OFF by default, gated by profile;
//   2. invites are SINGLE-USE by default (multi-use is an explicit per-invite opt-in);
//   3. every invite-created agent lands in LOW_TRUST_REVIEW regardless of runtime;
//   4. the raw claimed agent token is NEVER shown in an operator UI or a log —
//      only the claiming agent reads it, once, from the raw HTTP response.

export const DEPLOYMENT_PROFILES = ['hosted', 'packaged'] as const
export type DeploymentProfile = (typeof DEPLOYMENT_PROFILES)[number]

/** Safe default. An unset/garbage value must resolve to the HARDER posture —
 *  the live deployment is hosted, and mis-reading it as packaged would trust
 *  loopback on a machine whose loopback we do not own. */
export const DEFAULT_DEPLOYMENT_PROFILE: DeploymentProfile = 'hosted'

export type EnvLike = Record<string, string | undefined>

/** Resolve the deployment profile from config. Unknown → the safe default. */
export function resolveDeploymentProfile(env: EnvLike = {}): DeploymentProfile {
  const raw = String(env.MC_DEPLOYMENT_PROFILE ?? '').trim().toLowerCase()
  return (DEPLOYMENT_PROFILES as readonly string[]).includes(raw)
    ? (raw as DeploymentProfile)
    : DEFAULT_DEPLOYMENT_PROFILE
}

// ─── Hardening requirements for a PUBLIC (hosted) join endpoint ──────────────
//
// Each requirement is a named control that must be in place before a hosted
// deployment may expose an unauthenticated join endpoint. `satisfied` is
// computed, never asserted: a control that is designed-but-not-yet-wired reports
// `false`, so the posture cannot be talked into being open by an env var.

export interface HardeningRequirement {
  key: string
  description: string
  satisfied: boolean
  /** Why it is not satisfied (null when it is). */
  blocker: string | null
}

/**
 * Is the public JOIN surface actually BUILT yet?
 *
 * ONB1 shipped the invite object + the adapter registry and wired nothing public.
 * **ONB3 builds the join surface**: the public join request, the board-approval
 * gate (no agent row and no token before a human approves), the atomic single-use
 * consume, and the per-IP rate limit. Those are the controls that make an
 * unauthenticated endpoint safe, so this flips to `true` here — and NOT before.
 *
 * What it does NOT do: open the door by itself. `publicJoinEnabled` still requires
 * the deployment profile to allow it (packaged = loopback-trusted; hosted = an
 * explicit `MC_ENABLE_REMOTE_ONBOARDING`). A hosted deployment with the flag unset
 * still answers the join route with the same flat 404 as an unknown invite.
 */
export const PUBLIC_JOIN_IMPLEMENTED = true

/**
 * Is the one-time TOKEN CLAIM built? **No — that is ONB4.**
 *
 * This is the honest half of the ONB3 posture, and it is deliberately a SEPARATE
 * constant rather than a widening of the one above: ONB3 lets an agent describe
 * itself and lets a human approve it, and an approved agent is created with NO
 * claimable credential. `POST /api/agent-join-requests/:id/claim-api-key` does not
 * exist, and the landmine guard (`auth-scoping.test.ts`) asserts that no claim
 * route is registered while this is false. Flip it in the PR that lands ONB4.
 */
export const TOKEN_CLAIM_IMPLEMENTED = false

/** ONB3 — the public join endpoint is per-IP rate limited (`perIpRateLimit`, which
 *  ONB1's audit found had zero call-sites). The ONB2 re-audit's M-3 condition:
 *  rate limiting must EXIST before `MC_ENABLE_REMOTE_ONBOARDING` is ever set in
 *  production, so it is a hardening requirement and not merely a nicety. */
export const JOIN_RATE_LIMIT_PER_MINUTE = 10
export const JOIN_RATE_LIMIT_WIRED = true

const truthy = (v: string | undefined) => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').trim().toLowerCase())

/** The hardening checklist for the given config, in report order. */
export function hardeningRequirements(env: EnvLike = {}): HardeningRequirement[] {
  return [
    {
      key: 'join_surface_implemented',
      description: 'The join request + the board-approval gate exist, and no credential exists before approval (ONB3).',
      satisfied: PUBLIC_JOIN_IMPLEMENTED,
      blocker: PUBLIC_JOIN_IMPLEMENTED ? null : 'not built yet',
    },
    {
      key: 'join_rate_limited',
      description: `The public join endpoint is per-IP rate limited (${JOIN_RATE_LIMIT_PER_MINUTE}/min).`,
      satisfied: JOIN_RATE_LIMIT_WIRED,
      blocker: JOIN_RATE_LIMIT_WIRED ? null : 'perIpRateLimit is not wired onto the join route',
    },
    {
      key: 'human_approval_gate',
      description: 'No agent row and no token exist before a human approves the join request.',
      satisfied: REQUIRE_HUMAN_APPROVAL, // an invariant of the design, not a switch
      blocker: null,
    },
    {
      key: 'invite_single_use_default',
      description: 'Invites are single-use unless the operator explicitly opts into multi-use.',
      satisfied: INVITES_SINGLE_USE_BY_DEFAULT,
      blocker: null,
    },
    {
      key: 'remote_onboarding_enabled',
      description: 'The operator explicitly enabled remote onboarding (MC_ENABLE_REMOTE_ONBOARDING=1).',
      satisfied: truthy(env.MC_ENABLE_REMOTE_ONBOARDING),
      blocker: truthy(env.MC_ENABLE_REMOTE_ONBOARDING) ? null : 'MC_ENABLE_REMOTE_ONBOARDING is not set',
    },
  ]
}

// ─── The four invariants (not env-tunable) ──────────────────────────────────

/** (2) Single-use invites by default. Multi-use is an explicit per-invite opt-in. */
export const INVITES_SINGLE_USE_BY_DEFAULT = true
/** (3) Every invite-created agent lands in low_trust_review, whatever its runtime. */
export const INVITE_AGENTS_ALWAYS_LOW_TRUST = true
/** (4) The raw claimed token is never rendered in an operator surface or a log. */
export const NEVER_REVEAL_CLAIMED_TOKEN = true
/** A human approves every join request before any credential exists. */
export const REQUIRE_HUMAN_APPROVAL = true

export interface OnboardingPosture {
  profile: DeploymentProfile
  /** Is an unauthenticated join endpoint reachable at all? */
  publicJoinEnabled: boolean
  /** Is the one-time token CLAIM built? Always false until ONB4 — an approved
   *  agent exists, contained, with no claimable credential. */
  tokenClaimEnabled: boolean
  /** Are loopback callers trusted (packaged/local, Paperclip-style)? */
  loopbackTrusted: boolean
  /** Invariant (1): the operator asked for remote onboarding. */
  remoteOnboardingRequested: boolean
  /** Invariant: a human decides before a credential exists. */
  requireHumanApproval: true
  /** Invariant: single-use invites by default. */
  invitesSingleUseByDefault: true
  /** Invariant: invite-created agents are contained regardless of runtime. */
  lowTrustEveryInviteAgent: true
  /** Invariant: the claimed token never reaches an operator UI/clipboard/log. */
  operatorCanSeeClaimedKey: false
  hardening: HardeningRequirement[]
  /** Human-readable reasons the public join surface is closed (empty when open). */
  closedBecause: string[]
  /** ONB2: is the per-invite onboarding DOCUMENT fetchable over the public,
   *  token-addressed route? A strictly smaller surface than the join endpoint —
   *  see `onboardingDocAccess`. */
  onboardingDocPublic: boolean
  /** Why the doc route is closed (null when open). */
  onboardingDocClosedBecause: string | null
}

/**
 * ONB2 — may the per-invite onboarding DOCUMENT be served over the public,
 * token-addressed route (`GET /api/agent-invites/:token/onboarding[.txt]`)?
 *
 * This is a deliberately SMALLER decision than `publicJoinEnabled`, and it is a
 * separate one:
 *
 *  * The doc is **not a credential and mints none**. It restates the invite the
 *    caller already holds and describes endpoints that (in ONB2) do not exist yet.
 *    Reading it buys an attacker nothing they did not already have by holding the
 *    token — which they cannot get from the DB, since only its hash is stored.
 *  * But it is still an **unauthenticated route on a public backend**, so its
 *    exposure follows the deployment profile rather than being simply "on":
 *      - `packaged`  → loopback-trusted: open (the operator owns the machine);
 *      - `hosted`    → closed unless the operator explicitly enabled remote
 *                      onboarding (`MC_ENABLE_REMOTE_ONBOARDING=1`).
 *
 * Note what this does NOT do: the enable flag opens the *doc*, never the *join*
 * surface — that stays shut behind `PUBLIC_JOIN_IMPLEMENTED` until ONB4 lands the
 * approval gate, the one-time claim and the per-IP rate limit. An operator who
 * turns remote onboarding on early gets a readable document, not an open door.
 *
 * When it is closed, the route must answer with the SAME flat 404 as an unknown
 * invite — a "this exists but you may not read it" would be an oracle.
 */
export function onboardingDocAccess(env: EnvLike = {}): { allowed: boolean; reason: string | null } {
  const profile = resolveDeploymentProfile(env)
  if (profile === 'packaged') return { allowed: true, reason: null }
  if (truthy(env.MC_ENABLE_REMOTE_ONBOARDING)) return { allowed: true, reason: null }
  return {
    allowed: false,
    reason: 'hosted profile without MC_ENABLE_REMOTE_ONBOARDING: the public onboarding document is not served',
  }
}

/**
 * Derive the onboarding posture from config. The only degree of freedom is
 * WHERE onboarding may be reached from; every safety property above is fixed.
 *
 *  - `packaged`: loopback is trusted (the operator owns the machine). The join
 *    surface is reachable from localhost once it exists — no public exposure.
 *  - `hosted`:   the join surface is closed unless EVERY hardening requirement
 *    is satisfied, which includes an explicit operator enable.
 */
export function onboardingPosture(env: EnvLike = {}): OnboardingPosture {
  const profile = resolveDeploymentProfile(env)
  const hardening = hardeningRequirements(env)
  const loopbackTrusted = profile === 'packaged'
  const remoteOnboardingRequested = truthy(env.MC_ENABLE_REMOTE_ONBOARDING)

  // Packaged: loopback-trusted, so the "remote onboarding" enable is not needed
  // — but the surface still has to EXIST. Hosted: every requirement, no exceptions.
  const required = profile === 'packaged'
    ? hardening.filter((h) => h.key !== 'remote_onboarding_enabled')
    : hardening
  const unmet = required.filter((h) => !h.satisfied)
  const doc = onboardingDocAccess(env)

  return {
    profile,
    publicJoinEnabled: unmet.length === 0,
    tokenClaimEnabled: TOKEN_CLAIM_IMPLEMENTED,
    loopbackTrusted,
    remoteOnboardingRequested,
    requireHumanApproval: REQUIRE_HUMAN_APPROVAL,
    invitesSingleUseByDefault: INVITES_SINGLE_USE_BY_DEFAULT,
    lowTrustEveryInviteAgent: INVITE_AGENTS_ALWAYS_LOW_TRUST,
    operatorCanSeeClaimedKey: false,
    hardening,
    closedBecause: unmet.map((h) => `${h.key}: ${h.blocker ?? 'not satisfied'}`),
    onboardingDocPublic: doc.allowed,
    onboardingDocClosedBecause: doc.reason,
  }
}
