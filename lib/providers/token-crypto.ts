/* =============================================================================
 * Xanther — provider-token encryption (Finance 1B.0)
 *
 * Authenticated, reversible encryption for a provider ACCESS TOKEN at rest.
 * A provider access token must later be DECRYPTED and used to call the provider,
 * so it requires reversible encryption — hashing is explicitly NOT used (a digest
 * cannot be recovered). This uses Node's built-in `crypto` only: AES-256-GCM
 * (authenticated, tamper-evident) with a random 96-bit nonce per encryption.
 *
 * Security rules (Finance 1B.0):
 *  - The 256-bit master key is supplied ONLY through a future server-side env var
 *    (`BANK_TOKEN_ENC_KEY`), read lazily at call time — never at module load, so
 *    app startup does not require it before the bank feature is enabled.
 *  - No key or token in browser code, logs, errors, URLs, snapshots, or repo
 *    files. This module never logs and never echoes plaintext or key bytes.
 *  - Decrypt only server-side, only immediately before a provider call.
 *  - The ciphertext envelope is VERSIONED (`v`) and carries a `keyVersion` so the
 *    key can be rotated without losing older ciphertexts.
 *  - Malformed or authentication-failed ciphertext is REJECTED (throws).
 *  - No real provider credential is created or stored anywhere. Tests use fake
 *    strings only.
 * ===========================================================================*/

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

// Server-only guard. This module handles secret key material and must never be
// bundled into client/browser code. The `server-only` package would add a
// dependency (out of Finance 1B.0 scope) AND throw under the Node test harness,
// so we fail closed at runtime instead: harmless on the server / in RSC / under
// Node (no `window`), and throws immediately in any browser bundle.
if (typeof window !== "undefined") {
  throw new Error("token-crypto is server-only and must not be imported in the browser.");
}

const ALGO = "aes-256-gcm";
const KEY_BYTES = 32; // AES-256
const NONCE_BYTES = 12; // 96-bit nonce recommended for GCM
const TAG_BYTES = 16; // GCM auth tag
const ENVELOPE_VERSION = 1;

/** Thrown for any encryption/decryption failure (never leaks secret material). */
export class TokenCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenCryptoError";
  }
}

/**
 * Versioned ciphertext envelope. Stored as-is (e.g. in a future
 * `financial_connections.access_token_cipher` column). Contains NO plaintext.
 */
export interface EncryptedToken {
  /** Envelope format version (for future structural changes). */
  readonly v: number;
  /** Which master key encrypted this (supports rotation). */
  readonly keyVersion: number;
  /** Base64 random nonce (unique per encryption). */
  readonly nonce: string;
  /** Base64 ciphertext. */
  readonly ciphertext: string;
  /** Base64 GCM authentication tag. */
  readonly tag: string;
}

/** A versioned master key: 32 random bytes + the version it represents. */
export interface MasterKey {
  readonly key: Buffer;
  readonly keyVersion: number;
}

function assertKey(master: MasterKey): void {
  if (!Buffer.isBuffer(master.key) || master.key.length !== KEY_BYTES) {
    throw new TokenCryptoError("Master key must be exactly 32 bytes (AES-256).");
  }
  if (!Number.isInteger(master.keyVersion) || master.keyVersion < 1) {
    throw new TokenCryptoError("keyVersion must be a positive integer.");
  }
}

/**
 * Encrypt a provider access token. The nonce is random per call, so encrypting
 * the same plaintext twice yields different ciphertext.
 */
export function encryptToken(plaintext: string, master: MasterKey): EncryptedToken {
  assertKey(master);
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new TokenCryptoError("Plaintext token must be a non-empty string.");
  }
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGO, master.key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: ENVELOPE_VERSION,
    keyVersion: master.keyVersion,
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: tag.toString("base64"),
  };
}

/**
 * Decrypt a previously encrypted token. Verifies the GCM auth tag — any
 * tampering, a wrong key, or a malformed envelope is REJECTED with a
 * TokenCryptoError (and never partially returned).
 */
