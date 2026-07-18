# GC-1 — the Command Center agent picker

**Status:** shipped · **Branch:** `gc-1-agent-picker` · **Surfaces:** backend, web, mobile

The Command Center had one recipient: Arturita. This story lets the owner choose **who
he is talking to**, on the desk and on the phone.

## The contract

`POST /api/orgs/:orgId/arturita/converse` gains one optional field:

```jsonc
{
  "message": "…",
  "agentId": "agent-uuid | null",   // GC-1. absent → the pre-GC-1 path, byte for byte
  "history": [
    { "role": "assistant", "content": "…", "fromAgent": "Bruno" }  // GC-1 marker
  ]
}
```

Responses now carry `agent` (who replied) on every shape, plus `assignedTo` on a delegate
turn and `pendingApprovals` / `pendingApprovalNote` on an agent turn. A new `mode: 'agent'`
means a picked agent ran the turn.

**The default is the promise.** With no `agentId` the request body does not contain the
field at all, an unmarked transcript is admitted unchanged, and the response shapes gain
only additive keys. That property is the first and hardest thing the test suite asserts.

## How a picked turn runs

```
operator message
      │
      ▼
decideConverseMode(message)      ← reads the OPERATOR'S WORDS ONLY
      │
      ├── delegate (build order / destructive / explicit flag)
      │      └── task assigned to the CHOSEN agent, status pending → A2 approval gate
      │
      └── answer
             ├── recipient = Arturita  → the F1 fallback chain (unchanged)
             └── recipient = an agent  → executeAgentTask()
```

**Routing is decided before the recipient is considered.** Picking an agent changes *who*
answers, never *whether* the approval gate applies — a destructive request addressed to a
specialist still parks behind A2. This ordering is mutation-proven (M7).

## The bug this story fixed

The delegate branch inserted `agentId: agent.id`, which is **Arturita's own id**. Every
task the Command Center created was assigned to the front door itself: the operator was
told "I've put it on the board for the office to run" and the office never received it.
With no picker there was no other id to use, which is why it survived. `target` is
Arturita when nobody picks, so the default is unchanged — but a picked agent now actually
receives the work.

## The design point: connectors fire from the chat box

Routing a chat turn to a real agent runs the **executor**, so a chat message can now write
a GitHub issue or send an email. This is intended, and the choice that makes it real is
`workMode: 'execute'`.

`ask` was the tempting option — a chat turn *is* a question — but it routes to
`answerAskTask`, documented as "no delegation or tool side-effects". That would have
shipped a picker that swaps personality while the agent stays unable to act, **and would
have made every CONN-7 test vacuously green**: a gate that is never reached always passes.

What keeps it safe is not this route:

| Property | Where it lives | Proven by |
|---|---|---|
| Destructive intents never reach the executor branch | `decideConverseMode`, evaluated first | M7 |
| Connector calls hit the CONN-7 authorization gate | `connector-execution.ts` | route-driven test asserting a `pending` approval row |
| Operator step-up is still required | `payload.requiresStepUp` | asserted `true` on the filed card |
| Approved params are the executed params | server-computed `paramsDigest` | asserted equal to the real params **and unequal to different ones** |
| A chat turn cannot redeem an approval | no `approvalId` path | source assertion on the route |
| Capability comes from the DB | `agents.permissions`, `agent_connectors.trustLevel` | a reply claiming authorization produces no approved action |
| Same-org execution | `assertAgentInOrg` **and** the executor invariant | M1 and M2, each proven with the other intact |

### Approvals from chat are surfaced

The approval already reaches the Inbox and push — but the operator is looking at the
**chat**, where a gated agent would otherwise read as having gone quiet, or worse, as
having succeeded. `executeAgentTask` reports `pendingApprovals` (a tally of the gate's own
decision; it grants nothing and changes no gate) and both clients render an inline
`⏸ … waiting in your Inbox` line.

## Untrusted text

An agent reply can quote a GitHub issue, a Jira comment, an email or an MCP tool result.
CONN-9 contains that on the way **in** (fenced under a per-run nonce; the synthesis turn is
terminal, so directives are stripped unexecuted). GC-1 covers the way **out**: the reply is
handed to the chat, kept in `history`, and fed back into the next turn's prompt — as an
`assistant` message, the one context a model is most inclined to treat as its own prior
reasoning.

So an agent-authored turn re-enters **fenced** (`services/converse-agent-turn.ts`), under a
nonce drawn after the payload exists and redrawn on collision, so a reply cannot close its
own fence and continue in the operator's voice.

**The marker is client-set, and both lies fail safe:** claiming agent-authorship for your
own text only fences it (reducing its influence); claiming operator-authorship makes it
exactly as trusted as `message`, which the caller already controls. No lie grants anything,
so no server-side provenance store — which would mean persistence, explicitly GC-2 — is
needed.

The fence is the last line, not the first. The structural properties are what hold:

