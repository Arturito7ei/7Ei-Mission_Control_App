# RUNBOOK — provisioning `SECRETS_ENC_KEY` / `RUN_TOKEN_SECRET` on hosted (Fly)

> **Audience: the operator.** Every `flyctl` command here is yours to run. The assistant that wrote this runbook did **not** set any secret and did **not** read any secret value.
>
> Companion: `GO-LIVE.md` §1 (the original checklist entry). This runbook exists because that entry is correct but **incomplete in one dangerous way** — it tells you to rotate the key, but not how to find out what rotating it will *break*. Read this one before running the command there.
>
> Status of the investigation behind it: **HARD-1, read-only.** Findings quoted from source at `bc08e81`.

---

## 1. The finding (verified in source)

`backend/src/services/secrets.ts:5` — the entire at-rest secret store keys off one line:

```typescript
const KEY = createHash('sha256').update(process.env.SECRETS_ENC_KEY ?? 'dev-7ei-mc-secrets-key').digest() // 32 bytes
```

When `SECRETS_ENC_KEY` is unset, the `??` silently substitutes the literal string `'dev-7ei-mc-secrets-key'`. It does **not** throw. It does **not** warn. It does not even log. The process boots, encrypts, and decrypts perfectly happily under a key that is committed to a **public repository** (see the `repo-is-public` note).

`AES-256-GCM` is doing its job here; the algorithm is fine. The key is the problem: `sha256('dev-7ei-mc-secrets-key')` is computable by anyone in about a second. Anything encrypted under it is plaintext to anyone who can read the DB and the repo.

The run-token signing key has the same shape, `backend/src/routes/agent-api.ts:281`:

```typescript
const secret = process.env.RUN_TOKEN_SECRET || process.env.SECRETS_ENC_KEY || 'dev-7ei-mc-run'
```

Two failure modes stacked: it falls back to `SECRETS_ENC_KEY` (reusing the encryption key as a signing key — bad practice even when both are strong), and then to the public literal `'dev-7ei-mc-run'`. With that default in play, **per-run HMAC tokens are forgeable by anyone with the repo.**

### Why the existing fail-closed guard does not save hosted

There *is* a guard — `backend/src/services/secret-keys.ts` `assertSecretKeysSafe()` — and it correctly refuses to boot on a default key. But read line 66:

```typescript
const profile = resolveDeploymentProfile(env)
if (profile !== 'packaged') return { ok: true, problems: [], profile }
```

It returns `ok: true` for every profile except `packaged`, **by explicit design** (the doc comment: *"Hosted supplies real Fly secrets … this guard must stay a no-op so the hosted boot is byte-identical"*). That design assumes hosted is provisioned. If hosted is *not* provisioned, the guard's assumption is false and it waves through exactly the condition it was built to stop. **The `.dmg` is protected; production is not.** Closing that gap is engineering follow-up FU-1 at the end of this runbook.

### Blast radius — what is encrypted under this key

Two tables, both via `services/secrets.ts` `encrypt()`:

| Table | Column(s) | What lives there |
|---|---|---|
| `secrets` (`schema.ts:299`) | `value_encrypted` | Company- and agent-scoped secret bag — LLM keys, vault PAT, custom-model keys, per-agent connector credentials (CONN-6/8). Written by `routes/tasks.ts:340`, `routes/connectors.ts:30`, `routes/agent-connectors.ts:47`, `routes/jira.ts:44`, `routes/agent-invites.ts:368`. |
| `agent_oauth_tokens` (`schema.ts:599`) | `access_token_enc`, `refresh_token_enc` | Per-agent Google OAuth access + **refresh** tokens (CONN-5). Written by `services/agent-google-auth.ts:311-374`. |

> ⚠️ **`GO-LIVE.md` §1 undercounts this.** It says to re-enter "NVIDIA key, vault PAT, custom-model keys" — that predates CONN-5/6/8. `agent_oauth_tokens` is a **separate table** and is not mentioned there at all. A Google **refresh** token encrypted under the public default is the worst single item in the blast radius: it is long-lived and it grants Gmail/Calendar/Drive access on the operator's own account.

---

## 2. Is the production store actually populated?

**I could not determine this, and I am not going to guess.** `flyctl` is installed on this Mac but reports `no access token available` in a non-interactive session, so I had no read-only route to production. **Treat the store as POSSIBLY POPULATED until you run the check below.** This matters because it decides between two materially different procedures in §4.

Run this yourself. It is **read-only** and prints **counts only — never a value**:

