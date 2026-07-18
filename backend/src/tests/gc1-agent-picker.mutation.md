# GC-1 — mutation proof for `gc1-agent-picker.test.ts`

A green suite is not evidence. This repo has shipped vacuous suites, and three Criticals
hid behind green tests in the same week this story was built. So every guard GC-1 adds was
broken on purpose, the suite re-run, and the result recorded here.

**Baseline: 22 pass / 0 fail. After restoring every mutation: 22 pass / 0 fail.**

| # | Mutation (the guard removed) | File | Result |
|---|---|---|---|
| M1 | Drop the `assertAgentInOrg` tenancy check on the body-supplied `agentId` | `routes/arturita-converse.ts` | **20 pass / 2 fail** |
| M2 | Drop the executor's `task.orgId === agent.orgId` invariant | `services/agent-executor.ts` | **21 pass / 1 fail** |
| M3 | Assign the delegated task back to Arturita (restore the original bug) | `routes/arturita-converse.ts` | **20 pass / 2 fail** |
| M4 | Never treat a picked agent as a specialist (`addressedToSpecialist = false`) | `routes/arturita-converse.ts` | **18 pass / 4 fail** |
| M5 | Stop fencing agent-authored history turns | `services/converse-agent-turn.ts` | **21 pass / 1 fail** |
| M6 | Stop counting connector actions parked at the CONN-7 gate | `services/agent-executor.ts` | **21 pass / 1 fail** |
| M7 | Evaluate the specialist branch BEFORE the delegate/destructive check | `routes/arturita-converse.ts` | **20 pass / 2 fail** |
| M8 | Never redraw a fence nonce that collides with the payload | `services/converse-agent-turn.ts` | **21 pass / 1 fail** |
| M9 | Let the recipient be read out of `history` instead of the explicit body field | `routes/arturita-converse.ts` | **21 pass / 1 fail** |

### Audit round (PR #335 → PASS-WITH-NITS)

| # | Mutation (the guard removed) | File | Result |
|---|---|---|---|
| M10 | Attribute the DELEGATE ack to the assignee instead of Arturita (restores LOW-1) | `routes/arturita-converse.ts` | **23 pass / 1 fail** |
| M11a | Drop the capability check in `deriveConnectorTools` (**layer 1**) | `services/agent-connector-tools.ts` | **23 pass / 1 fail** |
| M11b | Drop the capability check in `executeConnectorAction` (**layer 2**) | `services/connector-execution.ts` | **23 pass / 1 fail** |
| W6 | Re-key the web bubble author off `msg.agent` (restores LOW-1) | `AssistantPanel.tsx` | **310 pass / 1 fail** |
| W7 | Drop the assignee from the web message | `assistant.logic.ts` | **310 pass / 1 fail** |
| P7 | Re-key the phone bubble author off `m.agent` | `CommandCenterScreen.tsx` | **338 pass / 1 fail** |
| P8 | Mark a delegate ack as agent-authored on the phone | `agentPicker.ts` | **338 pass / 1 fail** |

**LOW-2 turned out to be more interesting than a vacuous assertion.** The audit's
suggested mutation — remove the capability check — did **not** turn the strengthened test
red, and the reason is not a weak test: capability is enforced at **two independent
points**. Layer 1 (`deriveConnectorTools`) never offers the agent the tool; layer 2
(`executeConnectorAction`, "before ANYTHING else executes") denies even if a directive
reaches it. Removing either alone leaves the observable unchanged, because the other still
refuses — which is why a single end-to-end assertion cannot distinguish "denied" from
"never attempted".

So the test now proves each layer **with the other still intact**, the same shape as the
two tenancy legs (M1/M2), and M11a/M11b above show each is genuinely load-bearing. The
fixture was also made self-contained: it was leaning on a previous test having inserted
the `agent_connectors` row, without which the tool list is empty for a reason that has
nothing to do with capability — the audit's point, one level deeper than reported.

M1 and M2 are deliberately separate rows: they are the two independent layers of the same
invariant, and each is proven with the other still in place, so neither is resting on the
other's coverage. M7 is the ordering guard — with it removed, a destructive intent
addressed to a picked agent executes directly instead of parking behind the A2 approval
gate. M9 is the injection guard in its most dangerous form: it makes the recipient
derivable from untrusted text.

## One harness bug worth recording

The first draft of this suite was **green and vacuous**. The fake provider answered a
plain JSON body, but the executor's `streamLLM` parses SSE (`data: {...}` →
`choices[0].delta.content`). It therefore read *no* content, the agent's turn was empty,
and with an empty turn there are no `[CONNECTOR:]` directives — so the gate was never
reached and "no unapproved action occurred" was trivially true. The connector and
capability tests passed while proving nothing.

Fixed by making the fake provider stream, and pinned by asserting the reply has actual
content (`reply.text === 'ok'`) before any gate assertion runs. That assertion exists
solely so this failure mode cannot return silently.

## Reproducing

The harness lives outside the repo (it edits tracked source in place and restores it).
Each mutation is a single string replacement; the table above names the exact guard, and
the replacements are recorded in the story's PR description.
