// MOB-7a — the Command Center "reactor" on the phone: the brushed-silver
// Jarvis-style arc-reactor HUD, mirroring web/app/dashboard/Reactor.tsx.
//
// Same split as the web: this is a PURE VISUAL SHELL. The voice state arrives as a
// prop and every DECISION about how it looks/reads lives in ../reactor, which is
// pinned to the web's own module (and to globals.css) by ../reactor.test.ts.
//
// WHAT DIFFERS FROM THE WEB, AND WHY:
//   * The web spins four <g> groups inside ONE <svg> with CSS animations. RN has
//     no CSS, and react-native-svg elements aren't Animated-driveable — so each
//     rotating ring is its OWN absolutely-positioned <Svg> inside an Animated.View.
//     Same geometry (a 200×200 view box, same radii), same periods, and rotation
//     stays on the native driver so it never competes with the JS thread.
//   * The core is a real radial gradient (<RadialGradient>) rather than CSS
//     `radial-gradient`, at the same stops. The web's frosted `backdrop-filter`
//     behind the mark has no RN peer — see the honest note at the hex below.
//
// BOOT SAFETY (#297): react-native-svg is pulled through lazyNativeModule at first
// RENDER, never at module scope. It ships inside Expo Go on SDK 54 so this should
// always resolve — but "should" is exactly what the white-screen class was made
// of. A host without it loses the metal, not the app: the caption and chips carry
// the state on their own (icon + label), which is the colorblind rule already.

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { AccessibilityInfo, Animated, Easing, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
// TYPE-only: erased at compile time, so it cannot drag the native module into the
// boot path. The value comes through getSvg() below, at render.
import type * as SvgNS from 'react-native-svg'
import { lazyNativeModule } from '../nativeModule'
import {
  REACTOR_HEADLINE,
  REACTOR_LOGO_FILL,
  REACTOR_METAL,
  RING_MULT,
  RIPPLE_DELAY_MS,
  RIPPLE_MS,
  coreMotion,
  reactorAccent,
  reactorVisual,
  ringDurationMs,
  rippleOpacity,
  ripplesVisible,
  rnColor,
  type StatusChip,
  type VoiceState,
} from '../reactor'
import { font, radius, space, theme } from '../theme'

const getSvg = lazyNativeModule('react-native-svg', () => require('react-native-svg') as typeof SvgNS)

// The 7Ei mark (7-hexagon honeycomb) — the same vector as the web's Reactor.tsx
// HEX_PATHS, which is the same as /7ei-mark.svg. Copied verbatim: a redrawn logo
// is a different logo.
const HEX_PATHS = [
  'M43.5 8.74 56.5 8.74 63 20 56.5 31.26 43.5 31.26 37 20Z',
  'M17.52 23.74 30.52 23.74 37.02 35 30.52 46.26 17.52 46.26 11.02 35Z',
  'M69.48 23.74 82.48 23.74 88.98 35 82.48 46.26 69.48 46.26 62.98 35Z',
  'M43.5 38.74 56.5 38.74 63 50 56.5 61.26 43.5 61.26 37 50Z',
  'M17.52 53.74 30.52 53.74 37.02 65 30.52 76.26 17.52 76.26 11.02 65Z',
  'M69.48 53.74 82.48 53.74 88.98 65 82.48 76.26 69.48 76.26 62.98 65Z',
  'M43.5 68.74 56.5 68.74 63 80 56.5 91.26 43.5 91.26 37 80Z',
]

/** The web sizes the assembly `min(340px, 82vw)`. Same rule, RN units. */
const DEFAULT_SIZE = 340
const VIEWPORT_FRACTION = 0.82

/**
 * A ring that rotates forever at a fixed period. One Animated.View per ring is
 * what buys us the web's counter-rotation without a stylesheet.
 *
 * `paused` (reduced motion) holds it at 0deg rather than unmounting it: the metal
 * is state-independent, so a still reactor is correct — an absent one isn't.
 */
function SpinningRing({
  durationMs, direction, paused, children,
}: {
  durationMs: number
  direction: 'cw' | 'ccw'
  paused: boolean
  children: React.ReactNode
}) {
  const spin = useRef(new Animated.Value(0)).current

  useEffect(() => {
    spin.setValue(0)
    if (paused) return
    const loop = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: durationMs,
        easing: Easing.linear,   // a constant rate — the web's `linear infinite`
        useNativeDriver: true,
      }),
    )
    loop.start()
    return () => loop.stop()
  }, [spin, durationMs, paused])

  const rotate = spin.interpolate({
    inputRange: [0, 1],
    outputRange: direction === 'cw' ? ['0deg', '360deg'] : ['0deg', '-360deg'],
  })

  return <Animated.View style={[StyleSheet.absoluteFill, { transform: [{ rotate }] }]}>{children}</Animated.View>
}

