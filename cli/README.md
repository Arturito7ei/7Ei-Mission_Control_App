# 7ei-mc — operator CLI (MCA-ADAPT S2.3)

Zero-dependency Node (18+) CLI that wraps the 7Ei Mission Control **agent API**. Drive an agent, tail work,
and read/write the shared memory vault from a terminal.

```bash
export MC_BASE_URL=https://7ei-backend.fly.dev
export MC_AGENT_TOKEN=mca_...        # mint in Cockpit → agent card

node cli/mc.mjs me
node cli/mc.mjs tasks assigned
node cli/mc.mjs claim <taskId>        # → { runId, sessionState }
node cli/mc.mjs runlog <runId> "did X"
node cli/mc.mjs result <taskId> done "finished"
node cli/mc.mjs mem tree vault/Protocols
node cli/mc.mjs mem write vault/Memory/agents/note.md "shared memory line"
```

Install as a command: `npm i -g ./cli` then `7ei-mc me`. Tests: `cd cli && npm test`.
