// MOB-4 — on-device step-up for approving DANGEROUS actions from the phone.
//
// The backend gate (backend/src/routes/tasks.ts): approving a dangerous type
// (file_destructive | wallet_tx | email_send | machine_exec) requires a FRESH
// Arturita command session presented in the `x-arturita-session` header, else
// 403. This module supplies the *on-device* half of that flow — the local human
// gate that must pass BEFORE the phone mints a step-up session:
//
//   1. Biometric (Face ID / Touch ID / device passcode) via
//      `expo-local-authentication` — a first-party Expo module BUNDLED in Expo
//      Go (expo/bundledNativeModules.json → ~57.0.1), so it runs without a dev
//      build. A dev build only hardens the enrollment/anti-spoof posture.
//   2. Typed-confirmation fallback (type APPROVE) when biometric hardware is
//      absent or not enrolled (e.g. a simulator, or a device with no Face ID) —
//      so the gate NEVER silently degrades to a one-tap approve.
//
// The pure helpers here (danger summary, the gate decision) are IO-free and
// deterministically testable; the biometric wrappers isolate the native call
// behind try/catch so an unavailable module degrades to the typed fallback
// rather than crashing the Inbox. NEVER log the step-up token (it never reaches
// this module) or any biometric material.

import * as LocalAuthentication from 'expo-local-authentication'
import type { Approval } from './api'

// The word the operator must type in the fallback modal to confirm a dangerous
// approve. Uppercased + exact-match so a stray "approve"/" ok " never passes.
export const TYPED_CONFIRM_WORD = 'APPROVE'

/** Does the typed input satisfy the fallback gate? Exact (trimmed) match of the
 *  confirm word — case-sensitive so intent is unambiguous. */
export function typedConfirmationOk(input: string | null | undefined): boolean {
  return String(input ?? '').trim() === TYPED_CONFIRM_WORD
}

// ─── Danger summary (pure) ───────────────────────────────────────────────────

export interface DangerDetails {
  /** Human label of the dangerous type, e.g. "file destructive". */
  typeLabel: string
  /** The machine-rendered, verbatim action summary the backend stored. */
  summary: string
  /** The backend's danger flags (external recipient, unlimited approval, …). */
  warnings: string[]
}

/** Extract what the step-up card must show the operator: the type, the
 *  machine-rendered summary (never model prose — the backend renders it), and the
 *  danger warnings the backend surfaced in `payload.warnings`. Pure + defensive:
 *  a missing/oddly-shaped payload yields an empty warnings list, never throws. */
export function dangerDetails(a: Approval): DangerDetails {
  const warnings = Array.isArray(a?.payload?.warnings)
    ? a.payload.warnings.map((w: unknown) => String(w)).filter(Boolean)
    : []
  return {
    typeLabel: String(a?.type ?? '').replace(/_/g, ' '),
    summary: a?.summary || '(no summary provided)',
    warnings,
  }
}

// ─── Biometric gate (native, isolated behind try/catch) ──────────────────────

export interface BiometricProbe {
  /** Biometric/passcode hardware present AND enrolled → biometric can run. */
  usable: boolean
  /** UI label for the strongest method present ("Face ID"/"Touch ID"/"passcode"). */
  label: string
}

/** Probe whether an on-device biometric/passcode gate can run. Fail-closed on any
 *  error (module missing, native unavailable) → `usable:false`, so the caller
 *  falls back to typed confirmation rather than skipping the gate. */
export async function probeBiometric(): Promise<BiometricProbe> {
  try {
    const hasHardware = await LocalAuthentication.hasHardwareAsync()
    const enrolled = await LocalAuthentication.isEnrolledAsync()
    if (!hasHardware || !enrolled) return { usable: false, label: '' }
    let label = 'device passcode'
    try {
      const types = await LocalAuthentication.supportedAuthenticationTypesAsync()
      if (types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) label = 'Face ID'
      else if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) label = 'Touch ID'
    } catch {
      // keep the generic passcode label
    }
    return { usable: true, label }
  } catch {
    return { usable: false, label: '' }
  }
}

export type BiometricResult =
  | { ok: true }
  | { ok: false; reason: 'cancelled' | 'failed' | 'unavailable' }

/** Run the biometric/passcode prompt. `success:true` gates the step-up mint.
 *  Device-passcode fallback stays ON (disableDeviceFallback:false) so a device
 *  without a biometric enrolled can still confirm with its passcode. Fail-closed:
 *  any thrown error → `unavailable` (caller re-routes to typed confirmation). */
export async function runBiometricGate(prompt: string): Promise<BiometricResult> {
  try {
    const res = await LocalAuthentication.authenticateAsync({
      promptMessage: prompt,
      cancelLabel: 'Cancel',
      disableDeviceFallback: false,
    })
    if (res.success) return { ok: true }
    const err = 'error' in res ? res.error : ''
    const cancelled = err === 'user_cancel' || err === 'system_cancel' || err === 'app_cancel'
    return { ok: false, reason: cancelled ? 'cancelled' : 'failed' }
  } catch {
    return { ok: false, reason: 'unavailable' }
  }
}
