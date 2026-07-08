'use client'
// Arturita J1 — the reactive orb / HUD. Reflects the voice pipeline's state
// (idle / listening / thinking / speaking) with a distinct color + icon + label
// + motion (colorblind-safe; see assistant.logic orbVisual). Continuous motion
// is the deliberate living-UI exception, disabled under prefers-reduced-motion
// via globals.css. Pure visuals — state comes in as a prop.
import { tk, text, space } from './tokens'
import { orbVisual, type VoiceState } from './assistant.logic'

export default function AssistantOrb({ state, size = 168, logoSrc }: { state: VoiceState; size?: number; logoSrc: string }) {
  const v = orbVisual(state)
  const core = Math.round(size * 0.52)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: space.md }}>
      <div
        className="mc-orb"
        data-motion={v.motion}
        aria-hidden
        style={{ width: size, height: size, ['--orb-color' as any]: v.colorVar }}
      >
        {/* expanding rings (listening/speaking) */}
        <div className="mc-orb-ring" style={{ width: size, height: size }} />
        <div className="mc-orb-ring" style={{ width: size * 0.8, height: size * 0.8, opacity: 0.18 }} />
        {/* core with the 7Ei mark floated on top (crisp white honeycomb vector) */}
        <div className="mc-orb-core" style={{ width: core, height: core, display: 'grid', placeItems: 'center' }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={logoSrc}
            alt="7Ei — Arturita"
            width={Math.round(core * 0.62)}
            height={Math.round(core * 0.62)}
            style={{ opacity: 0.97, filter: 'drop-shadow(0 1px 3px rgba(0,0,0,.4))' }}
          />
        </div>
      </div>
      {/* state read-out — icon + text so it's never color-only, announced politely */}
      <div role="status" aria-live="polite" style={{ display: 'flex', alignItems: 'center', gap: space.sm }}>
        <span aria-hidden style={{ color: v.colorVar, fontSize: 15, lineHeight: 1 }}>{v.icon}</span>
        <span style={{ fontSize: text.sm.fontSize, fontWeight: 700, letterSpacing: 0.4, color: state === 'idle' ? tk.muted : tk.text, textTransform: 'uppercase' }}>
          {v.label}
        </span>
      </div>
    </div>
  )
}