- **routing** reads the operator's `message` only — never history, never a reply;
- **the recipient** is the explicit `agentId` body field, never parsed out of a reply (M9);
- **capability** comes from the DB and the CONN-7 gate.

## The surfaces

**Web** (`AssistantPanel.tsx`) — a persistent "TO" bar above the composer: avatar, name,
select, and an `⚡ agent` tag when it isn't Arturita. Always visible rather than behind a
menu, because the owner must know who is listening *before* typing something sensitive.
The placeholder and the delegate toggle name the actual recipient. Each transcript bubble
carries its own avatar + name, so a thread that switched agents attributes every turn
correctly.

**Mobile** (`CommandCenterScreen.tsx`) — the same bar, opening a `Modal` picker with
avatars, roles and a checkmark. Built from core `react-native` only (`Modal`, `Pressable`,
`Text`), so it touches **zero native packages** and is boot-safe in Expo Go by construction.

Two client traps closed:

- **`deferAnswer`** would have silently bypassed the picker: it hands the prompt back for
  the browser to stream from local Ollama, which cannot run an executor. An agent turn now
  never defers — otherwise the picker would apply on cloud turns and be ignored whenever
  Ollama was up, and the operator would think he was talking to Bruno while talking to
  Arturita.
- **`threadRef` resets on switch** — `existingThreadId` names a task on the *previous*
  agent's queue.

Parity is pinned by `apps/mobile/src/agentPicker.test.ts`, which imports the web module and
asserts the sentinel, the wire mapping and the marking rule agree.

## Testing

44 new tests (backend 22, web 11, mobile 11). **Every guard is mutation-proven** — 9
backend, 5 web and 6 mobile mutations each turn the suite red, with baseline green after
restore. The table is in `backend/src/tests/gc1-agent-picker.mutation.md`, which also
records the harness bug worth remembering: the first draft was **green and vacuous**
because the fake provider answered plain JSON where the executor's `streamLLM` parses SSE.
The agent's turn was empty, so there were no connector directives, so the gate was never
reached — and "no unapproved action occurred" was trivially true. Pinned now by asserting
the reply has content before any gate assertion runs.

## Audit follow-ups (PR #335, PASS-WITH-NITS)

**LOW-1 — attribution.** `agent` on a response means **who wrote this reply**. The delegate
branch was returning the *target*, so Arturita's own canned acknowledgement ("I've put it
on the board for Bruno to run") rendered under Bruno's avatar and bold name, as if Bruno
had said it. Not attacker-controllable and not a fencing bug (`fromAgent` was correctly
null), but the transcript named the wrong speaker — and the owner decides what to say next
from who he believes is talking.

Author and assignee are now separate fields. The delegate bubble is authored by Arturita
(🌸) and the target renders as a `→ assigned to <Agent>` chip on both surfaces. Both
clients key the author name on `fromAgent` (set only for `mode: 'agent'`) rather than on
the presence of `agent` — which also keeps the default bubble byte-identical to pre-GC-1,
a bare 🌸 with no name.

**LOW-2 — a vacuous capability test, and what it revealed.** The test asserted only "no
approved action exists" with `permissions: []`; since an agent with no capability is never
offered the tool, nothing ran and the assertion was trivially true.

Strengthening it surfaced something better than a fixed test: **capability is enforced at
two independent points** — `deriveConnectorTools` (the agent is never told the connector
exists) and `executeConnectorAction` (the authoritative gate, "before ANYTHING else
executes"). Removing either alone does not change the observable, because the other still
refuses. The test now proves each layer with the other intact, and both are
mutation-proven (M11a/M11b). The fixture was also made self-contained rather than leaning
on a previous test's inserted connector row.

**Cosmetic — the native option list.** The picker's `<select>` is transparent/borderless so
it disappears into the pill, but a native **option list** is drawn by the browser and
inherits none of that. This app sets `data-theme` and **never declares `color-scheme`**, so
on the dark theme a Chromium/Firefox popup defaults to light chrome while the options
inherit the near-white `--text` — white on white. The options now name their colours
explicitly using theme variables, so they follow the toggle. macOS draws the popup with
system chrome and ignores the styling, which is readable anyway, so this is a no-op there
rather than a regression. **Still unverified in a real browser** — it removes the failure
mode rather than confirming the pixels. There is no custom dropdown component in the
dashboard to reuse, and the same latent risk applies to every other raw `<select>` in
`web/app/dashboard/` (GovernancePanel, page.tsx, ui.tsx); an app-wide `color-scheme`
declaration would fix the class, and is deliberately left out of this story.

## Deferred (scope)

- **GC-2** — thread persistence. Chat history remains client-side `useState`.
- **GC-3** — the project selector (binds to Jira projects, not the native table).
- **GC-4** — scoped retrieval.

A photo cannot ride an agent turn (`executeAgentTask` takes a string input, so there is no
image channel). Rather than drop it silently, the input tells the agent to say so and point
the operator at Arturita, who can see.
