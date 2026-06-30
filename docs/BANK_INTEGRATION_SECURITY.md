# Bank Integration Security & Provider Foundation (Finance 1B)

> **Status: Finance 1B.2 implemented — Plaid Sandbox connect + account discovery + cached balances
> work; transactions are still NOT functional.** The owner can connect a **fake Plaid Sandbox**
> institution (encrypted connection), **sync** its accounts, see **cached** balances, and create a
> **new linked** Xanther account. There are **no transactions, webhooks, or matching yet**; existing
> manual accounts are never merged/converted; Finance 1B performs **no money movement**. This document
> is the bounded security/privacy reference; durable principles remain in `docs/PRODUCT_VISION.md`, and
> the decision records are `docs/DECISIONS.md` (ADR-027/028/029).

## Account discovery + cached balances (Finance 1B.2 — what is functional now)

1. Owner clicks **Sync accounts** on a Sandbox connection → `POST /api/finances/connections/[id]/accounts/sync`.
2. Server (owner-scoped, Sandbox-only) decrypts the access token **server-side**, calls Plaid
   `/accounts/get` (**cached**, free — **never** the paid `/accounts/balance/get`), normalizes the
   accounts, and **upserts** `provider_accounts` rows by `(connection_id, provider_account_id)`. The
   decrypted token never leaves the provider-call boundary; only last-4 **masks** are stored (never a
   full account number).
3. `GET …/accounts` returns nonsecret provider-account views; the UI shows masked id, type/subtype,
   cached balance + available, currency, and a truthful freshness label (**Cached Sandbox balance ·
   Updated N minutes ago** / **Last known provider balance**, never "live"/"real-time").
4. Owner clicks **Add to Xanther** on an **unmapped** provider account → `POST /api/finances/
   provider-accounts/[id]/create-linked-account` with bounded choices (name, purpose, spendable) →
   creates a **new** linked `financial_accounts` row (`balanceSource='linked'`, `currentBalance` NULL).

**Balance authority (linked accounts):** the provider snapshot in `provider_accounts` is authoritative.
A linked account's `currentBalance` is **NULL** — never an editable competing source; the UI resolves
the balance via the 1B.0 resolver. A **missing** snapshot → **Balance unavailable** (never a fallback to
a manual balance or zero) and **excluded from totals with a warning** (the total is qualified, not
false). A **stale** snapshot is labeled "last known". Linked accounts **cannot be reconciled or
manually balance-edited** (the service strips balance/source edits). Credit follows the existing
liability convention (Plaid `current` = positive amount owed; excluded from cash/spendable).

**Idempotency/concurrency:** sync upserts by the unique connection-scoped key (repeated/concurrent sync
makes no duplicates); a previously-seen account now missing becomes **stale** (retained, never deleted);
`lastSyncAttemptedAt` updates on every attempt, `lastSyncedAt` only on success; a **decryption** failure
writes no account data and a **provider** failure preserves prior rows + `lastSyncedAt`. Linked-account
creation is **insert-then-claim** (a guarded `WHERE financial_account_id IS NULL` update; the orphan is
rolled back on a lost race), so a duplicate/concurrent call yields **exactly one** account.

**Transaction import (Finance 1B.3A — manual, read-only).** A manual **`Sync transactions`** action
runs Plaid `/transactions/sync` and stores results in `imported_transactions` as **bank EVIDENCE, not
Xanther commands**: an imported transaction **never** creates an `account_movements` row, mutates a
provider/manual balance, or confirms a bill/income/transfer. The `/finances` **Imported activity**
section is kept separate from **Recent activity** (the Xanther/manual-command ledger). Amounts are
normalized to Xanther's convention (inflow +, outflow −; a **$0** transaction is the documented
exception — it is skipped, not stored). **No webhooks** in 1B.3A (deferred to 1B.3B); **no matching, no
money movement.**

