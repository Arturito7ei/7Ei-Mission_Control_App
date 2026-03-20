// ─── 7Ei Design System ────────────────────────────────────────────────────────
// Sober & minimalist (Notion-inspired) + Glassmorphism accents
// Primary: black / white / silver / Aztec Purple
// Color-blind safe: purple for active (not green), icons always alongside color
// Red (#D4001A) ONLY for errors, warnings, and destructive borders — never for primary actions

export const Palette = {
  // Brand
  black:       '#070707',
  white:       '#ffffff',
  silver:      '#c7c7c7',
  aztecPurple: '#893BFF',
  zeusPurple:  '#700077',
  red:         '#D4001A',   // sparingly — warnings/errors/borders only
  yellow:      '#ffff00',   // warnings (adapted below for readability)
  blue:        '#3500ff',   // info
  green:       '#33c333',   // success — always paired with icon (color-blind safe)
} as const

// ─── Dark Mode ─────────────────────────────────────────────────────────────────
export const Dark = {
  // Backgrounds
  bg:           '#070707',
  surface:      '#0f0f0f',
  surfaceHigh:  '#161616',
  surfaceGlass: 'rgba(15, 15, 15, 0.72)',

  // Borders
  border:       '#1e1e1e',
  borderLight:  '#2a2a2a',
  borderAccent: 'rgba(137, 59, 255, 0.3)',
  borderError:  'rgba(212, 0, 26, 0.4)',
  borderGlass:  'rgba(199, 199, 199, 0.08)',

  // Text
  text:          '#ffffff',
  textSecondary: '#c7c7c7',   // silver
  textMuted:     '#555555',
  textDisabled:  '#333333',

  // Accent — Aztec Purple
  accent:        '#893BFF',
  accentHover:   '#9d5aff',
  accentDim:     'rgba(137, 59, 255, 0.10)',
  accentBorder:  'rgba(137, 59, 255, 0.28)',
  accentGlow:    'rgba(137, 59, 255, 0.18)',

  // Secondary accent — Zeus Purple
  accentSecondary:    '#700077',
  accentSecondaryDim: 'rgba(112, 0, 119, 0.15)',

  // Status — color-blind safe (never red/green alone)
  // Active: purple (not green — red-green colorblind safe)
  statusActive:       '#893BFF',
  statusActiveBg:     'rgba(137, 59, 255, 0.12)',
  statusActiveBorder: 'rgba(137, 59, 255, 0.35)',

  // Idle: silver
  statusIdle:         '#555555',
  statusIdleBg:       'rgba(199, 199, 199, 0.06)',
  statusIdleBorder:   'rgba(199, 199, 199, 0.15)',

  // Done/Success: green — always paired with ✓ icon
  statusDone:         '#33c333',
  statusDoneBg:       'rgba(51, 195, 51, 0.09)',
  statusDoneBorder:   'rgba(51, 195, 51, 0.28)',

  // Warning: yellow — adapted for readability (not pure #ffff00 on dark)
  statusWarning:       '#c9b800',
  statusWarningBg:     'rgba(255, 255, 0, 0.07)',
  statusWarningBorder: 'rgba(255, 255, 0, 0.22)',

  // Error/Blocked: red — always with icon, never sole indicator
  statusError:        '#D4001A',
  statusErrorBg:      'rgba(212, 0, 26, 0.09)',
  statusErrorBorder:  'rgba(212, 0, 26, 0.30)',

  // Info: blue
  statusInfo:         '#7b6dff',
  statusInfoBg:       'rgba(53, 0, 255, 0.10)',
  statusInfoBorder:   'rgba(53, 0, 255, 0.28)',

  // Priority
  priorityHighest:    '#D4001A',
  priorityHigh:       '#c9523a',
  priorityMedium:     '#893BFF',
  priorityLow:        '#7b6dff',
  priorityLowest:     '#444444',

  // Jira status
  jiraToDo:        '#555555',
  jiraInProgress:  '#7b6dff',
  jiraInReview:    '#c9b800',
  jiraDone:        '#33c333',
  jiraBlocked:     '#D4001A',
} as const