```bash
# Counts only. Does not print, decrypt, or export any secret material.
flyctl ssh console -a 7ei-backend -C \
  "node -e \"const{createClient}=require('@libsql/client');const c=createClient({url:process.env.DATABASE_URL,authToken:process.env.DATABASE_AUTH_TOKEN});(async()=>{for(const t of ['secrets','agent_oauth_tokens']){try{const r=await c.execute('select count(*) as n from '+t);console.log(t,'rows:',r.rows[0].n)}catch(e){console.log(t,'ERR',e.message)}}})()\""
```

Interpreting the result:

| Result | Meaning | Go to |
|---|---|---|
| both `rows: 0` | Nothing has ever been encrypted. **Nothing to migrate.** | §4 — Path A |
| either `> 0` | Real material exists under the public default key. | §4 — Path B |
| command fails / can't run it | **Assume populated.** | §4 — Path B |

**Circumstantial evidence only — do not substitute it for the count.** Remote onboarding is 404-gated (`MC_ENABLE_REMOTE_ONBOARDING` unset ⇒ `onboardingDocAccess().allowed === false`, `backend/src/tests/onboarding-doc.test.ts:178`), which makes it *plausible* that no agent has ever been onboarded in prod and both tables are empty. That is a hypothesis, not a measurement. `secrets` can also be written from the Cockpit → Secrets UI by a signed-in operator, entirely independent of onboarding — so "onboarding is off" does **not** imply "the table is empty." Run the count.

---

## 3. Generate the values

Run locally. `openssl rand -hex 32` gives 32 bytes / 64 hex chars — full strength for both.

```bash
openssl rand -hex 32   # → SECRETS_ENC_KEY
openssl rand -hex 32   # → RUN_TOKEN_SECRET   (run it AGAIN — a DISTINCT value)
```

Rules:
- **The two values must be different.** Reusing one key for encryption and for HMAC signing is the thing `secret-keys.ts:81` flags as a problem in packaged; do not hand-recreate it in hosted.
- **Put both in your password manager before you set them.** `SECRETS_ENC_KEY` is not recoverable — lose it and every row in §1's table becomes permanently undecryptable. This key is not a credential you can reset; it is the only copy of the thing that makes the data readable.
- Paste them **only** into the `flyctl` command and your password manager. Not into chat, not into a file in this repo, not into a commit.

---

## 4. Set them — pick the path §2 selected

### Path A — store is EMPTY (both counts `0`)

**Safe to set now. Nothing to migrate.** No secret has ever been written, so there is nothing that could be orphaned.

```bash
flyctl secrets set \
  SECRETS_ENC_KEY=<paste-first-value> \
  RUN_TOKEN_SECRET=<paste-second-value> \
  -a 7ei-backend
```

Setting secrets triggers a rolling restart; the new key is live when it completes.

### Path B — store is POPULATED (or you could not check)

**Setting the key naively here ORPHANS live data.** There is no re-encryption path in this codebase — no migration script, no dual-key read, nothing that can decrypt-under-old-and-re-encrypt-under-new. `decrypt()` derives one key from the current env and that is the only key it will ever try. The moment the new key is live, every existing row fails to decrypt, and the failure surfaces as an **`unable to authenticate data`** GCM auth-tag exception at the callsite, not as a clean "please re-enter" message.

Given no re-encryption tooling exists, **wipe-and-re-enter is the correct procedure** — deliberately, not as a shortcut. It is safe precisely because everything in scope is *re-obtainable*: LLM/vault/connector keys can be re-pasted from your password manager or re-issued by their vendor, and OAuth tokens can be re-granted by re-running the connect flow. Nothing here is data you would lose forever, so trading it for a clean cryptographic state is the right call.

**Order matters. Do not deviate:**

1. **Inventory first, while the old key still works.** Open Cockpit → Secrets and write down every secret *key name* present, and note which agents have a connected Google account (Agent → Connectors). You are recording *what to restore*, not the values. Do this **before** step 3 — after the key changes you can no longer read this list back.
2. **Announce a short window.** Agent runs that resolve a secret will fail between steps 3 and 5.
3. **Set the new keys** (same command as Path A).
4. **Purge the orphaned rows.** They are now undecryptable ciphertext and will throw on every read attempt; leaving them in place means a persistent, confusing failure mode. Delete `FROM secrets` and `FROM agent_oauth_tokens` for the affected org(s).
5. **Re-enter, now under the strong key.** Re-paste each secret from your inventory via Cockpit → Secrets, and re-run the Google connect flow per agent to re-mint OAuth tokens.
6. **Verify** per §5.