- **Atomic fetch → buffer → commit (cursor rule):** the **entire** Plaid page sequence is fetched into
  memory **first** (no durable writes); the complete aggregated patch (added/modified upserts + removed
  tombstones), the final cursor, and the success timestamp are then applied **together in one writable-
  CTE statement** (atomic — rolls back wholesale on any error; neon-http has no interactive
  transactions). A `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` **discards the accumulation and
  restarts from the original committed cursor** (bounded 5 retries). Reaching the 25-page limit while
  `has_more` is still true **fails closed** (no patch; cursor preserved). Any provider/normalization/
  DB-apply failure persists **no** patch and preserves the prior cursor + prior success timestamp; a
  later retry restarts safely. **No imported-transaction mutation from a failed or abandoned pagination
  attempt is ever durable.**
- **Added/modified/removed:** added/modified upsert by `(connection_id, provider_transaction_id)`
  (`firstSeenAt` preserved); **removed → tombstone** (`status='removed'` + `removedAt`, never
  hard-deleted, excluded from active views); an **unknown removal is safely ignored and counted** (the
  documented rule — no invented row).
- **Pending → posted:** once an active posted transaction references a pending one via
  `pendingProviderTransactionId`, the pending row is suppressed from active views (Plaid also tombstones
  it) — **no permanent double-count**; the relationship is preserved; **no guessed** relationship.
- **Concurrency:** a **per-connection DB lock** (`transaction_sync_locked_at`, claimed atomically with a
  5-min stale reclaim, released in a finally) + the connection-scoped unique index prevent cursor
  corruption and duplicate rows — not a button-disable. A token-decryption or provider failure writes
  nothing and preserves the prior committed cursor.
- **No secrets / no over-collection:** the access token is decrypted server-side only for the provider
  call; routes/views expose no token, encryption field, provider transaction id, or full account
  number; only bounded normalized fields are stored (never the raw Plaid payload). `imported_transactions`
  cascades when its (deletable, unmapped) connection is removed; its `financial_account_id` is SET NULL
  on a linked account's deletion (evidence survives as "not added to Xanther").

