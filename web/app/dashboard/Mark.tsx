// MCA-86 — 7Ei brand mark: 7 hexagons, honeycomb cluster (inline mirror of
// public/7ei-mark.svg). Uses currentColor so it follows --text: white on dark,
// black on light. Keep ≥8px clear space around it (brand rule).
import type { SVGProps } from 'react'

export default function Mark({ size = 22, ...props }: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="currentColor" role="img" aria-label="7Ei" {...props}>
      <path d="M43.5 8.74 56.5 8.74 63 20 56.5 31.26 43.5 31.26 37 20Z" />
      <path d="M17.52 23.74 30.52 23.74 37.02 35 30.52 46.26 17.52 46.26 11.02 35Z" />
      <path d="M69.48 23.74 82.48 23.74 88.98 35 82.48 46.26 69.48 46.26 62.98 35Z" />
      <path d="M43.5 38.74 56.5 38.74 63 50 56.5 61.26 43.5 61.26 37 50Z" />
      <path d="M17.52 53.74 30.52 53.74 37.02 65 30.52 76.26 17.52 76.26 11.02 65Z" />
      <path d="M69.48 53.74 82.48 53.74 88.98 65 82.48 76.26 69.48 76.26 62.98 65Z" />
      <path d="M43.5 68.74 56.5 68.74 63 80 56.5 91.26 43.5 91.26 37 80Z" />
    </svg>
  )
}
