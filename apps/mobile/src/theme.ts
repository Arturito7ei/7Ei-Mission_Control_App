// Colorblind-safe theme for the 7Ei MC iPhone remote.
//
// Status is NEVER encoded by hue alone. The accent palette is the Okabe–Ito
// colorblind-safe set (distinguishable under protan/deutan/tritan), and every
// status also carries a text label + glyph — so an approve/reject decision is
// never "the green one vs the red one". Dark surface, high-contrast text.

export const theme = {
  // Surfaces (dark, matches the web dark default)
  bg: '#0B1220', // page
  s1: '#141C2B', // card
  s2: '#1E2838', // raised / input
  s3: '#2A3648', // border / divider
  // Text
  text: '#EAF0F8',
  textDim: '#9BA9BE',
  textFaint: '#6B7A90',
  // Okabe–Ito accents (colorblind-safe)
  blue: '#4EA3E6', // primary / links / "answer"
  orange: '#E69F00', // attention / pending
  vermillion: '#E06A4E', // reject / danger (distinct from orange in lightness)
  green: '#009E73', // healthy / approve (paired with a ✓ glyph, never alone)
  purple: '#B07AD6', // delegate / routing
  yellow: '#E6C84E', // warning
  // Semantic (each is also given a label + icon in the UI)
  ok: '#009E73',
  warn: '#E69F00',
  danger: '#E06A4E',
  info: '#4EA3E6',
} as const

export type Theme = typeof theme

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const
export const radius = { sm: 6, md: 10, lg: 14, pill: 999 } as const
export const font = { sm: 13, base: 15, lg: 18, xl: 22, xxl: 28 } as const