**No orphaned linked accounts (lifecycle safety):** a financial connection (or provider-account record)
can **never** be hard-deleted while any provider account is linked to a Xanther account — that would
leave a `balanceSource='linked'` account with no provider authority. Three layers enforce this: the
`provider_accounts.connection_id` FK is **`ON DELETE NO ACTION`** (the DB refuses to delete a connection
that still has provider-account rows); `deleteConnection` **rejects** a connection with any mapped
provider account (bounded **409**, *"This connection has linked Xanther accounts and cannot be removed
yet."*, mutating nothing, no token/id in the error) and otherwise deletes the unmapped snapshots + the
connection in one race-safe guarded statement; and the Sandbox cleanup helper tears down in a safe order
(clear mapping → delete the linked account → delete the provider row), never touching a manual account.
The full disconnect/archive/token-revocation lifecycle is deferred (Finance 1B.9).

**Existing-manual mapping is DEFERRED** to a later phase (it needs final reconciliation, a transition
timestamp, movement preservation, duplicate safeguards, rollback rules, and explicit authority-handoff
confirmation). 1B.2 only creates a **new** linked account; Chase/BofA are never merged, renamed, or
converted.

**Still not functional (later phases):** transaction sync, webhooks, transaction matching, bill/income/
transfer confirmation from imported evidence, the manual→linked transition, real Production/OAuth.

## Sandbox Link lifecycle (Finance 1B.1 — what is functional now)

1. Owner clicks **Connect bank** on `/finances` → `POST /api/finances/connections/link-token`.
2. Server (Sandbox-guarded) creates a short-lived Plaid **Link token** and returns only
   `linkToken` + `expiresAt` (never the client id, secret, or any token).
3. Browser launches **Plaid Link** (official CDN script) and the owner picks a **fake Sandbox
   institution** + completes the fake login → Link returns a temporary **public token**.
4. Browser posts the public token to `POST /api/finances/connections/exchange`.
5. Server exchanges it for the Plaid **access token** + `item_id`, fetches bounded institution
   metadata, **AES-256-GCM-encrypts** the access token, and inserts ONE `financial_connections`
   row. The plaintext token is never written, returned, or logged.
6. `GET /api/finances/connections` returns nonsecret connection views; the UI shows a truthful
   **Sandbox** status. `DELETE /…/[id]` is an owner-scoped Sandbox cleanup (revoke + delete the
   row only).

**Duplicate & retry:** `provider_item_id` is unique within `(user_id, provider)`; a repeated
exchange (double-click, browser retry, duplicate Item) returns the **existing** nonsecret view —
never a second row. A **Plaid failure** or an **encryption failure** writes **nothing**; owner
cancellation never calls exchange, so nothing is stored.

**Plaid adapter boundary:** the official `plaid` server SDK is imported **only** inside
`lib/providers/plaid/` (client + adapter). The adapter implements the 1B.0 `BankProvider` subset
and normalizes every response into the provider-neutral DTOs — raw Plaid types never escape the
folder. The browser bundle contains **no** Plaid server SDK (it uses Plaid's Link CDN script).

**Sandbox-only guard:** `lib/providers/plaid/env.ts` reads credentials lazily and **fails
closed** — `PLAID_ENV` must equal `sandbox`, and the client is pinned to the Sandbox base path,
so **no Production endpoint is reachable**. A non-sandbox or missing value is rejected before any
provider call; rejection messages name the variable, never its value.

**Encrypted connection storage:** only the AES-256-GCM envelope is persisted
(`access_token_cipher`/`_nonce`/`_tag`/`_key_version`/`_envelope_version`). There is **no
plaintext-token column**. Decryption happens server-side only (e.g. for Sandbox revoke).

## Netlify environment-variable setup (no Google Drive, no downloaded `.env`)

The owner entered `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV=sandbox`, and
`BANK_TOKEN_ENC_KEY` into **Netlify** using Netlify's `.env`-content import — there is **no
requirement for Google Drive or a committed `.env` file**. For **local** execution (the dev
server, scripts), the same variable *names* must be available locally — e.g. an **untracked
`.env.local`** (git-ignored, beside `package.json`) that the owner populates, or `netlify dev`
if the repo is linked. `BANK_TOKEN_ENC_KEY` must be the **same** value locally and in Netlify so
ciphertext stays compatible.

## Webhook verification + automatic sync (Finance 1B.3B)

`POST /api/webhooks/plaid` is **public** (Plaid calls it, not the owner) and is **exempt from the
owner-session gate** in `middleware.ts`. Trust comes ONLY from cryptographic verification, never a
login session:
- the `Plaid-Verification` header is a JWT that must be **ES256** (verified with `jose`, never
  hand-rolled); its key is fetched by `kid` from Plaid's verification-key endpoint and **cached by
  env+kid** with a bounded TTL (access tokens are never cached here);
- the `iat` must be within **5 minutes**; SHA-256 of the **exact raw body** must constant-time-match the
  signed `request_body_sha256`. Any missing/malformed/wrong-alg/unknown-key/bad-signature/stale/body-
  mismatch fails closed.

A verified webhook is only a **notification** — transactions are always retrieved via the existing
`/transactions/sync` lifecycle. Intake durably records a bounded, non-secret `plaid_webhook_events` row
(idempotent by `body_hash`; **no token/encryption-field/raw-payload/account-number/transaction stored**),
then the route **ack's promptly** (Plaid's 10-second window) and processing happens **durably in the
background** — the route does **not** run the full sync inline. The **active primary processor** is a
**Netlify Background Function** (`netlify/functions/process-plaid-webhooks-background.mts`; the
`-background` suffix → returns 202, runs ~15 min, Netlify auto-retries), triggered by the route only
after the event is durably stored. **Middleware bypass + observed dispatch (live-deploy fix):** the
login middleware (a Netlify **edge function**) must **bypass `/.netlify/functions/`** — otherwise it
307's the server-to-server worker trigger to `/login` and the worker is never invoked. The bypass is
narrow (only `/.netlify/functions/`; owner pages/APIs stay gated) and does **not** weaken worker auth
(still the in-function `X-Xanther-Webhook-Processor-Key` check). The route's trigger uses
`redirect: "manual"`, **inspects the response status**, and treats **only HTTP 202** (Netlify background
acceptance) as a successful dispatch; a login redirect / HTML fallback / 401 / 404 / 5xx / network error
is a bounded, non-secret, non-URL logged failure that leaves the event for the drainer — it is **never**
silently treated as success. It claims pending/failed/**stale-`processing`** events **atomically**
(overlapping invocations can't double-process), runs the existing fetch→buffer→atomic sync, marks
`processed` only on success, and on failure preserves the event (bounded retry) + the prior cursor +
imported state. **Stale-claim recovery:** a `processing` claim older than **5 minutes** (a crashed/
timed-out worker) is re-claimable. The **active recovery backstop** is the **enabled** scheduled drainer
`netlify/functions/drain-plaid-webhooks.mts` (every 10 min, small bounded batch, same atomic claim). The
connection is resolved by `provider_item_id` (never a body-supplied user id); an unknown item or a
non-sandbox connection mutates no owner data. The **manual Sync transactions** button remains.
**Invariant:** a verified, durably stored event is never acked-then-lost — it stays recoverably pending/
processing/failed until durably processed/ignored or truthfully retry-exhausted.

**Internal processor access control.** The Background Function endpoint is publicly reachable, so it is
protected by a **dedicated server-only secret** `PLAID_WEBHOOK_PROCESSOR_SECRET` — deliberately **not**
`PLAID_SECRET`, `BANK_TOKEN_ENC_KEY`, a session secret, an access token, or the webhook JWT. The webhook
route sends it in a bounded header `X-Xanther-Webhook-Processor-Key` **server-to-server only** (never to
Plaid, the browser, or a Link-token response). The function reads the expected secret server-side, reads
the supplied header, **constant-time compares** (`timingSafeEqual`, length-guarded), and rejects missing/
incorrect credentials with a generic **401** **before any database query, claim, or Plaid call**; a
missing server-side secret **fails closed**; the credential is never logged or returned. The **scheduled
drainer** calls the shared processing service **directly** from trusted Netlify scheduled execution — it
requires no HTTP secret and remains the recovery path if Background Function triggering is unauthorized
or fails. **Invariant:** no unauthenticated/incorrectly-authenticated caller can cause webhook-event
processing work. If the secret is unset, the owner-facing status truthfully says automatic processing
isn't fully configured and the manual button still works.

**Deployment requirements (Finance 1B.3B):** set **`PLAID_WEBHOOK_URL`** (server-only, HTTPS, pointing
at the deployed `/api/webhooks/plaid`) **and `PLAID_WEBHOOK_PROCESSOR_SECRET`** (server-only, a strong
random value dedicated to internal processor authorization) in Netlify; new Link tokens then include the
URL, and an existing Sandbox Item can be updated via `configureConnectionWebhook` (Plaid Item webhook-
update). Apply migration `0015`. The **background processor** + the **scheduled drainer** are active
in-code (their schedules/triggers are declared in the function files, not gated by `netlify.toml`), so
no extra enabling step is needed. Without `PLAID_WEBHOOK_URL`, automatic updates degrade truthfully (the
UI says they aren't configured); without `PLAID_WEBHOOK_PROCESSOR_SECRET`, the background trigger fails
closed (the UI says background processing isn't fully configured) and the scheduled drainer still
recovers events — the manual button works in both cases.

## Transaction-matching suggestions (Finance 1B.4A)

Xanther now **suggests** relationships between imported bank evidence and the owner's finance records —
**deterministic (no AI), suggestion-only, owner-confirmed, Sandbox-scoped, no money movement.** A
suggestion is just a proposal: it **mutates neither side** (no bill paid, income received, transfer
completed, movement, balance, provider snapshot, or transaction cursor; the imported transaction is
never hidden). Three types only: `bill_payment`, `income_receipt`, `transfer_pair`. Each is scored
**0–100** with bounded **reason codes** + a **confidence band** (high ≥80 / medium 60–79 / low 50–59;
min 50 to persist) using documented amount tolerances + America/New_York date windows. Generation is a
manual **Find matches** action, idempotent by `(userId, matchKey)`, preserving confirmed/rejected
decisions and never reopening a rejected relationship.

**Suggestion vs. confirmation.** Only an explicit owner **Confirm** applies an effect, and only through
the EXISTING approved workflows — **Xanther never confirms its own suggestion, and there is no automatic
confirmation.** Bill confirm reuses `payBill` (a linked paid-account → marks paid + links the imported
transaction as evidence, with **no** balance change — the provider snapshot stays authoritative). Income
confirm reuses `receiveIncome` (manual destination only). **Transfer confirmation and linked-destination
income confirmation are a documented MODEL GAP and FAIL CLOSED** (HTTP 422 / not-confirmable in the UI):
imported transactions are evidence on a provider-authoritative linked account, `completeTransfer` rejects
linked accounts, and there is no evidence-only transfer-confirmation path — confirming would double-count,
so the behavior is **not invented**. Confirmation claims the suggestion atomically and reverts on failure
(neon-http has no interactive transactions), revalidates eligibility (removed/pending transaction →
rejected), is owner-scoped (foreign owner → 404), idempotent, and supersedes competing suggestions that
would reuse the same evidence. The confirmed suggestion row is the durable **evidence link** (which
transaction confirmed which record, the score/reasons, `reviewedAt`) — no columns were added to
bills/income/transfers. **No raw Plaid payload, token, or secret is stored** in `transaction_match_suggestions`.

## What is NOT functional yet (deferred to later 1B phases)

No transfer confirmation or linked-destination income confirmation (model gap — see 1B.4A above),
update/repair mode, real Chase/BofA (needs eligible Production + OAuth), or any money movement. **Before
Production:** Plaid Production onboarding + OAuth redirect registration, real-data 90-day history policy,
and operational monitoring.

## Approved first-version defaults (owner-approved)

- **Plaid** is the initial provider; the internal finance domain stays **provider-neutral**.
- **Sandbox-only** initially; Production/OAuth onboarding is a later owner-controlled step.
- **Cached** provider balances are sufficient initially; **no paid real-time balance refresh**.
- Initial real-data history import will eventually be **bounded to 90 days**.
- **All transaction matches require owner confirmation** in the initial version.
- Imported activity and Xanther actions will eventually appear in a **merged but
  source-labeled** activity view.
- **Disconnect preserves history** and leaves an archived/stale linked account.
- **Linked account balances are provider-authoritative**; **imported transactions are
  evidence**, never Xanther balance commands.
- Read-only Finance 1B performs **no money movement**.

## Provider-neutral boundary

The finance domain depends only on `lib/providers/bank-provider.ts` (`BankProvider`) and the
DTOs in `lib/providers/types.ts`. A concrete adapter (a future Plaid adapter under
`lib/providers/plaid/`) maps raw provider responses into these DTOs and must never leak
provider-native types, field names, or sign conventions past the boundary. There is **no
multi-provider registry** — when the Plaid adapter lands it simply `implements BankProvider`.

## Canonical transaction-sign convention

One convention, everywhere (`lib/providers/amount.ts`):

- **inflow** (money into an owned account) → **positive** (`> 0`)
- **outflow** (money out of an owned account) → **negative** (`< 0`)
- **zero is invalid** for an imported transaction (no provider-specific reason to support a
  $0 imported movement is enabled in the initial version)

Adapters normalize provider-native amounts via `toXantherAmount(raw, convention)` **before**
returning any DTO. Plaid's native convention is **outflow-positive** (a purchase is positive,
a deposit is negative), so the Plaid adapter will normalize with `"outflow_positive"`. **No
provider-native sign convention may leak into matching or UI services.**

Demonstrated normalization (see `scripts/verify-finance1b0.ts`): paycheck deposit → positive;
purchase/payment → negative; transfer withdrawal → negative; transfer deposit → positive.

## Manual-vs-linked balance authority

`lib/providers/balance-authority.ts` is a pure resolver (it does **not** change the projection
engine):

- A **manual** account's actual balance is `financial_accounts.currentBalance`.
- A **linked** account's actual balance is its **latest provider balance snapshot**, which is
  **provider-authoritative** (Xanther never overwrites it).
- A linked balance always carries an **`asOf`** freshness timestamp.
- A **stale/disconnected** linked account may expose its last-known balance **only when
  labeled stale**.
- A **missing** linked balance resolves to **`linked_unavailable` (actual = null)** and must
  **never silently fall back** to the old manual balance.
- Projections consume the resolved authoritative actual balance but **never overwrite it**.

Balances are **cached** (Plaid `/accounts/get`, typically refreshed ~daily for a healthy
Item). The UI must display a truthful **"last updated"** state and must not imply permanent
live accuracy. The paid real-time endpoint (`/accounts/balance/get`) is **not** used in the
initial version.

## Imported evidence vs. command ledger

- `account_movements` remains the **manual-command** balance history (append-only, signed,
  reversible) and is **not** polluted with imported activity.
- Linked-account **imported transactions are evidence/activity records** — they never create
  an `account_movements` row and never mutate a balance.
- Confirming a match on a **linked** account creates **zero** balance movements (the provider
  balance already reflects reality). This is the natural extension of the existing
  `balance_source = 'manual'` guards in `lib/services/finances.ts`.

## Token encryption model

A provider access token must later be **decrypted and used** to call the provider, so it
needs **reversible authenticated encryption** — **hashing is explicitly insufficient** (a
digest cannot be recovered). Implemented in `lib/providers/token-crypto.ts` using Node's
built-in `crypto`:

- **AES-256-GCM** (authenticated, tamper-evident).
- **Random 96-bit nonce per encryption** (same plaintext → different ciphertext each time).
- A **versioned envelope** `{ v, keyVersion, nonce, ciphertext, tag }` — `keyVersion` enables
  key rotation without losing older ciphertexts; `v` allows future structural changes.
- The **256-bit master key** is generated from **secure random bytes** (NOT a human
  password) and supplied **only** through the server-side env var `BANK_TOKEN_ENC_KEY`, read
  **lazily at call time** (never at module load), so app startup never requires it before the
  bank feature is enabled.
- **Decrypt only server-side**, only immediately before a provider call. The module carries a runtime
  **server-only guard** (`if (typeof window !== "undefined") throw`) so it fails closed if ever bundled
  into client code — without adding a dependency. A transitive import-graph scan
  (`scripts/verify-finance1b0.ts`) proves no Client Component reaches it and no barrel re-exports it.
- **Fail closed everywhere:** the key decoder accepts only **strict base64 decoding to exactly 32
  bytes** (malformed encoding or wrong length is rejected); an unsupported envelope version, a missing
  nonce/ciphertext/tag/keyVersion, a tampered ciphertext or tag, and a wrong key each throw a
  `TokenCryptoError`; **no error message contains plaintext, ciphertext, token, key, or secret env
  value**.
- Malformed or authentication-failed ciphertext is **rejected** (throws `TokenCryptoError`).
- **No key or token** in browser code, logs, errors, URLs, snapshots, or repository files.
- **No real provider credential is created or stored** anywhere; tests use fake strings only.

### Three secret classes

1. **Environment secrets** — `PLAID_CLIENT_ID`, `PLAID_SECRET`, `BANK_TOKEN_ENC_KEY`
   (server-only).
2. **Per-user provider access tokens** — encrypted at rest via the envelope above.
3. **Non-secret provider IDs** — `item_id`, `account_id`, `transaction_id`: stored in clear
   but **never globally trusted** (always connection-scoped).

## Future environment-variable contract (names only — no values, not required at runtime yet)

| Name | Purpose | Class |
|---|---|---|
| `PLAID_CLIENT_ID` | Plaid client id | env secret |
| `PLAID_SECRET` | Plaid secret (per environment) | env secret |
| `PLAID_ENV` | `sandbox` \| `production` selector | env config |
| `BANK_TOKEN_ENC_KEY` | base64 of 32 secure-random bytes (AES-256 master key) | env secret |
| `PLAID_WEBHOOK_URL` | registered HTTPS webhook endpoint | env config |
| `PLAID_REDIRECT_URI` | registered HTTPS OAuth redirect URI | env config |

**Rules:**
- **None may use a `NEXT_PUBLIC_` prefix** (would expose them to the browser).
- Application startup **must not require** these before the bank feature is enabled.
- **Sandbox and Production secrets remain separate.**
- Logging **must redact** them; they appear in no client bundle.
- `BANK_TOKEN_ENC_KEY` must be generated from **secure random bytes**, not a human password.
- Do not edit Netlify configuration here and do not expose secret values.

## Durable pending-sync trigger design (planned — NOT implemented in 1B.0)

Xanther runs on Netlify + Neon with **no standing background worker and no message queue**.
The planning report's abstract "enqueue" is therefore realized with **durable state in Neon**,
not an imaginary queue:

1. A **verified** webhook (authenticity + replay checks) receives a provider update signal.
2. It **creates or updates a durable pending-sync request row** in Neon (a future
   `connection_sync_requests` table), keyed by connection.
3. **Duplicate requests for the same connection collapse safely** (upsert / unique-per-
   connection-pending — a flurry of webhooks yields one pending request, not many).
4. A **bounded sync processor** performs the actual provider calls (paginating
   `/transactions/sync`).
5. **Cursor advancement occurs only after successful persistence** of a page; on error the
   **prior committed cursor is preserved** and the loop restarts from it (no partial advance).
6. The processor is **resumable** — it reads the committed cursor and pending state.
7. **No webhook handler performs an unbounded multipage synchronization** — the webhook only
   records the durable request and returns quickly.
8. **No imaginary queue or background worker is assumed.**

**Smallest realistic processor strategy for a later build** (to be chosen by the owner):
- a **bounded server-side processor invoked right after** recording the request (process a
  capped number of pages, then re-arm if `has_more`), **or**
- a **scheduled Netlify function / poller** that drains pending requests on an interval, **or**
- another explicitly supported mechanism.

**Now vs. planned:** the contracts, sign convention, balance-authority resolver, and token-
encryption module **exist now**. The webhook endpoint, the `connection_sync_requests` table,
the processor, the Plaid adapter, and all routes are **planned, not built**.

## Plaid owner-setup checklist (documentation only — do not supply credentials during 1B.0)

1. Create or confirm a **Plaid account/team**.
2. Obtain **Sandbox** credentials (client id + Sandbox secret).
3. Leave **Production** credentials **unset** initially.
4. Use **Sandbox test institutions and fake data only** — never real bank logins yet.
5. Register a **stable HTTPS redirect URI** in the Plaid dashboard before any real OAuth
   institution can be used.
6. Understand that **real Chase and Bank of America** connections require **eligible
   Production / trial access** and dashboard registration (Limited Production blocks OAuth for
   Chase/BofA/Wells Fargo; for teams created after 2026-04-15 it is replaced by Trial plans).
7. Confirm the **Transactions** product is enabled.
8. Record the **webhook and redirect URLs** later (when 1B.1 wires them).
9. **Never paste credentials** into Claude, GitHub, documentation, screenshots, or chat.

## What this is NOT

- Not a Plaid SDK install, not a Plaid adapter, not a bank-link route, not a webhook handler.
- Not a schema change, migration, or stored token.
- Not money movement of any kind. Bank sync is **not yet functional.**
