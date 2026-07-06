# 7Ei Design System

**Version:** 2.0.0 · 2026-07-06 (v1 constraints preserved; adds web token map, density integration, delivery plan)
**Philosophy:** Sober and minimalist (Notion-inspired) + controlled glassmorphism · light AND dark
**Applies to:** `web/` (primary). v1 component inventory referenced the legacy Expo `app/`; the concepts carry over, the file paths don't.

---

## Brand identity

- **Logo:** 7 hexagons, honeycomb cluster. White on dark, black on light, Aztec Purple for app icons. 8px clear space.
- **Palette:** 7Ei Black `#070707` · White `#ffffff` · Silver `#c7c7c7` · Swiss Cross Red `#D4001A` · Aztec Purple `#893BFF` · Zeus Purple `#700077` · semantic green `#33c333`, yellow `#ffff00` (adapted per mode), blue `#3500ff` (adapted per mode).

## ⚠ Accessibility constraint (unchanged from v1 — overrides everything)

**The user is red-green colorblind.**
1. Never red vs green as the only differentiator.
2. **Active = Purple**, not green.
3. Color always paired with an icon or text label (`statusIcon()` / pill labels).
4. **Red `#D4001A` = brand + error/destructive/recovery ONLY, always with ✕ / ⛔ / ⚠ icon. Never a primary CTA fill.** Primary CTAs are purple (Zeus on light, Aztec on dark).

Red stays visually prominent (brand mark, recovery cards' left border + heading, error states) — prominence through *placement*, not through being the action colour.

## Semantic tokens (web: CSS variables on `:root[data-theme]`, emitted from `tokens.ts` v2)

| Token | Light | Dark |
|---|---|---|
| `--s0` page | `#f5f5f3` | `#070707` |
| `--s1` card | `#ffffff` | `#0f0f0f` |
| `--s2` raised | `#ebebeb` | `#161616` |
| `--glass` | `rgba(255,255,255,.72)` blur(16px) | `rgba(15,15,15,.72)` blur(16px) |
| `--glass-line` | `rgba(0,0,0,.07)` | `rgba(199,199,199,.08)` |
| `--line` / `--line-strong` | `#e5e5e3` / `#d5d5d3` | `#1e1e1e` / `#2a2a2a` |
| `--text` | `#070707` | `#ffffff` |
| `--text-2` (silver tier) | `#555555` | `#c7c7c7` |
| `--muted` | `#6b6b6b` | `#7e7e7e` |
| `--accent` (CTA/active) | `#700077` Zeus | `#893BFF` Aztec |
| `--accent-2` | `#893BFF` | `#700077` |
| `--brand-red` | `#D4001A` | `#D4001A` (text on dark: `#ff3b52`) |
| `--ok` / `--ok-bg` | `#1f7a1f` / `#eef4e8` | `#33c333` / `#0e2a0e` |
| `--warn` / `--warn-bg` | `#6b6100` / `#fff9c2` | `#c9b800` / `#33300a` |
| `--info` / `--info-bg` | `#3500ff` / `#eceafd` | `#7b6dff` / `#14104a` |

Yellow `#ffff00` is never a foreground; blue `#3500ff` lifts to `#7b6dff` on dark. Raw hex lives only in the `tokens.ts` theme map; components consume variables. **Density/type/space scales from MCA-79 unchanged** (28px rows stay; v1's 800-weight headings are superseded by the web's 400/500-only rule).

**T3 contrast audit (WCAG AA, both modes).** All text/surface token pairs meet AA (≥4.5:1) on page `--s0` and card `--s1`. `--muted` was darkened light `#8a8a88`→`#6b6b6b` and lightened dark `#555555`→`#7e7e7e` (it was 2.4–3.5:1 — failing for hints/labels/placeholders/idle status); it now clears 4.5:1 on `--s0`/`--s1` and is AA-large (≈4.46:1) on the rarely-texted raised `--s2`. Known AA-large item: `--accent` on dark (Aztec `#893BFF`, ≈3.8:1) — kept as the brand active/CTA identity colour; it satisfies the 3:1 non-text/UI-component rule and only ever renders as short code tokens, links, or the semibold active nav label, never body copy. Red/purple button fills use white text (`--accent-contrast`, ≥5:1). PWA/browser `theme-color` now tracks `--s0` per resolved theme (light `#f5f5f3` / dark `#070707`) via the pre-paint script.

## Status colors (v1 table, canonical)

| Status | Dark | Icon |
|---|---|---|
| active | `#893BFF` | ⬡ |
| idle / pending | `#555555` | ○ |
| done | `#33c333` | ✓ (always) |
| paused | `#c9b800` | ⏸ |
| blocked | `#D4001A` | ⛔ (always) |
| failed | `#D4001A` | ✕ (always) |
| info | `#7b6dff` | ℹ |

Heartbeats map to this: green→done-style ✓ purple-active when running, amber→paused yellow, stale→failed red ✕.

## Glassmorphism (v1 rules)

Chrome only: sidebar, modals, drawers, command palette, floating panels. NOT list items or content cards. Values in the token table; `@supports (backdrop-filter)` fallback to solid `--s1`.

## Borders & radius (v1)

0.5px default everywhere; accent border `rgba(137,59,255,.3)`; error border `rgba(212,0,26,.35)`; radius xs4/sm6/md8/lg12/xl16/pill999.

---

## Delivery plan (with the Paperclip gap-bridge — vault `01-Projects/Paperclip-Gap-Analysis-v2-2026-07-06.md`)

### Epic T — theme (first; all later UI ships themed once)
- **T1**: `tokens.ts` v2 theme map → CSS variables, `data-theme` + ThemeProvider (system/light/dark, persisted), primitives + panels consume variables. Colorblind-safe status helper (`statusColor/statusIcon`) ported to web; KPI strip + heartbeat colors migrate to the status table (purple active — fixes current red/green dots).
- **T2**: glass chrome — sidebar/nav shell (glass + hexagon mark), TaskDrawer/modals, command palette shell (⌘K, feeds Epic V).
- **T3**: hex sweep (cockpit `shared.tsx` domain colors → semantic/purple), contrast audit both modes, PWA `theme-color`.

### Epic W — work surface + failure UX
W1 recovery cards (red border + ⚠, structured: owner/source-run/evidence/next-action, open-until-decision) + system-notice comments → W2 reasoned blocker chips + next-up + sub-task cost rollups → W3 thread w/ wake-on-comment → W4 task watchdogs → W5 ask-mode.

### Epic V — visibility
V1 heartbeat 24h timeline; V2 tri-state approvals + inbox retry rows + read receipts; V3 preflight budget caps + cheap-model config validation.

### Epic D — DX/openness
D1 `/api/openapi.json` + CLI; D2 llms.txt + `/llms/*.txt` + `npx 7ei-mc onboard`.

**Order: T1 → T2 → W1 → W2 → T3 → V1 → W3 → D1 → rest.** R4 vault RAG parallel (backend-only).

## Non-goals
No IA rebrand (density direction stands); no glass on content; no sandbox providers (BYO-host stance); animations capped at 150ms ease on hover/expand.