// ─── Light Mode ────────────────────────────────────────────────────────────────
export const Light = {
  // Backgrounds
  bg:           '#f5f5f3',
  surface:      '#ffffff',
  surfaceHigh:  '#ebebeb',
  surfaceGlass: 'rgba(255, 255, 255, 0.72)',

  // Borders
  border:       '#e5e5e5',
  borderLight:  '#eeeeee',
  borderAccent: 'rgba(137, 59, 255, 0.22)',
  borderError:  'rgba(212, 0, 26, 0.25)',
  borderGlass:  'rgba(0, 0, 0, 0.07)',

  // Text
  text:          '#070707',
  textSecondary: '#555555',
  textMuted:     '#aaaaaa',
  textDisabled:  '#cccccc',

  // Accent — Zeus Purple on light (slightly darker, better contrast)
  accent:        '#700077',
  accentHover:   '#893BFF',
  accentDim:     'rgba(137, 59, 255, 0.07)',
  accentBorder:  'rgba(137, 59, 255, 0.20)',
  accentGlow:    'rgba(137, 59, 255, 0.12)',

  accentSecondary:    '#893BFF',
  accentSecondaryDim: 'rgba(137, 59, 255, 0.10)',

  // Status
  statusActive:       '#700077',
  statusActiveBg:     'rgba(137, 59, 255, 0.07)',
  statusActiveBorder: 'rgba(137, 59, 255, 0.25)',

  statusIdle:         '#aaaaaa',
  statusIdleBg:       'rgba(0, 0, 0, 0.03)',
  statusIdleBorder:   'rgba(0, 0, 0, 0.10)',

  statusDone:         '#219a21',
  statusDoneBg:       'rgba(33, 154, 33, 0.07)',
  statusDoneBorder:   'rgba(33, 154, 33, 0.22)',

  statusWarning:       '#7a6a00',
  statusWarningBg:     'rgba(160, 140, 0, 0.07)',
  statusWarningBorder: 'rgba(160, 140, 0, 0.22)',

  statusError:        '#D4001A',
  statusErrorBg:      'rgba(212, 0, 26, 0.05)',
  statusErrorBorder:  'rgba(212, 0, 26, 0.20)',

  statusInfo:         '#3500ff',
  statusInfoBg:       'rgba(53, 0, 255, 0.05)',
  statusInfoBorder:   'rgba(53, 0, 255, 0.18)',

  // Priority
  priorityHighest:    '#D4001A',
  priorityHigh:       '#c9523a',
  priorityMedium:     '#700077',
  priorityLow:        '#3500ff',
  priorityLowest:     '#bbbbbb',

  // Jira
  jiraToDo:        '#aaaaaa',
  jiraInProgress:  '#3500ff',
  jiraInReview:    '#7a6a00',
  jiraDone:        '#219a21',
  jiraBlocked:     '#D4001A',
} as const

// ─── Shared constants ─────────────────────────────────────────────────────────
export const Radius = {
  xs:  4,
  sm:  6,
  md:  8,
  lg:  12,
  xl:  16,
  xxl: 24,
  pill: 999,
} as const

export const Space = {
  xs:  4,
  sm:  8,
  md:  12,
  lg:  16,
  xl:  24,
  xxl: 32,
  xxxl: 48,
} as const

export const FontSize = {
  xs:   11,
  sm:   12,
  md:   13,
  base: 14,
  lg:   15,
  xl:   17,
  xxl:  20,
  xxxl: 26,
  huge: 32,
} as const

export const FontWeight = {
  regular:  '400' as const,
  medium:   '500' as const,
  semibold: '600' as const,
  bold:     '700' as const,
  heavy:    '800' as const,
}

export const Blur = {
  sm: 8,
  md: 16,
  lg: 24,
} as const

// ─── Convenience re-export: use Dark as default (app is dark-first) ─────────
export const Colors = Dark
