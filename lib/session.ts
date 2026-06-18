/* Session token for the password gate.
 *
 * A signed JWT stored in an HttpOnly cookie. Uses `jose`, which runs in both
 * the Edge runtime (middleware) and Node (route handlers), so the same helpers
 * work everywhere. The gate is only active when APP_PASSWORD is set — with it
 * unset the app is open (handy for local dev; MUST be set before deploying). */

import { SignJWT, jwtVerify } from "jose";

export const COOKIE_NAME = "pcc_session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

/** Whether the password gate is switched on. */
export function isAuthConfigured(): boolean {
  return Boolean(process.env.APP_PASSWORD);
}

function secretKey(): Uint8Array {
  const s = process.env.AUTH_SECRET;
  if (!s) {
    throw new Error(
      "AUTH_SECRET is not set. It is required when APP_PASSWORD is set.",
    );
  }
  return new TextEncoder().encode(s);
}

export async function createSessionToken(): Promise<string> {
  return new SignJWT({ sub: "owner" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_SECONDS}s`)
    .sign(secretKey());
}

export async function verifySessionToken(token: string): Promise<boolean> {
  try {
    await jwtVerify(token, secretKey());
    return true;
  } catch {
    return false;
  }
}

export const SESSION_MAX_AGE = MAX_AGE_SECONDS;