export function decryptToken(envelope: EncryptedToken, master: MasterKey): string {
  assertKey(master);
  if (!envelope || typeof envelope !== "object") {
    throw new TokenCryptoError("Malformed ciphertext envelope.");
  }
  // Fail closed on any missing/mistyped field BEFORE touching key material.
  if (typeof envelope.v !== "number") {
    throw new TokenCryptoError("Malformed ciphertext envelope (missing version).");
  }
  if (envelope.v !== ENVELOPE_VERSION) {
    throw new TokenCryptoError(`Unsupported envelope version: ${String(envelope.v)}.`);
  }
  if (typeof envelope.keyVersion !== "number") {
    throw new TokenCryptoError("Malformed ciphertext envelope (missing keyVersion).");
  }
  if (typeof envelope.nonce !== "string" || typeof envelope.ciphertext !== "string" || typeof envelope.tag !== "string") {
    throw new TokenCryptoError("Malformed ciphertext envelope (missing nonce, ciphertext, or tag).");
  }
  if (envelope.keyVersion !== master.keyVersion) {
    throw new TokenCryptoError("keyVersion does not match the supplied master key.");
  }
  let nonce: Buffer;
  let ciphertext: Buffer;
  let tag: Buffer;
  try {
    nonce = Buffer.from(envelope.nonce, "base64");
    ciphertext = Buffer.from(envelope.ciphertext, "base64");
    tag = Buffer.from(envelope.tag, "base64");
  } catch {
    throw new TokenCryptoError("Malformed ciphertext envelope (bad base64).");
  }
  if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES || ciphertext.length === 0) {
    throw new TokenCryptoError("Malformed ciphertext envelope (bad field lengths).");
  }
  try {
    const decipher = createDecipheriv(ALGO, master.key, nonce);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString("utf8");
  } catch {
    // Wrong key or tampered ciphertext/tag — authentication failed.
    throw new TokenCryptoError("Ciphertext authentication failed (wrong key or tampered).");
  }
}

/**
 * Generate a fresh 256-bit master key from secure random bytes. The deployable
 * key is generated this way (NOT from a human password) and supplied via
 * `BANK_TOKEN_ENC_KEY`. Useful for tests and key-generation tooling.
 */
export function generateMasterKey(keyVersion: number): MasterKey {
  if (!Number.isInteger(keyVersion) || keyVersion < 1) {
    throw new TokenCryptoError("keyVersion must be a positive integer.");
  }
  return { key: randomBytes(KEY_BYTES), keyVersion };
}

/**
 * Resolve the master key from the server-side env var, LAZILY (only when called,
 * never at import). The env value is base64 of exactly 32 random bytes. Returns
 * null when unset so the rest of the app can boot without the bank feature
 * configured. This is the ONLY place the key env var is read.
 *
 * NOTE (Finance 1B.0): the env var is documented but not yet set anywhere; this
 * resolver is wired in a later build. It is never called at module load.
 */
export function resolveMasterKeyFromEnv(keyVersion = 1): MasterKey | null {
  const raw = process.env.BANK_TOKEN_ENC_KEY;
  if (!raw) return null;
  // Accept ONLY the documented encoding: standard base64. Node's Buffer.from is
  // lenient (it silently drops invalid characters), so validate the format
  // strictly and confirm the value round-trips, failing closed otherwise.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
    throw new TokenCryptoError("BANK_TOKEN_ENC_KEY is not valid base64.");
  }
  const key = Buffer.from(raw, "base64");
  if (key.toString("base64").replace(/=+$/, "") !== raw.replace(/=+$/, "")) {
    throw new TokenCryptoError("BANK_TOKEN_ENC_KEY is not valid base64.");
  }
  if (key.length !== KEY_BYTES) {
    throw new TokenCryptoError("BANK_TOKEN_ENC_KEY must decode to exactly 32 bytes.");
  }
  return { key, keyVersion };
}

/** Constant-time equality for two same-length secrets (defensive helper). */
export function secretsEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
