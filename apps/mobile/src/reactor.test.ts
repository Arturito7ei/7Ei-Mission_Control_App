// MOB-7a — the reactor port's tripwire.
//
// `src/reactor.ts` is a HAND-COPY of web/app/dashboard/reactor.logic.ts, because
// Metro can't import out of apps/mobile into web/. The root CLAUDE.md's rule for
// that is explicit: pin the copy with a test that imports the web module and
// asserts they agree. Without this file, a web tweak to a caption or a spin
// period leaves the phone quietly showing last month's reactor.
//
// Both web modules load cleanly under `node --test --experimental-strip-types`:
// reactor.logic.ts's only import is `import type`, and tokens.ts's only import is
// `import type { CSSProperties } from 'react'` — both erased at strip time. That
// matters: Mobile CI installs ONLY apps/mobile's lockfile, so a test that pulled a
// real web dependency would pass here and silently drop the whole file in CI.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  REACTOR_HEADLINE as WEB_HEADLINE,
  provenanceChip as webProvenanceChip,
  reactorChips as webReactorChips,
  reactorVisual as webReactorVisual,
} from '../../../web/app/dashboard/reactor.logic.ts'
import { themes as webThemes } from '../../../web/app/dashboard/tokens.ts'
import {
  REACTOR_ACCENT,
  REACTOR_HEADLINE,
  REACTOR_LOGO_FILL,
  REACTOR_METAL,
  RING_MULT,
  RIPPLE_DELAY_MS,
  RIPPLE_MS,
  coreMotion,
  provenanceChip,
  reactorAccent,
  reactorChips,
  reactorVisual,
  resolveVoiceState,
  ringDurationMs,
  rippleOpacity,
  ripplesVisible,
  rnColor,
  type VoiceState,
} from './reactor.ts'

const STATES: VoiceState[] = ['idle', 'listening', 'thinking', 'speaking']

/**
 * The web's reactor motion lives in CSS, which RN can't import — so the numbers
 * are ported into reactor.ts and pinned HERE, by reading the real stylesheet.
 * Reading the file (rather than trusting a comment) is what makes the port a
 * checked claim: retune a keyframe on the web and these fail.
 *
 * Safe in Mobile CI: CI checks out the whole repo and only the INSTALL is scoped
 * to apps/mobile, so this path resolves there exactly as it does locally.
 */
const GLOBALS_CSS = readFileSync(new URL('../../../web/app/globals.css', import.meta.url), 'utf8')

test('[MOB-7a] every voice state maps to the web reactor visual, field for field', () => {
  for (const s of STATES) {
    assert.deepEqual(reactorVisual(s), webReactorVisual(s), `reactor visual drift on "${s}"`)
  }
})

test('[MOB-7a] the headline matches the web', () => {
  assert.equal(REACTOR_HEADLINE, WEB_HEADLINE)
})

test('[MOB-7a] an unknown state falls back to idle, as the web does', () => {
  assert.deepEqual(
    reactorVisual('nonsense' as VoiceState),
    webReactorVisual('nonsense' as any),
  )
})

test('[MOB-7a] resolveVoiceState keeps the web precedence: speaking > thinking > listening > idle', () => {
  assert.equal(resolveVoiceState({ speaking: true, thinking: true, listening: true }), 'speaking')
  assert.equal(resolveVoiceState({ thinking: true, listening: true }), 'thinking')
  assert.equal(resolveVoiceState({ listening: true }), 'listening')
  assert.equal(resolveVoiceState({}), 'idle')
})

test('[MOB-7a] the provenance chip matches the web, local and cloud', () => {
  assert.deepEqual(provenanceChip({ local: { model: 'llama3.2:3b' } }), webProvenanceChip({ local: { model: 'llama3.2:3b' } }))
  assert.deepEqual(provenanceChip({ local: null }), webProvenanceChip({ local: null }))
  // A whitespace-only model is "no local model" on both sides.
  assert.deepEqual(provenanceChip({ local: { model: '  ' } }), webProvenanceChip({ local: { model: '  ' } }))
})

test('[MOB-7a] the status-chip row matches the web for every combination', () => {
  for (const local of [{ model: 'llama3.2:3b' }, null]) {
    for (const captureLabel of ['Local Whisper', '']) {
      for (const voiceReplies of [true, false]) {
        const input = { provenance: provenanceChip({ local }), captureLabel, voiceReplies }
        assert.deepEqual(
          reactorChips(input),
          webReactorChips({ provenance: webProvenanceChip({ local }), captureLabel, voiceReplies }),
          `chip drift for ${JSON.stringify({ local, captureLabel, voiceReplies })}`,
        )
      }
    }
  }
})

// ─── The metal is the web's dark token map, not a second palette ──────────────

