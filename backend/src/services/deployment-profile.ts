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
 * Is the public join/claim surface actually BUILT yet?
 *
 * ONB1 ships the invite object + the adapter registry and wires NOTHING public.
 * The join request (ONB3), the approval gate (ONB3) and the one-time claim +
 * per-IP rate limit (ONB4) are the controls that make a public endpoint safe;
 * until they land, `publicJoinEnabled` is false in EVERY profile, whatever the
 * config says. Flip this to `true` in the PR that lands ONB4 — and only then.
 */
export const PUBLIC_JOIN_IMPLEMENTED = false

const truthy = (v: string | undefined) => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').trim().toLowerCase())

/** The hardening checklist for the given config, in report order. */
export function hardeningRequirements(env: EnvLike = {}): HardeningRequirement[] {
  return [
    {
      key: 'join_surface_implemented',
      description: 'The join request + board-approval gate + one-time claim exist (ONB3/ONB4).',
      satisfied: PUBLIC_JOIN_IMPLEMENTED,
      blocker: PUBLIC_JOIN_IMPLEMENTED ? null : 'not built yet — ONB1 wires no public endpoint',
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

  return {
    profile,
    publicJoinEnabled: unmet.length === 0,
    loopbackTrusted,
    remoteOnboardingRequested,
    requireHumanApproval: REQUIRE_HUMAN_APPROVAL,
    invitesSingleUseByDefault: INVITES_SINGLE_USE_BY_DEFAULT,
    lowTrustEveryInviteAgent: INVITE_AGENTS_ALWAYS_LOW_TRUST,
    operatorCanSeeClaimedKey: false,
    hardening,
    closedBecause: unmet.map((h) => `${h.key}: ${h.blocker ?? 'not satisfied'}`),
  }
}