/** One expanding ripple ring — the web's `mcReactorRipple`, scale 1→1.9, fade to 0. */
function Ripple({ accent, intensity, delayMs }: { accent: string; intensity: number; delayMs: number }) {
  const t = useRef(new Animated.Value(0)).current

  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(t, {
        toValue: 1,
        duration: RIPPLE_MS,
        delay: delayMs,          // the web's `.mc-reactor-ripple-2 { animation-delay }`
        easing: Easing.out(Easing.ease),
        useNativeDriver: true,
      }),
    )
    loop.start()
    return () => loop.stop()
  }, [t, delayMs])

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        s.ripple,
        {
          borderColor: accent,
          opacity: t.interpolate({ inputRange: [0, 1], outputRange: [rippleOpacity(intensity), 0] }),
          transform: [{ scale: t.interpolate({ inputRange: [0, 1], outputRange: [1, 1.9] }) }],
        },
      ]}
    />
  )
}

export default function Reactor({
  state, size = DEFAULT_SIZE, chips = [],
}: { state: VoiceState; size?: number; chips?: StatusChip[] }) {
  const v = reactorVisual(state)
  const Svg = getSvg()
  const { width } = useWindowDimensions()
  // The web's `min(340px, 82vw)`, in RN units.
  const box = Math.min(size, Math.round(width * VIEWPORT_FRACTION))
  const accent = reactorAccent(v.accentVar)
  const core = coreMotion(v.motion)

  // The web disables all of this under prefers-reduced-motion, where the state
  // still reads from the caption's icon + label. Same contract here.
  const [reduceMotion, setReduceMotion] = useState(false)
  useEffect(() => {
    let alive = true
    AccessibilityInfo.isReduceMotionEnabled()
      .then((on) => { if (alive) setReduceMotion(on) })
      .catch(() => { /* unknown → keep motion; the caption carries the state regardless */ })
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion)
    return () => { alive = false; sub?.remove?.() }
  }, [])

  const showRipples = ripplesVisible(v.motion) && !reduceMotion

  // ── The core's breathe/pulse ───────────────────────────────────────────────
  const pulse = useRef(new Animated.Value(0)).current
  useEffect(() => {
    pulse.setValue(0)
    if (reduceMotion) return
    const loop = Animated.loop(
      core.kind === 'breathe'
        // `0%,100% { scale(1) opacity(.92) } 50% { scale(1.045) opacity(1) }`
        ? Animated.sequence([
            Animated.timing(pulse, { toValue: 1, duration: core.durationMs / 2, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
            Animated.timing(pulse, { toValue: 0, duration: core.durationMs / 2, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
          ])
        // `0%,100% { scale(1) } 30% { scale(1.09) } 55% { scale(.985) }` — one pass,
        // interpolated at the keyframe stops below.
        : Animated.timing(pulse, { toValue: 1, duration: core.durationMs, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
    )
    loop.start()
    return () => loop.stop()
  }, [pulse, core.kind, core.durationMs, reduceMotion])

  const coreScale = core.kind === 'breathe'
    ? pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.045] })
    : pulse.interpolate({ inputRange: [0, 0.3, 0.55, 1], outputRange: [1, 1.09, 0.985, 1] })
  const coreOpacity = core.kind === 'breathe'
    ? pulse.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1] })
    : 1

  // Ring periods: the state's base spin, scaled per ring (../reactor).
  const dur = useMemo(() => ({
    outer: ringDurationMs(v.spinSec, RING_MULT.outer),
    midFull: ringDurationMs(v.spinSec, RING_MULT.midFull),
    gyro: ringDurationMs(v.spinSec, RING_MULT.gyro),
    accent: ringDurationMs(v.spinSec, RING_MULT.accent),
  }), [v.spinSec])

  return (
    <View style={s.wrap}>
      <View style={[s.assembly, { width: box, height: box }]} accessibilityElementsHidden importantForAccessibility="no">
        {Svg ? (
          <>
            {/* Outer bloom behind the metal — the web's blurred radial glow. RN has
                no blur primitive without a native dep, so the softness comes from
                the gradient's own falloff rather than a filter. */}
            <View style={s.bloom} pointerEvents="none">
              <Svg.Svg width="100%" height="100%" viewBox="0 0 200 200">
                <Svg.Defs>
                  <Svg.RadialGradient id="rkBloom" cx="50%" cy="50%" r="50%">
                    <Svg.Stop offset="0%" stopColor={rnColor(REACTOR_METAL.glow)} />
                    <Svg.Stop offset="66%" stopColor={rnColor(REACTOR_METAL.glow)} stopOpacity="0" />
                  </Svg.RadialGradient>
                </Svg.Defs>
                <Svg.Circle cx="100" cy="100" r="100" fill="url(#rkBloom)" />
              </Svg.Svg>
            </View>

            {/* Outer fixed rail (thin, full) — the machined outer edge. */}
            <Svg.Svg style={StyleSheet.absoluteFill} viewBox="0 0 200 200">
              <Svg.Defs>
                <Svg.LinearGradient id="rkSilverA" x1="0" y1="0" x2="1" y2="1">
                  <Svg.Stop offset="0%" stopColor={REACTOR_METAL.silver1} />
                  <Svg.Stop offset="24%" stopColor={REACTOR_METAL.silver3} />
                  <Svg.Stop offset="50%" stopColor={REACTOR_METAL.silver1} />
                  <Svg.Stop offset="72%" stopColor={REACTOR_METAL.silver4} />
                  <Svg.Stop offset="100%" stopColor={REACTOR_METAL.silver2} />
                </Svg.LinearGradient>
              </Svg.Defs>
              <Svg.Circle cx="100" cy="100" r="96" fill="none" stroke={REACTOR_METAL.silverEdge} strokeWidth="1" opacity="0.6" />
              <Svg.Circle cx="100" cy="100" r="93" fill="none" stroke="url(#rkSilverA)" strokeWidth="3.5" />
            </Svg.Svg>

            {/* Outer segmented ring — thick brushed band, big dashes with gaps (CW). */}
            <SpinningRing durationMs={dur.outer} direction="cw" paused={reduceMotion}>
              <Svg.Svg style={StyleSheet.absoluteFill} viewBox="0 0 200 200">
                <Svg.Defs>
                  <Svg.LinearGradient id="rkSilverB" x1="0" y1="1" x2="1" y2="0">
                    <Svg.Stop offset="0%" stopColor={REACTOR_METAL.silver2} />
                    <Svg.Stop offset="30%" stopColor={REACTOR_METAL.silver1} />
                    <Svg.Stop offset="58%" stopColor={REACTOR_METAL.silver4} />
                    <Svg.Stop offset="100%" stopColor={REACTOR_METAL.silver2} />
                  </Svg.LinearGradient>
                </Svg.Defs>
                <Svg.Circle cx="100" cy="100" r="83" fill="none" stroke="url(#rkSilverB)" strokeWidth="9"
                  strokeDasharray="118 40" strokeLinecap="round" />
                <Svg.Circle cx="100" cy="100" r="83" fill="none" stroke={REACTOR_METAL.silverEdge} strokeWidth="9"
                  strokeDasharray="2 74" strokeDashoffset="20" opacity="0.5" />
              </Svg.Svg>
            </SpinningRing>

            {/* Mid full band (very slow CCW) — the solid brushed ring. */}
            <SpinningRing durationMs={dur.midFull} direction="ccw" paused={reduceMotion}>
              <Svg.Svg style={StyleSheet.absoluteFill} viewBox="0 0 200 200">
                <Svg.Defs>
                  <Svg.LinearGradient id="rkSilverA2" x1="0" y1="0" x2="1" y2="1">
                    <Svg.Stop offset="0%" stopColor={REACTOR_METAL.silver1} />
                    <Svg.Stop offset="24%" stopColor={REACTOR_METAL.silver3} />
                    <Svg.Stop offset="50%" stopColor={REACTOR_METAL.silver1} />
                    <Svg.Stop offset="72%" stopColor={REACTOR_METAL.silver4} />
                    <Svg.Stop offset="100%" stopColor={REACTOR_METAL.silver2} />
                  </Svg.LinearGradient>
                </Svg.Defs>
                <Svg.Circle cx="100" cy="100" r="70" fill="none" stroke="url(#rkSilverA2)" strokeWidth="7" />
                <Svg.Circle cx="100" cy="100" r="66.5" fill="none" stroke={REACTOR_METAL.silverEdge} strokeWidth="1" opacity="0.7" />
              </Svg.Svg>
            </SpinningRing>

            {/* Mid gyroscope ring — segmented with gaps (CCW, medium). */}
            <SpinningRing durationMs={dur.gyro} direction="ccw" paused={reduceMotion}>
              <Svg.Svg style={StyleSheet.absoluteFill} viewBox="0 0 200 200">
                <Svg.Defs>
                  <Svg.LinearGradient id="rkSilverB2" x1="0" y1="1" x2="1" y2="0">
                    <Svg.Stop offset="0%" stopColor={REACTOR_METAL.silver2} />
                    <Svg.Stop offset="30%" stopColor={REACTOR_METAL.silver1} />
                    <Svg.Stop offset="58%" stopColor={REACTOR_METAL.silver4} />
                    <Svg.Stop offset="100%" stopColor={REACTOR_METAL.silver2} />
                  </Svg.LinearGradient>
                </Svg.Defs>
                <Svg.Circle cx="100" cy="100" r="58" fill="none" stroke="url(#rkSilverB2)" strokeWidth="4.5"
                  strokeDasharray="44 26" strokeLinecap="round" />
              </Svg.Svg>
            </SpinningRing>

            {/* Inner accent ring — thin, tinted by the state accent (CW, fastest). */}
            <SpinningRing durationMs={dur.accent} direction="cw" paused={reduceMotion}>
              <Svg.Svg style={StyleSheet.absoluteFill} viewBox="0 0 200 200">
                <Svg.Circle cx="100" cy="100" r="50" fill="none" stroke={accent} strokeWidth="1.5"
                  strokeDasharray="10 16" opacity="0.85" />
              </Svg.Svg>
            </SpinningRing>

            {/* Listening/speaking ripples — expanding rings that read as audio energy. */}
            {showRipples ? (
              <>
                <Ripple accent={accent} intensity={v.intensity} delayMs={0} />
                <Ripple accent={accent} intensity={v.intensity} delayMs={RIPPLE_DELAY_MS} />
              </>
            ) : null}

            {/* Translucent glowing core with the honeycomb floated at its centre. */}
            <Animated.View
              style={[s.core, { transform: [{ scale: coreScale }], opacity: coreOpacity }]}
              pointerEvents="none"
            >
              <Svg.Svg style={StyleSheet.absoluteFill} viewBox="0 0 100 100">
                <Svg.Defs>
                  {/* The web's `radial-gradient(circle at 50% 46%, core1 0%, core2 46%, core3 74%, transparent 100%)`. */}
                  <Svg.RadialGradient id="rkCore" cx="50%" cy="46%" r="54%">
                    <Svg.Stop offset="0%" stopColor={rnColor(REACTOR_METAL.core1)} />
                    <Svg.Stop offset="46%" stopColor={rnColor(REACTOR_METAL.core2)} />
                    <Svg.Stop offset="74%" stopColor={rnColor(REACTOR_METAL.core3)} />
                    <Svg.Stop offset="100%" stopColor={rnColor(REACTOR_METAL.core3)} stopOpacity="0" />
                  </Svg.RadialGradient>
                </Svg.Defs>
                <Svg.Circle cx="50" cy="50" r="50" fill="url(#rkCore)" />
              </Svg.Svg>
              {/* The mark. The web frosts a glass disc behind it with backdrop-filter,
                  which RN has no peer for without a native blur dep — so the mark
                  relies on its own contrast against the icy core instead, which is
                  exactly why REACTOR_LOGO_FILL takes the web's LIGHT (black) token.
                  See ../reactor. */}
              <View style={s.hex} pointerEvents="none">
                <Svg.Svg width="100%" height="100%" viewBox="0 0 100 100">
                  {HEX_PATHS.map((d, i) => <Svg.Path key={i} d={d} fill={REACTOR_LOGO_FILL} />)}
                </Svg.Svg>
              </View>
            </Animated.View>
          </>
        ) : null}
      </View>

      {/* ── Status caption (mirrors the reference HUD) — colorblind-safe ─────── */}
      <View
        accessibilityRole="text"
        accessibilityLiveRegion="polite"
        // One announcement, not four fragments: a screen reader should hear the
        // state, not the punctuation.
        accessibilityLabel={`${REACTOR_HEADLINE}. ${v.caption}`}
        style={s.caption}
      >
        <Text style={s.headline}>{REACTOR_HEADLINE}</Text>
        <View style={s.stateRow}>
          <Text style={[s.stateIcon, { color: accent }]}>{v.icon}</Text>
          <Text style={[s.stateText, { color: state === 'idle' ? theme.textDim : theme.text }]}>
            {v.caption}
          </Text>
        </View>
        {chips.length > 0 ? (
          <View style={s.chips}>
            {chips.map((c) => (
              <View key={c.key} style={s.chip}>
                <Text style={s.chipText}>
                  {c.icon} {c.label}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
      </View>
    </View>
  )
}

const s = StyleSheet.create({
  wrap: { alignItems: 'center', gap: space.lg },
  assembly: { alignItems: 'center', justifyContent: 'center' },
  // The web's `.mc-reactor-bloom { width: 88%; height: 88% }`.
  bloom: { position: 'absolute', width: '88%', height: '88%' },
  // The web's `.mc-reactor-core { width: 46%; height: 46% }`.
  core: {
    position: 'absolute',
    width: '46%',
    height: '46%',
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: theme.s3,
  },
  // The web's `.mc-reactor-hex { width: 64% }` — of the core.
  hex: { width: '64%', aspectRatio: 1 },
  // The web's `.mc-reactor-ripple { width: 46%; height: 46% }`.
  ripple: { position: 'absolute', width: '46%', height: '46%', borderRadius: 999, borderWidth: 1.5 },
  caption: { alignItems: 'center', gap: space.sm },
  headline: { fontSize: font.sm - 2, letterSpacing: 2, color: theme.textFaint, fontWeight: '700' },
  stateRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  stateIcon: { fontSize: 16, lineHeight: 18 },
  stateText: { fontSize: 15, fontWeight: '800', letterSpacing: 1.2 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: space.sm, marginTop: space.xs },
  chip: {
    borderWidth: 1,
    borderColor: theme.s3,
    backgroundColor: theme.s1,
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  chipText: { fontSize: font.sm - 2, fontWeight: '600', color: theme.textDim },
})