> **The one irreversible step is 4.** Complete step 1 first, and be satisfied you can restore every item on that list, before you delete anything.

---

## 5. Verify

```bash
# Names + digests only — never prints values. Expect both keys listed.
flyctl secrets list -a 7ei-backend

# Repo helper — checks the full required/optional set (both keys are covered).
bash scripts/check-secrets.sh

# Service is healthy after the restart.
curl -s https://7ei-backend.fly.dev/api/health
```

Then, functionally: store one throwaway secret via Cockpit → Secrets, read it back (masked), delete it. A clean round-trip proves the new key is the live key. If any *pre-existing* secret throws `unable to authenticate data`, it is an orphan from Path B step 4 that was missed — delete and re-enter it.

---

## 6. Ordering against the rest of go-live

**`SECRETS_ENC_KEY` must be set BEFORE any of the following.** Each one is a path that writes ciphertext; anything written before the key is in place is written under the public default and has to be redone.

1. ✅ **`SECRETS_ENC_KEY` + `RUN_TOKEN_SECRET`** ← this runbook, first
2. Then `MC_ENABLE_REMOTE_ONBOARDING=1` — onboarding parks declared secrets in the `join_request` scope (`routes/agent-invites.ts:368`) the moment it is reachable. Opening this before the key means an agent's first act is writing credentials under the weak key.
3. Then any connector credential — Google OAuth (CONN-5), Telegram/WhatsApp/GChat (CONN-6), GitHub/Jira (CONN-8)
4. Then any Cockpit → Secrets entry

**Do not enable remote onboarding to "test" the flow before the key is set.** A test credential written under the default key is a real credential written under a public key.

### Two more while you are in `flyctl`

**`OPENAI_API_KEY`** — optional (`backend/CLAUDE.md`). Only needed if you want the OpenAI leg of `llm-router.ts` live. It is unrelated to the key work; set it in the same command if you want it.

```bash
flyctl secrets set OPENAI_API_KEY=<sk-...> -a 7ei-backend
```

**`ALLOWED_ORIGINS`** — ⚠️ **correction to the brief.** This was flagged to me as being set to `*`. **It is not, and there is no wildcard anywhere in the CORS path.** `backend/src/middleware/cors.ts:51` reads:

```typescript
origin: env.ALLOWED_ORIGINS?.split(',').map(o => o.trim()).filter(Boolean) ?? DEFAULT_ORIGINS,
```

and `DEFAULT_ORIGINS` (`cors.ts:41`) is an explicit allow-list: `http://localhost:3000`, `http://localhost:8081`, `https://7ei.ai`, `https://app.7ei.ai`. So the unset behaviour is **already safe** — this is not a vulnerability and not urgent.

It is still worth setting explicitly, for one narrow reason: the defaults include the two **localhost** origins, and `credentials: true` is on. That means a page on a developer's own `localhost:3000` can make credentialed requests to the production backend. That is a small, real hardening win, not a hole:

```bash
flyctl secrets set ALLOWED_ORIGINS='https://app.7ei.ai,https://7ei.ai' -a 7ei-backend
```

> Note the trade-off before you run it: this **removes localhost**, so a locally-run web/Expo client can no longer talk to the production backend. If you rely on that for debugging, keep the default or re-add the localhost entries.

---

## 7. Engineering follow-up (not operator work)

**FU-1 — extend the fail-closed guard to hosted.** The asymmetry in §1 is the root cause: `checkSecretKeys()` early-returns `ok` for hosted, so production is the *only* profile that can boot on a public key. A hosted boot that finds `SECRETS_ENC_KEY` in `KNOWN_INSECURE_KEYS` should refuse to start, exactly as packaged does. `isInsecureKey()` and the whole guard already exist and are tested — this is a scoping change to line 66, not new machinery.

Sequencing: **land FU-1 only after the operator has completed §4.** Shipping it first would turn an unprovisioned production instance into a hard boot failure — correct behaviour, catastrophic timing.

**FU-2 — drop the `RUN_TOKEN_SECRET → SECRETS_ENC_KEY` fallback** in `agent-api.ts:281`. Once both are set, the fallback chain is dead code that only exists to make a weaker configuration bootable. `secret-keys.ts:81` already treats key reuse as a problem in packaged; hosted should not silently do it.

**FU-3 — consider a re-encryption path.** Path B is destructive purely because none exists. A dual-key read (try new, fall back to old, re-encrypt on read) would make future key *rotation* routine instead of an outage. Not needed for this go-live; needed the second time.
