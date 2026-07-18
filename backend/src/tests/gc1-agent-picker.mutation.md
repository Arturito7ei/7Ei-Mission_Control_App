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