test('[MOB-7a] the brushed-silver ramp is the web dark theme, verbatim', () => {
  const dark = webThemes.dark
  assert.equal(REACTOR_METAL.silver1, dark['--silver-1'])
  assert.equal(REACTOR_METAL.silver2, dark['--silver-2'])
  assert.equal(REACTOR_METAL.silver3, dark['--silver-3'])
  assert.equal(REACTOR_METAL.silver4, dark['--silver-4'])
  assert.equal(REACTOR_METAL.silverEdge, dark['--silver-edge'])
})

test('[MOB-7a] the glowing core + bloom are the web dark theme, verbatim', () => {
  const dark = webThemes.dark
  assert.equal(REACTOR_METAL.core1, dark['--reactor-core-1'])
  assert.equal(REACTOR_METAL.core2, dark['--reactor-core-2'])
  assert.equal(REACTOR_METAL.core3, dark['--reactor-core-3'])
  assert.equal(REACTOR_METAL.glow, dark['--reactor-glow'])
})

test('[MOB-7a] every state accent is the web dark token for that CSS var', () => {
  const dark = webThemes.dark
  assert.equal(REACTOR_ACCENT['var(--muted)'], dark['--muted'])
  assert.equal(REACTOR_ACCENT['var(--accent)'], dark['--accent'])
  assert.equal(REACTOR_ACCENT['var(--info)'], dark['--info'])
  assert.equal(REACTOR_ACCENT['var(--accent-2)'], dark['--accent-2'])
})

test('[MOB-7a] every accentVar the visuals emit resolves to a real accent', () => {
  // Guards the join between the two halves of the port: a state whose accentVar
  // has no REACTOR_ACCENT entry would silently paint the idle grey.
  for (const s of STATES) {
    const v = reactorVisual(s)
    assert.ok(REACTOR_ACCENT[v.accentVar], `no accent mapped for "${v.accentVar}" (state "${s}")`)
    assert.equal(reactorAccent(v.accentVar), rnColor(REACTOR_ACCENT[v.accentVar]))
  }
})

test('[MOB-7a] an unmapped accentVar degrades to muted rather than an invalid colour', () => {
  assert.equal(reactorAccent('var(--nope)'), rnColor(REACTOR_ACCENT['var(--muted)']))
})

test('[MOB-7a] the honeycomb mark is the web LIGHT logo fill — black, on purpose', () => {
  // The phone renders the web's DARK reactor everywhere EXCEPT here. The mark sits
  // on the icy white-blue core, and the web's dark token paints it the same value
  // as --reactor-core-1 — the wash-out the light theme's token comment describes
  // fixing by going black. This asserts we took the light token deliberately, and
  // that it is still black upstream.
  assert.equal(REACTOR_LOGO_FILL, webThemes.light['--reactor-logo-fill'])
  assert.equal(REACTOR_LOGO_FILL, '#000000')
})

// ─── Motion: ported from globals.css, pinned to globals.css ──────────────────

test('[MOB-7a] each ring keeps the web’s --rk-mult period multiplier', () => {
  // e.g. `.mc-rr-cw { animation: mcReactorCW calc(var(--rk-spin, 40s) * var(--rk-mult, 1)) … }`
  // with each group's --rk-mult set inline in Reactor.tsx. The multipliers are the
  // counter-rotation's whole character, so drift here is a visibly different machine.
  const multsInCss = [...GLOBALS_CSS.matchAll(/--rk-mult/g)]
  assert.ok(multsInCss.length > 0, 'globals.css no longer drives rings by --rk-mult — the port’s premise changed')
  assert.deepEqual(RING_MULT, { outer: 1, midFull: 2.4, gyro: 1.35, accent: 0.55 })
  // The accent ring must stay the fastest: "thinking spins fastest" is the point.
  assert.ok(RING_MULT.accent < RING_MULT.outer)
  assert.ok(RING_MULT.midFull > RING_MULT.gyro)
})

test('[MOB-7a] ring periods scale the state’s spin by the ring’s multiplier', () => {
  const idle = reactorVisual('idle')       // spinSec 48
  const thinking = reactorVisual('thinking') // spinSec 16
  assert.equal(ringDurationMs(idle.spinSec, RING_MULT.outer), 48_000)
  assert.equal(ringDurationMs(idle.spinSec, RING_MULT.midFull), 115_200)
  assert.equal(ringDurationMs(thinking.spinSec, RING_MULT.accent), 8_800)
  // Lower spinSec = faster, for every ring — the reactor spins UP when thinking.
  for (const mult of Object.values(RING_MULT)) {
    assert.ok(ringDurationMs(thinking.spinSec, mult) < ringDurationMs(idle.spinSec, mult))
  }
})

