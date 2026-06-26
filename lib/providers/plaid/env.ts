/* =============================================================================
 * Xanther — Plaid environment guard (Finance 1B.1, server-only)
 *
 * Finance 1B.1 operates in **Plaid Sandbox only**. This module reads the Plaid
 * credentials LAZILY (never at import) and fails CLOSED:
 *  - `PLAID_ENV` must resolve to exactly `sandbox`; any other value (or unset) is
 *    rejected BEFORE any provider call — the app never silently defaults to
 *    Production and no Production endpoint is reachable through this build.
 *  - Missing `PLAID_CLIENT_ID` / `PLAID_SECRET` fails closed.
 *
 * Secret values are NEVER returned, logged, or echoed. Presence is reported by
 * variable NAME only; the rejection message never contains an env value.
 * ===========================================================================*/

// Server-only: these readers must never run in a browser bundle.
if (typeof window !== "undefined") {
  throw new Error("Plaid env guard is server-only and must not be imported in the browser.");
}

export class PlaidConfigError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PlaidConfigError";
    this.code = code;
  }
}

export interface PlaidSandboxConfig {
  readonly clientId: string;
  readonly secret: string;
  readonly env: "sandbox";
}

/**
 * Resolve + validate the Sandbox config. Throws `PlaidConfigError` (fail closed)
 * if PLAID_ENV is not `sandbox` or a credential is missing. The error message
 * names the offending variable but never includes its value.
 */
export function readPlaidSandboxConfig(): PlaidSandboxConfig {
  const env = process.env.PLAID_ENV;
  if (env !== "sandbox") {
    // Do NOT echo the actual value — only that it must be sandbox.
    throw new PlaidConfigError(
      "PLAID_ENV_NOT_SANDBOX",
      env ? "PLAID_ENV must be 'sandbox' in Finance 1B.1." : "PLAID_ENV is not set (must be 'sandbox').",
    );
  }
  const clientId = process.env.PLAID_CLIENT_ID;
  if (!clientId) throw new PlaidConfigError("PLAID_CLIENT_ID_MISSING", "PLAID_CLIENT_ID is not set.");
  const secret = process.env.PLAID_SECRET;
  if (!secret) throw new PlaidConfigError("PLAID_SECRET_MISSING", "PLAID_SECRET is not set.");
  return { clientId, secret, env: "sandbox" };
}

/**
 * Non-secret readiness report: which required NAMES are present and whether the
 * environment mode is sandbox. Never returns values, lengths, or any identifying
 * detail — only presence/missing and the mode label.
 */
export function sandboxReadiness(): {
  ready: boolean;
  mode: string;
  isSandbox: boolean;
  missing: string[];
} {
  const required = ["PLAID_CLIENT_ID", "PLAID_SECRET", "BANK_TOKEN_ENC_KEY"];
  const missing = required.filter((n) => {
    const v = process.env[n];
    return !v || v.length === 0;
  });
  const mode = process.env.PLAID_ENV ?? "(unset)";
  const isSandbox = mode === "sandbox";
  return { ready: isSandbox && missing.length === 0, mode, isSandbox, missing };
}
