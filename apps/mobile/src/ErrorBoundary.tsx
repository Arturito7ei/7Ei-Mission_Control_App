// Top-level error boundary — the difference between a diagnosis and a white screen.
//
// WHY THIS EXISTS: a React render error anywhere in the tree unmounts the WHOLE
// tree. With no boundary, what the operator sees is a blank white screen — white
// specifically because none of our own surfaces (all of which paint theme.bg,
// #0B1220) ever mounted. The error itself is real and it IS printed to the Metro
// terminal, but on the phone it is invisible, so a crash-on-mount is indis-
// tinguishable from a hang, a bad bundle, or a dead backend. That ambiguity cost
// a whole debugging session once; this class buys it back permanently.
//
// The fallback deliberately depends on NOTHING but react-native core + theme
// constants:
//   • not SafeAreaProvider — it sits ABOVE it in App.tsx, because a provider that
//     throws is exactly the case we must still render for. Hence the hand-rolled
//     top padding instead of insets.
//   • not ui.tsx — fewer modules in the fallback path, fewer ways for the screen
//     that reports the crash to itself crash.
//
// It catches RENDER-phase errors only. That is the failure mode that produces the
// silent white screen; an async rejection already surfaces in the Metro terminal
// and does not blank the UI.

import React from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { font, radius, space, theme } from './theme'

type Props = { children: React.ReactNode }
type State = { error: Error | null; componentStack: string | null }

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, componentStack: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    // The component stack names the component that threw, which a bare message
    // ("undefined is not an object") almost never does. Keep both.
    this.setState({ componentStack: info?.componentStack ?? null })
    // Mirror to the Metro terminal so the operator can copy it from a real
    // console rather than retyping it off a phone screen.
    console.error('[7Ei] Fatal render error:', error, info?.componentStack ?? '')
  }

  render() {
    const { error, componentStack } = this.state
    if (!error) return this.props.children

    return (
      <View style={s.root}>
        <ScrollView contentContainerStyle={s.wrap}>
          <Text style={s.title}>Something crashed on mount</Text>
          <Text style={s.sub}>
            The app caught a render error instead of showing a blank screen. Send this to the
            dev — it is the whole diagnosis.
          </Text>

          <Text style={s.h}>Error</Text>
          <Text style={s.mono} selectable>
            {String(error?.message || error)}
          </Text>

          {error?.stack ? (
            <>
              <Text style={s.h}>Stack</Text>
              <Text style={s.mono} selectable>
                {error.stack}
              </Text>
            </>
          ) : null}

          {componentStack ? (
            <>
              <Text style={s.h}>Component stack</Text>
              <Text style={s.mono} selectable>
                {componentStack}
              </Text>
            </>
          ) : null}
        </ScrollView>
      </View>
    )
  }
}

const s = StyleSheet.create({
  // paddingTop clears the notch by hand: SafeAreaProvider may be the thing that threw.
  root: { flex: 1, backgroundColor: theme.bg, paddingTop: 64 },
  wrap: { padding: space.lg, paddingBottom: space.xxl },
  title: { color: theme.vermillion, fontSize: font.xl, fontWeight: '800' },
  sub: { color: theme.textDim, fontSize: font.sm, marginTop: space.xs, lineHeight: 18 },
  h: { color: theme.text, fontSize: font.base, fontWeight: '700', marginTop: space.xl },
  mono: {
    marginTop: space.sm,
    color: theme.text,
    fontSize: font.sm - 1,
    // Platform-agnostic: 'monospace' resolves to Menlo on iOS, Roboto Mono on Android.
    fontFamily: 'monospace',
    backgroundColor: theme.s1,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: theme.s3,
    padding: space.md,
    lineHeight: 17,
  },
})
