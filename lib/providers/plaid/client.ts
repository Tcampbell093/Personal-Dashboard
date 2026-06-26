/* =============================================================================
 * Xanther — Plaid server client (Finance 1B.1, server-only)
 *
 * Lazily constructs the official `plaid` server SDK client, pinned to the
 * **Sandbox** base path. The Production base path is never used, so no Production
 * endpoint is reachable through this build. Credentials are read only here (via
 * the env guard) and never logged. Raw `plaid` types stay inside this folder.
 * ===========================================================================*/

// Server-only: the Plaid server client carries credentials and must never be
// bundled into client/browser code.
if (typeof window !== "undefined") {
  throw new Error("Plaid server client is server-only and must not be imported in the browser.");
}

import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";
import { readPlaidSandboxConfig } from "./env";

let cached: PlaidApi | null = null;

/** The Sandbox-pinned Plaid client. Throws (fail closed) if env is not Sandbox. */
export function plaidClient(): PlaidApi {
  if (cached) return cached;
  const cfg = readPlaidSandboxConfig(); // throws unless PLAID_ENV === "sandbox" + creds present
  const configuration = new Configuration({
    basePath: PlaidEnvironments.sandbox, // hard Sandbox — never Production
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": cfg.clientId,
        "PLAID-SECRET": cfg.secret,
      },
    },
  });
  cached = new PlaidApi(configuration);
  return cached;
}

/** Test-only: drop the cached client so a later call re-reads env. */
export function __resetPlaidClient(): void {
  cached = null;
}