test('[MOB-7a] the core’s breathe/pulse periods match the web keyframe bindings', () => {
  // `[data-motion="breathe"] .mc-reactor-core { animation: mcReactorBreathe 10s … }`
  const bind = (motion: string) =>
    new RegExp(`data-motion="${motion}"\\]\\s*\\.mc-reactor-core\\s*\\{[^}]*?mcReactor(Breathe|Pulse)\\s+([\\d.]+)s`)
  for (const [motion, expected] of [
    ['breathe', { kind: 'breathe', durationMs: 10_000 }],
    ['listen', { kind: 'breathe', durationMs: 3_200 }],
    ['think', { kind: 'breathe', durationMs: 2_100 }],
    ['speak', { kind: 'pulse', durationMs: 850 }],
  ] as const) {
    const m = GLOBALS_CSS.match(bind(motion))
    assert.ok(m, `globals.css no longer binds a core animation for data-motion="${motion}"`)
    assert.equal(coreMotion(motion as any).kind, m![1].toLowerCase(), `core motion KIND drift on "${motion}"`)
    assert.equal(coreMotion(motion as any).durationMs, Number(m![2]) * 1000, `core motion PERIOD drift on "${motion}"`)
  }
})

test('[MOB-7a] every state’s motion key has a core motion', () => {
  for (const s of STATES) {
    const m = coreMotion(reactorVisual(s).motion)
    assert.ok(m.durationMs > 0, `state "${s}" has no core motion`)
  }
})

test('[MOB-7a] the ripple period and second-ring offset match the web', () => {
  const period = GLOBALS_CSS.match(/animation:\s*mcReactorRipple\s+([\d.]+)s/)
  assert.ok(period, 'globals.css no longer animates .mc-reactor-ripple')
  assert.equal(RIPPLE_MS, Number(period![1]) * 1000)

  const delay = GLOBALS_CSS.match(/\.mc-reactor-ripple-2\s*\{\s*animation-delay:\s*([\d.]+)s/)
  assert.ok(delay, 'globals.css no longer offsets the second ripple')
  assert.equal(RIPPLE_DELAY_MS, Number(delay![1]) * 1000)
  // The offset staggers the pair; equalling the period would overlap them exactly.
  assert.ok(RIPPLE_DELAY_MS < RIPPLE_MS)
})

test('[MOB-7a] ripples run only for listening and speaking, as the web binds them', () => {
  assert.equal(ripplesVisible('listen'), true)
  assert.equal(ripplesVisible('speak'), true)
  assert.equal(ripplesVisible('breathe'), false)
  assert.equal(ripplesVisible('think'), false)
  // The web binds the ripple animation to exactly those two motions.
  assert.match(GLOBALS_CSS, /data-motion="listen"\]\s*\.mc-reactor-ripple/)
  assert.match(GLOBALS_CSS, /data-motion="speak"\]\s*\.mc-reactor-ripple/)
})

test('[MOB-7a] ripple opacity is half the state intensity, as the keyframe says', () => {
  // `0% { … opacity: calc(.5 * var(--rk-intensity, 1)) }`
  assert.match(GLOBALS_CSS, /opacity:\s*calc\(\s*\.5\s*\*\s*var\(--rk-intensity/)
  assert.equal(rippleOpacity(1), 0.5)
  assert.equal(rippleOpacity(reactorVisual('listening').intensity), 0.5)
  assert.equal(rippleOpacity(reactorVisual('speaking').intensity), 0.44)
})

// ─── rnColor: the CSS→RN alpha normaliser ────────────────────────────────────

test('[MOB-7a] rnColor gives fractional alpha the leading zero RN needs', () => {
  assert.equal(rnColor('rgba(232,242,255,.97)'), 'rgba(232,242,255,0.97)')
  assert.equal(rnColor('rgba(130,178,255,.34)'), 'rgba(130,178,255,0.34)')
})

test('[MOB-7a] rnColor leaves already-valid colours untouched', () => {
  assert.equal(rnColor('#f2f5f9'), '#f2f5f9')
  assert.equal(rnColor('rgba(0,0,0,0.5)'), 'rgba(0,0,0,0.5)')
  assert.equal(rnColor('rgba(1,2,3,1)'), 'rgba(1,2,3,1)')
})

test('[MOB-7a] every metal/accent token is RN-drawable once normalised', () => {
  // The failure this catches is silent: RN renders an unparseable colour as
  // nothing, so a bad token is an invisible ring, not a crash.
  const ok = /^(#[0-9a-fA-F]{6}|rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*(0|1|0?\.\d+)\s*\))$/
  for (const [k, v] of Object.entries({ ...REACTOR_METAL, logoFill: REACTOR_LOGO_FILL })) {
    assert.match(rnColor(v), ok, `metal token "${k}" is not RN-drawable: ${v}`)
  }
  for (const [k, v] of Object.entries(REACTOR_ACCENT)) {
    assert.match(rnColor(v), ok, `accent "${k}" is not RN-drawable: ${v}`)
  }
})
