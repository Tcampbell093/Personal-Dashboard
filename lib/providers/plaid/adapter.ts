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
  LinkSession,
  ProviderAccessToken,
  ProviderAccount,
  ProviderBalance,
  PublicCredentialExchange,
} from "../types";
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

export const plaidAdapter: BankProvider = {
  providerName: "plaid",

  async createLinkSession(input: CreateLinkSessionInput): Promise<LinkSession> {
    const client = plaidClient();
    const resp = await client.linkTokenCreate({
      user: { client_user_id: String(input.userId) },
      client_name: "Xanther",
      // Minimum product for the bank-sync feature; 1B.1 only connects (it never
      // calls /transactions). The Item is created transactions-capable so later
      // phases need no re-auth.
      products: [Products.Transactions],
      country_codes: [CountryCode.Us],
      language: "en",
    });
    return { linkToken: resp.data.link_token, expiresAt: resp.data.expiration };
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

  // Deferred to later Finance 1B phases — fail loudly if called now.
  createUpdateLinkSession: notImplemented("createUpdateLinkSession"),
  syncTransactions: notImplemented("syncTransactions"),
  verifyWebhook: notImplemented("verifyWebhook"),
};

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
