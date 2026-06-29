/* =============================================================================
 * Xanther — Plaid webhook signature verification (Finance 1B.3B, server-only)
 *
 * A Plaid webhook is a PUBLIC, unauthenticated request (Plaid calls it, not the
 * owner). Trust comes ONLY from cryptographic verification, NOT a login session:
 *   1. the `Plaid-Verification` header is a JWT signed with ES256;
 *   2. verify the JWT signature with the matching Plaid public key (JWK), fetched
 *      by `kid` from `/webhook_verification_key/get` (cached by env+kid, bounded);
 *   3. reject a stale `iat` (Plaid's documented 5-minute window);
 *   4. SHA-256 the EXACT raw body and constant-time-compare it to the signed
 *      `request_body_sha256`.
 * Cryptography is done by `jose` (maintained) — never hand-rolled. Access tokens
 * are NEVER touched or cached here.
 * ===========================================================================*/

// Server-only.
if (typeof window !== "undefined") {
  throw new Error("Plaid webhook verifier is server-only and must not be imported in the browser.");
}

import { createHash, timingSafeEqual } from "node:crypto";
import { decodeProtectedHeader, importJWK, jwtVerify, type JWK } from "jose";
import { plaidClient } from "./client";
import { readPlaidSandboxConfig } from "./env";

const IAT_MAX_AGE_SECONDS = 300; // Plaid's documented 5-minute window
const KEY_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // bounded cache (6h)

export class WebhookVerificationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "WebhookVerificationError";
    this.code = code;
  }
}

// Verification keys cached by `${env}:${kid}`. NEVER caches access tokens.
const keyCache = new Map<string, { jwk: JWK; cachedAt: number }>();

/** Case-insensitive header lookup. */
function header(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) if (k.toLowerCase() === lower) return headers[k];
  return undefined;
}

/** Fetch (and cache) a Plaid verification JWK by key id, scoped to the env. */
async function getVerificationKey(kid: string): Promise<JWK> {
  // Production/Sandbox keys cannot be mixed — the cache key includes the env, and
  // the client is the Sandbox-pinned client (readPlaidSandboxConfig fails closed).
  const env = readPlaidSandboxConfig().env; // "sandbox" or throws
  const cacheKey = `${env}:${kid}`;
  const cached = keyCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < KEY_CACHE_TTL_MS) return cached.jwk;

  let resp;
  try {
    resp = await plaidClient().webhookVerificationKeyGet({ key_id: kid });
  } catch {
    throw new WebhookVerificationError("UNKNOWN_KEY", "Verification key could not be retrieved.");
  }
  const key = resp.data.key as unknown as JWK & { expired_at?: number | null };
  if (!key || key.kty !== "EC") throw new WebhookVerificationError("UNKNOWN_KEY", "Verification key is invalid.");
  if (key.expired_at != null) throw new WebhookVerificationError("EXPIRED_KEY", "Verification key is expired.");
  keyCache.set(cacheKey, { jwk: key, cachedAt: Date.now() });
  return key;
}

/**
 * Verify a Plaid webhook. Throws WebhookVerificationError on ANY failure (missing
 * header, wrong alg, unknown key, bad signature, stale iat, body-hash mismatch).
 * On success returns the SHA-256 hex of the exact raw body (the idempotency key).
 */
export async function verifyPlaidWebhook(rawBody: string, headers: Readonly<Record<string, string>>): Promise<{ bodyHash: string }> {
  const token = header(headers, "Plaid-Verification");
  if (!token) throw new WebhookVerificationError("MISSING_HEADER", "Missing Plaid-Verification header.");

  // 1. Header: algorithm MUST be ES256; extract kid.
  let protectedHeader;
  try {
    protectedHeader = decodeProtectedHeader(token);
  } catch {
    throw new WebhookVerificationError("MALFORMED_JWT", "Malformed verification token.");
  }
  if (protectedHeader.alg !== "ES256") throw new WebhookVerificationError("WRONG_ALG", "Unsupported verification algorithm.");
  const kid = protectedHeader.kid;
  if (!kid) throw new WebhookVerificationError("MISSING_KID", "Verification token has no key id.");

  // 2. Fetch the matching key + verify the JWT signature (jose enforces ES256).
  const jwk = await getVerificationKey(kid);
  let payload;
  try {
    const key = await importJWK(jwk, "ES256");
    ({ payload } = await jwtVerify(token, key, { algorithms: ["ES256"] }));
  } catch {
    throw new WebhookVerificationError("BAD_SIGNATURE", "Verification signature is invalid.");
  }

  // 3. Reject a stale (or far-future) issued-at.
  const iat = typeof payload.iat === "number" ? payload.iat : NaN;
  const nowSec = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(iat) || nowSec - iat > IAT_MAX_AGE_SECONDS || iat - nowSec > 60) {
    throw new WebhookVerificationError("STALE", "Verification token is expired.");
  }

  // 4. SHA-256 the EXACT raw body; constant-time compare with the signed hash.
  const claimed = typeof payload.request_body_sha256 === "string" ? payload.request_body_sha256 : "";
  const computed = createHash("sha256").update(rawBody, "utf8").digest("hex");
  if (claimed.length !== computed.length || !timingSafeEqual(Buffer.from(claimed), Buffer.from(computed))) {
    throw new WebhookVerificationError("BODY_MISMATCH", "Verification body hash does not match.");
  }

  return { bodyHash: computed };
}

/** Test-only: clear the verification-key cache. */
export function __clearWebhookKeyCache(): void {
  keyCache.clear();
}

/** Test-only: inject a verification key so the accept path can be exercised with
 * a locally-generated ES256 keypair (no real Plaid private key needed). Scoped to
 * the env so Production/Sandbox keys can't be mixed. */
export function __setWebhookKeyForTest(env: string, kid: string, jwk: JWK): void {
  keyCache.set(`${env}:${kid}`, { jwk, cachedAt: Date.now() });
}
