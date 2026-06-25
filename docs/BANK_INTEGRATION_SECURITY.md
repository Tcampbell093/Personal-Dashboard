# Bank Integration Security & Provider Foundation (Finance 1B)

> **Status: foundational preparation (Finance 1B.0).** Bank sync is **NOT functional**.
> Nothing here connects to a provider, stores a token, or moves money. Finance 1B is
> **read-only** and performs **no money movement**. This document is the bounded
> security/privacy reference for the bank-integration work; durable product principles
> remain in `docs/PRODUCT_VISION.md`, and the decision record is `docs/DECISIONS.md` (ADR-027).

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
