// Small shared UI primitives so screens stay declarative. Colorblind-safe: every
// status uses a label + glyph, never hue alone.

import React from 'react'
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native'
import { font, radius, space, theme } from './theme'

export function Card({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[s.card, style]}>{children}</View>
}

export function Chip({
  label,
  tone = 'info',
  glyph,
}: {
  label: string
  tone?: 'info' | 'ok' | 'warn' | 'danger' | 'delegate' | 'neutral'
  glyph?: string
}) {
  const color =
    tone === 'ok'
      ? theme.green
      : tone === 'warn'
        ? theme.orange
        : tone === 'danger'
          ? theme.vermillion
          : tone === 'delegate'
            ? theme.purple
            : tone === 'neutral'
              ? theme.textFaint
              : theme.blue
  return (
    <View style={[s.chip, { borderColor: color }]}>
      <Text style={[s.chipText, { color }]}>
        {glyph ? `${glyph} ` : ''}
        {label}
      </Text>
    </View>
  )
}

export function Button({
  title,
  onPress,
  tone = 'primary',
  busy,
  disabled,
}: {
  title: string
  onPress: () => void
  tone?: 'primary' | 'ok' | 'danger' | 'ghost'
  busy?: boolean
  disabled?: boolean
}) {
  const bg =
    tone === 'ok'
      ? theme.green
      : tone === 'danger'
        ? theme.vermillion
        : tone === 'ghost'
          ? 'transparent'
          : theme.blue
  const fg = tone === 'ghost' ? theme.text : '#08131F'
  const off = disabled || busy
  return (
    <Pressable
      accessibilityRole="button"
      onPress={off ? undefined : onPress}
      style={({ pressed }) => [
        s.btn,
        { backgroundColor: bg, opacity: off ? 0.5 : pressed ? 0.85 : 1 },
        tone === 'ghost' && { borderWidth: 1, borderColor: theme.s3 },
      ]}
    >
      {busy ? (
        <ActivityIndicator color={fg} />
      ) : (
        <Text style={[s.btnText, { color: fg }]}>{title}</Text>
      )}
    </Pressable>
  )
}

export function Banner({ kind, children }: { kind: 'error' | 'info' | 'ok'; children: React.ReactNode }) {
  const c = kind === 'error' ? theme.vermillion : kind === 'ok' ? theme.green : theme.blue
  const glyph = kind === 'error' ? '⚠' : kind === 'ok' ? '✓' : 'ℹ'
  return (
    <View style={[s.banner, { borderColor: c }]}>
      <Text style={[s.bannerText, { color: c }]}>
        {glyph}  {children}
      </Text>
    </View>
  )
}

export function Empty({ text }: { text: string }) {
  return (
    <View style={s.empty}>
      <Text style={s.emptyText}>{text}</Text>
    </View>
  )
}

export function Loading({ text }: { text?: string }) {
  return (
    <View style={s.empty}>
      <ActivityIndicator color={theme.blue} />
      {text ? <Text style={[s.emptyText, { marginTop: space.sm }]}>{text}</Text> : null}
    </View>
  )
}

const s = StyleSheet.create({
  card: {
    backgroundColor: theme.s1,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: theme.s3,
    padding: space.lg,
  },
  chip: {
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: 3,
    alignSelf: 'flex-start',
  },
  chipText: { fontSize: font.sm - 1, fontWeight: '600' },
  btn: {
    borderRadius: radius.md,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 46,
  },
  btnText: { fontSize: font.base, fontWeight: '700' },
  banner: {
    borderWidth: 1,
    borderRadius: radius.md,
    padding: space.md,
    backgroundColor: theme.s1,
  },
  bannerText: { fontSize: font.sm, fontWeight: '600' },
  empty: { padding: space.xl, alignItems: 'center', justifyContent: 'center' },
  emptyText: { color: theme.textDim, fontSize: font.base, textAlign: 'center' },
})
