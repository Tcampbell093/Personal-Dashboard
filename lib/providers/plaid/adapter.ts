/* =============================================================================
 * Xanther — Plaid adapter (Finance 1B.1, server-only)
 *
 * Implements the Finance 1B.0 provider-neutral `BankProvider` contract for the
 * Sandbox connection flow. ONLY the methods this phase needs are implemented:
 * createLinkSession, exchangePublicCredential, getConnectionMetadata, and
 * revokeConnection (for Sandbox cleanup). Everything else (accounts, balances,
 * transaction sync, webhooks, update mode) throws "not implemented in 1B.1".
 *
 * Raw `plaid` response types never escape this folder — every return value is a
 * provider-neutral DTO. No money movement exists anywhere in this adapter.
 * ===========================================================================*/

// Server-only.
if (typeof window !== "undefined") {
  throw new Error("Plaid adapter is server-only and must not be imported in the browser.");
}

import { CountryCode, Products } from "plaid";
import type { BankProvider } from "../bank-provider";
import type {
  ConnectionMetadata,
  CreateLinkSessionInput,
  ImportedTransactionDTO,
  LinkSession,
  ProviderAccessToken,
  ProviderAccount,
  ProviderBalance,
  PublicCredentialExchange,
  RemovedTransactionRef,
  TransactionSyncPage,
  VerifiedWebhook,
} from "../types";
import { verifyPlaidWebhook, WebhookVerificationError } from "./webhook";
import { MutationDuringPaginationError } from "../types";
import { toXantherAmount } from "../amount";
import { plaidClient } from "./client";

const notImplemented = (method: string) => async (): Promise<never> => {
  throw new Error(`Plaid adapter: ${method} is not implemented in this Finance 1B phase.`);
};

/**
 * Normalize a Plaid (type, subtype) into Xanther's bounded account vocabulary.
 * Plaid-specific strings never leave this folder. Conservative: anything not a
 * clear checking/savings/credit becomes `other` — investment/loan/brokerage
 * semantics are NOT guessed in this phase. (Plaid credit `balances.current` is
 * the POSITIVE amount owed, matching Xanther's existing liability convention, so
 * it is stored unflipped and excluded from cash/spendable.)
 */
export function normalizePlaidAccountType(type: string | null, subtype: string | null): string {
  if (type === "credit") return "credit";
  if (type === "depository") {
    if (subtype === "checking") return "checking";
    if (subtype === "savings") return "savings";
  }
  return "other";
}

/**
 * Normalize a Plaid transaction amount into Xanther's convention. Plaid is
 * outflow-positive (a purchase is positive, a deposit is negative), so the
 * Xanther amount is the negation. Returns `null` for the documented exception —
 * a $0 (or non-finite) transaction carries no balance evidence and is SKIPPED
 * (not stored). Inflow → positive, outflow → negative.
 */
export function normalizePlaidTransactionAmount(plaidAmount: number): number | null {
  if (!Number.isFinite(plaidAmount) || plaidAmount === 0) return null;
  return toXantherAmount(plaidAmount, "outflow_positive");
}

/** Map one raw Plaid transaction to a normalized DTO, or null to SKIP ($0). */
function toTransactionDTO(t: {
  transaction_id: string;
  account_id: string;
  pending_transaction_id?: string | null;
  pending: boolean;
  amount: number;
  iso_currency_code?: string | null;
  name: string;
  original_description?: string | null;
  merchant_name?: string | null;
  authorized_date?: string | null;
  date: string;
  personal_finance_category?: { primary?: string | null; detailed?: string | null } | null;
}): ImportedTransactionDTO | null {
  const amount = normalizePlaidTransactionAmount(t.amount);
  if (amount === null) return null; // $0 — skipped (documented)
  return {
    providerTransactionId: t.transaction_id,
    providerAccountId: t.account_id,
    pendingProviderTransactionId: t.pending_transaction_id ?? null,
    isPending: t.pending,
    amount,
    isoCurrencyCode: t.iso_currency_code ?? null,
    descriptionCurrent: t.name,
    descriptionOriginal: t.original_description ?? null,
    merchantName: t.merchant_name ?? null,
    authorizedDate: t.authorized_date ?? null,
    postedDate: t.date ?? null,
    categoryPrimary: t.personal_finance_category?.primary ?? null,
    categoryDetailed: t.personal_finance_category?.detailed ?? null,
  };
}

