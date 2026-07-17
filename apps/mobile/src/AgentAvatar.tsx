// MOB-7c — the agent avatar, mirrored from the web's `AgentAvatar`
// (web/app/dashboard/agent/shared.tsx:39-51): the uploaded picture when there is
// one (a data URI in `avatarUrl`, gated by avatar.ts), else the emoji in a
// matching rounded box.
//
// Two things the web doesn't need but the phone does:
//   * a SAFETY gate on the URI (avatar.ts) — the web trusts its write path; the
//     phone re-checks before handing the value to <Image>.
//   * an onError FALLBACK — a stored value can be well-formed and still fail to
//     decode (or 404 on a future blob-store swap). The web's <img> would show a
//     broken-image box; the phone falls back to the emoji instead.
//
// The box matches the web's: a rounded square on `surfaceHigh` with a hairline
// border, so a picture and an emoji sit in the same frame and the roster doesn't
// jump when one agent has a photo and the next doesn't. `alt`/label is empty
// (decorative): every caller renders the agent's name right beside it.
//
// This file imports react-native, so NO test loads it (node --test / bootSafety):
// the logic that IS pinned lives in the dep-free avatar.ts.

import React, { useState } from 'react'
import { Image, StyleSheet, Text, View } from 'react-native'
import { avatarEmoji, avatarImageUri, type AvatarInput } from './avatar'
import { theme } from './theme'

export function AgentAvatar({
  agent,
  size = 40,
  round,
}: {
  agent: AvatarInput
  size?: number
  /** Corner radius; defaults to size/4, matching the web's rounded square. */
  round?: number
}) {
  // A picture that fails to load falls back to the emoji for the rest of this
  // mount — retrying a broken URI on every render just flickers the box.
  const [failed, setFailed] = useState(false)
  const r = round ?? Math.round(size / 4)
  const uri = failed ? null : avatarImageUri(agent)

  if (uri) {
    return (
      <Image
        source={{ uri }}
        onError={() => setFailed(true)}
        resizeMode="cover"
        accessible={false}
        accessibilityIgnoresInvertColors
        style={{
          width: size,
          height: size,
          borderRadius: r,
          backgroundColor: theme.s2,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: theme.s3,
        }}
      />
    )
  }

  return (
    <View
      accessible={false}
      style={{
        width: size,
        height: size,
        borderRadius: r,
        overflow: 'hidden',
        backgroundColor: theme.s2,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.s3,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text style={{ fontSize: Math.round(size * 0.55), lineHeight: Math.round(size * 0.72) }}>
        {avatarEmoji(agent)}
      </Text>
    </View>
  )
}
