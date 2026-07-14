import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AVATAR_MAX_EDGE, encodeType, isAcceptedUpload, scaleDims } from './avatarImage.ts'

test('[AG5] scaleDims fits the longest edge into the square, preserving aspect ratio', () => {
  assert.deepEqual(scaleDims(1024, 512, 256), { width: 256, height: 128 })
  assert.deepEqual(scaleDims(512, 1024, 256), { width: 128, height: 256 })
  assert.deepEqual(scaleDims(1000, 1000, 256), { width: 256, height: 256 })
})

test('[AG5] scaleDims never upscales a small image', () => {
  assert.deepEqual(scaleDims(64, 64, 256), { width: 64, height: 64 })
  assert.deepEqual(scaleDims(200, 100, 256), { width: 200, height: 100 })
})

test('[AG5] scaleDims rounds to whole pixels and never returns zero for a real image', () => {
  const { width, height } = scaleDims(1001, 3, 256)
  assert.equal(width, 256)
  assert.equal(height, 1) // would round to 0 — clamped to 1 so the canvas is drawable
  assert.ok(Number.isInteger(width) && Number.isInteger(height))
})

test('[AG5] scaleDims is safe for degenerate input', () => {
  assert.deepEqual(scaleDims(0, 0, 256), { width: 0, height: 0 })
  assert.deepEqual(scaleDims(-5, 10, 256), { width: 0, height: 0 })
  assert.deepEqual(scaleDims(NaN, 10, 256), { width: 0, height: 0 })
})

test('[AG5] the default max edge covers every place an avatar renders', () => {
  assert.equal(AVATAR_MAX_EDGE, 256)
})

test('[AG5] encodeType prefers WebP and falls back to JPEG', () => {
  assert.equal(encodeType(true), 'image/webp')
  assert.equal(encodeType(false), 'image/jpeg')
})

test('[AG5] isAcceptedUpload matches the backend allowlist and refuses SVG', () => {
  for (const t of ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'IMAGE/PNG']) {
    assert.equal(isAcceptedUpload(t), true, t)
  }
  for (const t of ['image/svg+xml', 'application/pdf', 'text/html', '', null, undefined]) {
    assert.equal(isAcceptedUpload(t), false, String(t))
  }
})
