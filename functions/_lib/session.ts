// This app's own staff session cookie — same home-rolled HMAC-signed
// approach as clienthub's functions/_lib/session.ts (see that file for the
// full reasoning vs. WorkOS's native sealed session), adapted for staff:
// the payload carries only workosUserId, not a clientId, since there is no
// "client" concept on this side of the system. Role is deliberately NOT
// baked into the cookie — every request re-reads the caller's current row
// from the shared `users` table (functions/_lib/roles.ts), so a role
// change or revocation takes effect on the very next request rather than
// waiting for the session to expire.
//
// Different cookie name (ck_session vs. clienthub's ch_session) so the two
// are never confused if ever inspected side by side, even though they run
// on different domains and could never actually collide.

import { hmacSha256Hex, timingSafeEqual } from "./crypto";

export const SESSION_COOKIE_NAME = "ck_session";
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 hours — shorter than clienthub's 30 days, since this is an internal staff tool, not a client portal; re-login daily is an acceptable tradeoff for tighter exposure if a staff device is lost/stolen.

export interface SessionPayload {
  workosUserId: string;
  issuedAt: number;
}

function base64UrlEncode(input: string): string {
  return btoa(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(input: string): string {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(input.length / 4) * 4, "=");
  return atob(padded);
}

export async function createSessionCookie(secret: string, payload: SessionPayload): Promise<string> {
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = await hmacSha256Hex(secret, encodedPayload);
  const value = `${encodedPayload}.${signature}`;

  const maxAgeSeconds = Math.floor(SESSION_MAX_AGE_MS / 1000);
  return `${SESSION_COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

function parseCookieHeader(cookieHeader: string | null): Record<string, string> {
  if (!cookieHeader) return {};
  const entries = cookieHeader.split(";").map((part) => {
    const eqIndex = part.indexOf("=");
    if (eqIndex === -1) return [part.trim(), ""] as const;
    return [part.slice(0, eqIndex).trim(), part.slice(eqIndex + 1).trim()] as const;
  });
  return Object.fromEntries(entries);
}

export async function verifySessionCookie(secret: string, cookieHeader: string | null): Promise<SessionPayload | null> {
  const cookies = parseCookieHeader(cookieHeader);
  const raw = cookies[SESSION_COOKIE_NAME];
  if (!raw) return null;

  const [encodedPayload, signature] = raw.split(".");
  if (!encodedPayload || !signature) return null;

  const expectedSignature = await hmacSha256Hex(secret, encodedPayload);
  if (!timingSafeEqual(signature, expectedSignature)) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(base64UrlDecode(encodedPayload)) as SessionPayload;
  } catch {
    return null;
  }

  if (typeof payload.workosUserId !== "string" || typeof payload.issuedAt !== "number") return null;
  if (Date.now() - payload.issuedAt > SESSION_MAX_AGE_MS) return null;

  return payload;
}
