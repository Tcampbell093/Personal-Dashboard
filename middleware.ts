/* Auth gate. Runs on every request (except static assets). When the password
 * gate is configured, anything without a valid session cookie is redirected to
 * /login (pages) or rejected with 401 (API). When APP_PASSWORD is unset the
 * gate is off and everything passes — convenient for local dev. */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { verifySessionToken, COOKIE_NAME, isAuthConfigured } from "@/lib/session";

// Reachable without a session. The Plaid webhook (Finance 1B.3B) is PUBLIC by
// design — Plaid (not the owner) calls it, and its trust is the verified ES256
// signature, NOT the login session — so it must not be gated.
const PUBLIC_PATHS = new Set(["/login", "/api/login", "/api/logout", "/api/webhooks/plaid"]);

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Netlify Functions are platform infrastructure, NOT owner pages/APIs: the
  // owner-session/password gate must never apply to them, or it would 307 a
  // server-to-server worker trigger to /login (Finance 1B.3B runtime defect).
  // Worker authorization is handled INSIDE the function by the timing-safe
  // X-Xanther-Webhook-Processor-Key check — this bypass does not weaken it.
  // Narrow on purpose: only `/.netlify/functions/`, not all `/.netlify/*`.
  if (pathname.startsWith("/.netlify/functions/")) return NextResponse.next();

  if (!isAuthConfigured()) return NextResponse.next();

  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();

  const token = req.cookies.get(COOKIE_NAME)?.value;
  if (token && (await verifySessionToken(token))) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  // Run on everything except Next internals, the favicon, and Netlify Functions.
  // Excluding `.netlify/functions` means the middleware edge function never even
  // binds to the worker path, so the function router invokes the deployed worker
  // directly (defense in depth with the early code-level bypass above).
  matcher: ["/((?!_next/static|_next/image|favicon.ico|\\.netlify/functions).*)"],
};