export const plaidAdapter: BankProvider = {
  providerName: "plaid",

  async createLinkSession(input: CreateLinkSessionInput): Promise<LinkSession> {
    const client = plaidClient();
    // Finance 1B.3B: attach the webhook URL (server-only env) so new Items send
    // SYNC_UPDATES_AVAILABLE. Omitted when unset (manual sync still works).
    const webhook = process.env.PLAID_WEBHOOK_URL;
    const resp = await client.linkTokenCreate({
      user: { client_user_id: String(input.userId) },
      client_name: "Xanther",
      // Minimum product for the bank-sync feature; 1B.1 only connects (it never
      // calls /transactions). The Item is created transactions-capable so later
      // phases need no re-auth.
      products: [Products.Transactions],
      country_codes: [CountryCode.Us],
      language: "en",
      ...(webhook ? { webhook } : {}),
    });
    return { linkToken: resp.data.link_token, expiresAt: resp.data.expiration };
  },

  // Finance 1B.3B: verify a Plaid webhook (ES256 signature + raw-body hash + iat),
  // then parse the verified body for the bounded event fields.
  async verifyWebhook(input: { headers: Readonly<Record<string, string>>; rawBody: string }): Promise<VerifiedWebhook> {
    const { bodyHash } = await verifyPlaidWebhook(input.rawBody, input.headers);
    let body: { webhook_type?: string; webhook_code?: string; item_id?: string; request_id?: string };
    try {
      body = JSON.parse(input.rawBody);
    } catch {
      throw new WebhookVerificationError("MALFORMED_BODY", "Webhook body is not valid JSON.");
    }
    if (!body.webhook_type || !body.webhook_code || !body.item_id) {
      throw new WebhookVerificationError("INCOMPLETE_BODY", "Webhook body is missing required fields.");
    }
    return {
      providerItemId: body.item_id,
      webhookType: body.webhook_type,
      webhookCode: body.webhook_code,
      providerRequestId: body.request_id ?? null,
      bodyHash,
      verified: true,
    };
  },

  async exchangePublicCredential(input: { publicToken: string }): Promise<PublicCredentialExchange> {
    const client = plaidClient();
    const resp = await client.itemPublicTokenExchange({ public_token: input.publicToken });
    // The access token is SECRET — it is returned here only so the caller can
    // encrypt it immediately. It is never logged.
    return {
      providerAccessToken: resp.data.access_token as ProviderAccessToken,
      providerItemId: resp.data.item_id,
    };
  },

  async getConnectionMetadata(access: ProviderAccessToken): Promise<ConnectionMetadata> {
    const client = plaidClient();
    const itemResp = await client.itemGet({ access_token: access });
    const item = itemResp.data.item;
    const institutionId = item.institution_id ?? null;
    let institutionName: string | null = null;
    if (institutionId) {
      try {
        const inst = await client.institutionsGetById({
          institution_id: institutionId,
          country_codes: [CountryCode.Us],
        });
        institutionName = inst.data.institution.name ?? null;
      } catch {
        institutionName = null; // unavailable → caller falls back to a neutral label
      }
    }
    return { providerItemId: item.item_id, institutionId, institutionName, status: "active" };
  },

  async revokeConnection(access: ProviderAccessToken): Promise<void> {
    const client = plaidClient();
    await client.itemRemove({ access_token: access });
  },

  // Finance 1B.2: cached account discovery + balances via /accounts/get (cached,
  // free). Raw Plaid account objects are mapped to provider-neutral DTOs here.
  async listAccounts(access: ProviderAccessToken): Promise<ProviderAccount[]> {
    const client = plaidClient();
    const resp = await client.accountsGet({ access_token: access });
    return resp.data.accounts.map((a) => ({
      providerAccountId: a.account_id,
      mask: a.mask ?? null, // last 4 only
      name: a.name,
      officialName: a.official_name ?? null,
      type: normalizePlaidAccountType(a.type ?? null, a.subtype ?? null),
      subtype: a.subtype ?? null, // raw subtype string (display only)
    }));
  },

  async getCachedBalances(access: ProviderAccessToken): Promise<ProviderBalance[]> {
    const client = plaidClient();
    const resp = await client.accountsGet({ access_token: access }); // cached — NOT /accounts/balance/get
    return resp.data.accounts.map((a) => ({
      providerAccountId: a.account_id,
      current: a.balances.current ?? null,
      available: a.balances.available ?? null,
      isoCurrencyCode: a.balances.iso_currency_code ?? null,
      // Plaid does not return a per-account "as of" for cached balances; the
      // service stamps freshness as the sync time. Null here keeps the adapter honest.
      asOf: null,
    }));
  },

  // Finance 1B.3A: incremental transaction sync (Plaid /transactions/sync). One
  // page per call; the caller paginates on `hasMore` and commits the cursor only
  // after every page persists. Raw Plaid transactions are normalized to DTOs here
  // ($0 transactions are skipped). Removed entries carry only ids.
  async syncTransactions(access: ProviderAccessToken, cursor: string | null): Promise<TransactionSyncPage> {
    const client = plaidClient();
    let resp;
    try {
      resp = await client.transactionsSync({
        access_token: access,
        ...(cursor ? { cursor } : {}),
      });
    } catch (e) {
      // Plaid reports a mid-pagination mutation → surface a provider-neutral signal
      // so the caller restarts the whole loop from the committed cursor.
      const code = (e as { response?: { data?: { error_code?: string } } })?.response?.data?.error_code;
      if (code === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION") throw new MutationDuringPaginationError();
      throw e;
    }
    const d = resp.data;
    const added: ImportedTransactionDTO[] = [];
    for (const t of d.added) { const dto = toTransactionDTO(t as Parameters<typeof toTransactionDTO>[0]); if (dto) added.push(dto); }
    const modified: ImportedTransactionDTO[] = [];
    for (const t of d.modified) { const dto = toTransactionDTO(t as Parameters<typeof toTransactionDTO>[0]); if (dto) modified.push(dto); }
    const removed: RemovedTransactionRef[] = d.removed.map((r) => ({
      providerTransactionId: r.transaction_id ?? "",
      providerAccountId: r.account_id ?? "",
    }));
    return { added, modified, removed, nextCursor: d.next_cursor, hasMore: d.has_more };
  },

  // Deferred to later Finance 1B phases — fail loudly if called now.
  createUpdateLinkSession: notImplemented("createUpdateLinkSession"),
};

/** Finance 1B.3B: update an existing Item's webhook URL (Sandbox). Standalone
 * (not a BankProvider method); never logs the access token. */
export async function updateItemWebhook(access: ProviderAccessToken, webhookUrl: string): Promise<void> {
  await plaidClient().itemWebhookUpdate({ access_token: access, webhook: webhookUrl });
}

/**
 * SANDBOX-ONLY test helper: mint a public token for a fake Sandbox institution
 * WITHOUT the Link UI, so the verification harness can exercise the full
 * exchange→store path programmatically. Never used by app routes.
 */
export async function sandboxCreatePublicToken(institutionId = "ins_109508"): Promise<string> {
  const client = plaidClient();
  const resp = await client.sandboxPublicTokenCreate({
    institution_id: institutionId,
    initial_products: [Products.Transactions],
  });
  return resp.data.public_token;
}

/**
 * SANDBOX-ONLY test helper: inject specific fake transactions into a Sandbox Item
 * so the verification harness can deterministically exercise the import path.
 * `amount` here is Plaid-native (positive = outflow). Never used by app routes.
 */
export async function sandboxCreateTransactions(
  access: ProviderAccessToken,
  transactions: { date_transacted: string; date_posted: string; amount: number; description: string }[],
): Promise<void> {
  const client = plaidClient();
  await client.sandboxTransactionsCreate({ access_token: access, transactions });
}
