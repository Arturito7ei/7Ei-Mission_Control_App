# The memory graph — rendering the vault as a graph

> **Status:** MEM-1 shipped (2026-07-18). Builds on Epic M (#192, the original d3-force map + native
> parser), M2 (#194, Graphify semantic communities) and MOB-6e (#292, the phone's vault tree).
> **Surfaces:** `web/app/dashboard/VaultGraph.tsx` · `apps/mobile/src/vaultGraph.ts` +
> `screens/MemoryConnections.tsx` · `backend/src/services/vault-graph.ts`.

## 1. What the data actually is

The "memory brain" is the shared Obsidian vault (`Arturito7ei/7Ei-MC_TARCO`, content under `vault/`), read
through GitHub by the vault connector. It is **not** a database table — there is no `nodes` table, and the
`memory` routes under `/api/agents/:agentId/memory` are an unrelated per-agent key/value store. The graph is
**derived from markdown**, two ways:

| Source | How | When |
|---|---|---|
| `graphify` | a `graph.json` committed inside the vault, normalised by `parseGraphifyGraph()` | preferred — one fetch, and it carries Louvain **communities** with LLM-named concepts |
| `native` | we parse `[[wikilinks]]`, `#tags` and frontmatter ourselves (`buildNativeGraph()`) | fallback — costs one GitHub call per note, so it is capped at 120 files |

Both produce one model: `GraphNode { id, label, kind: note|tag|heading, path?, group, degree, tags?,
community?, communityName? }` and `GraphEdge { source, target, relation, weight }`. `group` is the top-level
folder — the cluster key the web colours by.

## 2. Authorisation — why MEM-1 added no endpoint

`GET /api/orgs/:orgId/memory/graph` already existed (`backend/src/routes/tasks.ts`). It is **already
membership-gated**, and not by a per-route `preHandler` that someone could forget: `enforceOrgRole` is installed
**once** as a `preHandler` on the whole Clerk-secured scope, and `resolveRequestOrg` sees this route's `:orgId`
path param directly. The **R-4 trap** — `requireOrgRole` no-opping on a path with no `:orgId` — does not apply
here precisely *because* the org is in the URL.

So MEM-1 added **no route, no gate, and no role change**. What it added is a **bound**.

## 3. The bound — `capGraph()`

The native path was already capped at the *fetch*. The Graphify path is a single `graph.json` read, so a large
vault arrived whole, shipped whole, and landed in a force simulation. `capGraph(graph, maxNodes)` bounds it:

- **keeps the highest-`degree` nodes** — degree is the cheapest honest proxy for "load-bearing note"; the
  singleton leaf is the thing you would find faster in the Reader's tree anyway;
- **ties break notes-first, then by id** — so the same vault always yields the **same** map. A cap that
  reshuffled per fetch would make the view untrustworthy;
- **does not recompute `degree`** — it stays the node's TRUE connectivity in the whole vault, so radius keeps
  meaning "how central is this note", not "how much of it survived";
- **reports the drop** (`stats.capped`, `stats.totalNodes`) so both clients can say the map is partial.

Ceiling is **1500**; `?max=` may ask for *less*, never more. The response **cache holds the uncapped graph** and
the cap is applied on the way out, so two clients requesting different `max` cannot poison each other's view.

## 4. The web map

### Performance, measured rather than assumed

The force cool is **synchronous** and re-runs on **every filter change** — it is a budget paid repeatedly, not
once at load. Measured with the shipped force configuration against this repo's own 8,054-node Graphify graph
(17.9k edges — denser than any real vault):

| nodes | edges | cool | verdict |
|---:|---:|---:|---|
| 150 | 560 | 65ms | imperceptible |
| 300 | 1,565 | 235ms | fine |
| **600** | **3,101** | **597ms** | **the cap** — a visible hitch, still responsive |
| 1,000 | 4,532 | 1,070ms | crosses a second; the tab stops feeling alive |
| 2,500 | 9,946 | 3,350ms | janks hard |
| 4,000 | 13,603 | 5,879ms | unusable |

Hence `RENDER_CAP = 600`, shedding lowest-degree first and **saying so** in the toolbar. The live TARCO vault
draws 153 nodes and cools in 67ms, so the cap is a ceiling for pathological vaults, not a routine amputation.
**A vault that genuinely needs more wants a Graphify pass that clusters before the browser sees it** — not a
bigger number here.

### Labels are a budget, not a threshold

Originally labels appeared above a fixed degree (`>= 4`). That reads well on a sparse vault and **collapses on a
dense one**: the stress graph has hundreds of nodes past any fixed floor, so every one drew its name and the map
became unreadable text soup — exactly the hairball labels exist to prevent. The screen has a roughly fixed
amount of room for text, so the **budget** is fixed too and the highest-degree nodes spend it: 12 / 40 / 110 /
400 by zoom bucket. Hovered, focused and searched nodes are always labelled regardless.

### Framing

`fitView()` frames the whole graph on load, on every filter change, and on "Reset view". A fixed `k=1` showed a
small vault marooned in empty space and a large one spilling off every edge. It never zooms **past** 1:1 — a
three-note vault blown up to fill 960×620 looks broken, not close.

### Keyboard

The canvas is **one tab stop with roving focus**, not 600 tab stops — tabbing through every node in a force
graph is a trap, not access. `role="application"` + `aria-activedescendant`; arrows walk the **hub-first** order
(the order the map is *for*); Enter opens; Escape releases. Focus **auto-centres the node** — keyboard focus that
can land off-screen is not focus. Each node carries an `aria-label` naming its label, concept, degree and
folder. The **non-canvas fallback is the Reader tab**, one click away, and the error/empty states point at it.

### Colour — what this palette honestly is

The ramp is derived from **Okabe–Ito**, and it is always paired with the folder
**name** in the filter chips.

It used to be **hardcoded hex in the component**, and that hid a genuine bug: on the light card
(`#ffffff`) the canonical yellow `#F0E442` sits at roughly **1.1:1** and the sky `#56B4E9` at **2.3:1** —
both below the 3:1 floor for a graphical object, so those folders were **effectively invisible in light
theme**. The ramp now lives in the token system as `--graph-1…10` (plus `--graph-tag`,
`--graph-node-stroke`, `--graph-edge`), and the pale end is darkened for light.

**An earlier version of this document claimed the light tuning "preserves hue ORDER, which carries the
colourblind separation". That was wrong, and the audit was right to reject it.** Okabe–Ito's blue and sky
differ mainly in **lightness**, not hue — so darkening the sky for contrast collapsed the pair
(ΔE00 22.31 → 7.65). Corrected: `--graph-5` is now `#4a8cf0`, a brighter, bluer tone at 3.33:1 on the card,
which puts the pair at **ΔE00 15.4** and off the risky list.

The deeper correction matters more. A search over the whole sRGB cube — **all ten slots free**, only a 3:1
contrast floor, scoring the worst pair across normal vision plus simulated deuteranopia, protanopia and
tritanopia — tops out at a worst pair of **ΔE00 ≈ 12**, and reaches it with near-blacks and navies that do
not read as a palette at all. With eight slots it reaches ≈ 12.8. **Ten mutually distinguishable
categorical colours under three dichromacies is not achievable**, and Okabe–Ito itself is specified as
*eight* colours; slots 9–10 are our extension, which is where the greens crowd.

So the honest statement of what the palette does:

> Colour is a **cluster hint** — adjacent same-hue nodes read as a group. It is **not an identifier**.
> The identifier is the folder **name**, carried beside every swatch in the filter chips. That is why hue
> is never the sole signal, and it is why the chips are the legend rather than a separate key.

Worst measured pairs that remain (min ΔE00 across all four vision models): light `g2`/`g6` **3.06** and
`g2`/`g7` **5.48**; dark `g1`/`g5` **3.95** and `g3`/`g10` **5.38**. These are present in the **canonical**
Okabe–Ito values too — orange, vermillion and yellow are genuinely close for deuteranopes — so they are a
property of asking ten categorical colours to survive three dichromacies, not of the theme tuning. Do not
"fix" one by assuming hue is what tells folders apart.

> Verified by rendering the **real** pipeline — backend `parseGraphifyGraph` + `capGraph` → the shipped
> force configuration → the real token values — against the live TARCO vault and the 8k stress graph,
> screenshotted in both themes.

### Telling "thinking" from "crashed"

The cool is synchronous, so a spinner set in the same render never paints: React would render, block in the
memo, and paint once at the end. `useDeferredValue` is the seam — React paints a frame with the **previous**
drawn set (dimmed, with a busy chip and `aria-live`), and only then re-renders into the expensive memo.
Everything derived from the drawn set reads the deferred value, so the stale frame stays internally
coherent rather than mixing an old layout with a new selection.

Note that `filtered` deliberately does **not** depend on `query`: typing never re-cools. Search only dims
and highlights what is already laid out, so it stays instant at any vault size.

## 5. The phone

The canvas is **dropped**; its data is not. See `docs/DESIGN-mobile-parity.md` §6.13 for the full argument and
`apps/mobile/src/vaultGraph.ts` for the in-code version. In short: hit-testing at 44pt, and a synchronous cool
that blocks **the** JS thread (navigator, list and gesture responder included). `react-native-svg` **is**
bundled, so the renderer was never the blocker — this is a judgement, not a limitation.

What crossed: **whole-vault search** (a capability the folder tree structurally cannot have, since
`…/memory/tree` returns one directory per call) and **neighbourhood traversal** with **direction kept** —
"Links to" and "Linked from", each tappable, with a trail back. Connectivity is stated in words
(`12 links · 3 back`) because a list has no radius.

## 6. Deferred

- **Tappable `[[wikilinks]]` in the phone's reader.** The resolver now exists, so this is no longer blocked on
  data — it is reader-surface work with its own ambiguity cases (duplicate titles; a link to a capped-away note).
- **Server-side clustering** for vaults that genuinely exceed the render cap — collapse a community to one node
  and expand on demand, rather than shedding leaves.
- **A `?since=` / incremental graph.** Today `?rebuild=1` re-reads everything; a large native vault pays 120
  GitHub calls to do it.
- **A pre-existing cross-tenant path in the vault connector** (found by the MEM-1 audit, deliberately NOT
  fixed here): `resolveVaultToken()` returns a process-wide `VAULT_GH_TOKEN` for **any** org, and
  `parseVaultConfig(null)` defaults to the real company vault — so were that env var ever set, every org
  would read one vault. Unreachable today (the variable is unset in every environment, and the per-org
  encrypted `GITHUB_VAULT_TOKEN` is the live path), but it is a real latent multi-tenancy hole and wants
  its own backend story.

## 7. Verify

```bash
cd backend && npm test && npm run evals && npm run typecheck
cd web && npm test && npm run build
cd apps/mobile && npm test && npm run typecheck && npm run export
```
