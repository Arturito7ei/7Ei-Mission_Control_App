import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseVoiceModeSetting, resolveVoiceMode, selectVoiceProvider,
  DEFAULT_VOICE_MODE, VOICE_MODE_CONFIG_KEY,
} from '../services/voice-config'

test('[B1/S1] parseVoiceModeSetting reads local/provider, else auto', () => {
  assert.equal(parseVoiceModeSetting({ [VOICE_MODE_CONFIG_KEY]: 'local' }), 'local')
  assert.equal(parseVoiceModeSetting({ [VOICE_MODE_CONFIG_KEY]: 'provider' }), 'provider')
  assert.equal(parseVoiceModeSetting({ [VOICE_MODE_CONFIG_KEY]: 'nonsense' }), 'auto')
  assert.equal(parseVoiceModeSetting({}), 'auto')
  assert.equal(parseVoiceModeSetting(null), 'auto')
})

test('[B1/S1] sensitive context is ALWAYS forced local (privacy)', () => {
  const r = resolveVoiceMode({ setting: 'provider', sensitive: true, requested: 'provider' })
  assert.equal(r.mode, 'local')
  assert.equal(r.forcedLocal, true)
})

test('[B1/S1] a per-request override wins over the org default (non-sensitive)', () => {
  assert.equal(resolveVoiceMode({ setting: 'local', sensitive: false, requested: 'provider' }).mode, 'provider')
  assert.equal(resolveVoiceMode({ setting: 'provider', sensitive: false, requested: 'local' }).mode, 'local')
})

test('[B1/S1] falls back to the org default then the code default', () => {
  assert.equal(resolveVoiceMode({ setting: 'provider', sensitive: false }).mode, 'provider')
  assert.equal(resolveVoiceMode({ setting: 'auto', sensitive: false }).mode, DEFAULT_VOICE_MODE)
  assert.equal(resolveVoiceMode({ sensitive: false }).mode, DEFAULT_VOICE_MODE)
})

test('[B1/S1] provider mode picks Chatterbox/NVIDIA when a key is present', () => {
  const r = selectVoiceProvider({ mode: 'provider', caps: { providerKeyPresent: true, localAvailable: false } })
  assert.equal(r.provider, 'chatterbox_nvidia')
  assert.equal(r.degraded, false)
})

test('[B1/S1] provider mode without a key falls back to local, else text-only', () => {
  assert.equal(selectVoiceProvider({ mode: 'provider', caps: { providerKeyPresent: false, localAvailable: true } }).provider, 'local')
  assert.equal(selectVoiceProvider({ mode: 'provider', caps: { providerKeyPresent: false, localAvailable: false } }).provider, 'text_only')
})

test('[B1/S1] local mode NEVER uses cloud — local engine or text-only', () => {
  assert.equal(selectVoiceProvider({ mode: 'local', caps: { providerKeyPresent: true, localAvailable: true } }).provider, 'local')
  const noLocal = selectVoiceProvider({ mode: 'local', caps: { providerKeyPresent: true, localAvailable: false } })
  assert.equal(noLocal.provider, 'text_only') // key present but local mode → never chatterbox
  assert.equal(noLocal.degraded, true)
})
