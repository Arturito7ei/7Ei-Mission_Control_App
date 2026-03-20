# 7Ei Design System

**Version:** 1.0.0 · Sprint 10  
**Philosophy:** Sober and minimalist (Notion-inspired) + controlled Glassmorphism  
**Modes:** Dark (primary) + Light

---

## Brand identity

- **Logo:** 7 hexagons arranged in a honeycomb cluster — 7 entities, modular, interconnected
- **Primary surfaces:** Deep black (#070707) in dark, off-white (#f5f5f3) in light
- **Accent:** Aztec Purple (#893BFF) in dark, Zeus Purple (#700077) in light
- **Red (#D4001A) — use sparingly.** Borders, error states, destructive actions only. Never for primary CTA. User is red-green colorblind.

---

## Color tokens

### Dark mode
| Token | Value | Use |
|-------|-------|-----|
| bg | #070707 | App background |
| surface | #0f0f0f | Cards, panels |
| surfaceHigh | #161616 | Elevated surfaces |
| surfaceGlass | rgba(15,15,15,0.72) | Glassmorphism |
| border | #1e1e1e | Default borders |
| borderLight | #2a2a2a | Subtle borders |
| text | #ffffff | Primary text |
| textSecondary | #c7c7c7 | Silver — secondary |
| textMuted | #555555 | Hints, placeholders |
| accent | #893BFF | Aztec Purple |
| accentSecondary | #700077 | Zeus Purple |

### Light mode
| Token | Value | Use |
|-------|-------|-----|
| bg | #f5f5f3 | App background |
| surface | #ffffff | Cards |
| surfaceHigh | #ebebeb | Elevated |
| text | #070707 | Primary |
| textSecondary | #555555 | Secondary |
| accent | #700077 | Zeus Purple (better contrast on white) |
| accentSecondary | #893BFF | Aztec Purple |

---

## Status colors — color-blind safe design

User is **red-green colorblind**. Rules:
1. Never use red vs green as the only differentiator
2. **Active = Purple** (not green) — distinguishable from red for everyone
3. Always pair color with an icon (the `statusIcon()` helper provides this)
4. Red (#D4001A) is only for errors — always accompanied by ✕, ⛔, or ⚠ icon

| Status | Color (dark) | Icon | Notes |
|--------|-------------|------|-------|
| active | #893BFF | ⬡ | Purple — unambiguous |
| idle | #555555 | ○ | Silver/gray |
| done | #33c333 | ✓ | Green — always with checkmark |
| paused | #c9b800 | ⏸ | Yellow (adapted for dark bg) |
| blocked | #D4001A | ⛔ | Red — minimal, with icon |
| failed | #D4001A | ✕ | Red — minimal, with icon |
| pending | #555555 | ○ | Same as idle |
| info | #7b6dff | ℹ | Blue-purple |

---

## Glassmorphism rules

Used for modals, floating panels, tab bars, and overlay cards. NOT used for standard list items (too heavy).

**Dark:**
```
background: rgba(15, 15, 15, 0.72)
backdrop-filter: blur(16px)
border: 0.5px solid rgba(199, 199, 199, 0.08)
```

**Light:**
```
background: rgba(255, 255, 255, 0.72)
backdrop-filter: blur(16px)
border: 0.5px solid rgba(0, 0, 0, 0.07)
```

---

## Borders

- Default card border: 0.5px — not 1px. Thinner = more refined.
- Accent border (active/focused): 0.5px rgba(137,59,255,0.3)
- Error border (destructive / error state): 0.5px rgba(212,0,26,0.35)
- Never use a solid 1px+ red border on non-error elements

---

## Typography

| Level | Size | Weight | Color |
|-------|------|--------|-------|
| Heading | 20-26px | 800 | text |
| Title | 15-17px | 600 | text |
| Body | 14px | 400 | text |
| Secondary | 13px | 400 | textSecondary (silver) |
| Muted | 12px | 400 | textMuted |
| Label | 11px | 600 | textMuted — UPPERCASE, 0.6 spacing |
| Mono | 12px | 400 | accent — for keys, IDs, code |

---

## Radius

| Token | Value | Use |
|-------|-------|-----|
| xs | 4px | Tags, small pills |
| sm | 6px | Inline badges |
| md | 8px | Buttons, inputs |
| lg | 12px | Cards (standard) |
| xl | 16px | Modal sheets |
| xxl | 24px | Onboarding cards |
| pill | 999px | Status badges |

---

## Component inventory

| Component | File | Notes |
|-----------|------|-------|
| Card | components/Card.tsx | variants: default, high, glass, accent, error |
| GlassCard | components/GlassCard.tsx | Glassmorphism wrapper |
| StatusBadge | components/StatusBadge.tsx | Color + icon always |
| PriorityBadge | components/PriorityBadge.tsx | Color + arrow icon |
| AgentAvatar | components/AgentAvatar.tsx | Ring color = status |
| Button | components/Button.tsx | primary, secondary, ghost, danger, glass |
| EmptyState | components/EmptyState.tsx | Centered emoji + text |
| ThemedText | components/ThemedText.tsx | heading, title, body, secondary, muted, accent, label, mono |
| Divider | components/Divider.tsx | 0.5px themed line |
| SectionHeader | components/SectionHeader.tsx | Title + optional action link |
| StatCard | components/StatCard.tsx | Metric display card |

---

## Usage examples

```tsx
import { useTheme } from '../constants/theme'
import { Dark, Light, Space, Radius } from '../constants/colors'

// In a component:
const { theme, mode } = useTheme()
// theme is Dark or Light depending on system setting

// Color-blind safe status:
import { statusColor, statusIcon } from '../constants/theme'
const color = statusColor('active', theme)  // → '#893BFF'
const icon  = statusIcon('active')           // → '⬡'
```

---

## Logo usage

The 7Ei hexagon mark works on:
- **Dark bg:** white hexagons on #070707 — original (attached to repo)
- **Light bg:** invert to black hexagons on #f5f5f3
- **Accent version:** Aztec Purple hexagons for app icons

Minimum clear space: 8px around the mark at any size.
