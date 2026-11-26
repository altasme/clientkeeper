// Mailbox-owner ("client mail") session cookie: someone who signed in to
// ONE mailbox at /mail/client-login with that mailbox's own password. This
// is a deliberately separate mechanism from the staff session in
// ../session.ts, and the two can never be mistaken for each other. Three
// independent layers enforce that, any one of which is sufficient:
//
//   1. Different cookie NAME. The staff check (verifySessionCookie in
//      ../session.ts) reads only `ck_session`; this module reads only
//      `ck_mail_client_session`. Neither ever looks at the other's cookie.
//   2. Different SIGNED MESSAGE. Staff cookies are HMAC(SESSION_SECRET,
//      payload). Client cookies are HMAC(SESSION_SECRET,
//      "client_mail_session.v1." + payload): a fixed domain-separation
//      prefix is mixed into what gets signed. So even if someone copies a
//      client cookie's value into a `ck_session` cookie (or the reverse),
//      the signature check fails, despite both using the same secret.
//   3. Different PAYLOAD SHAPE. A client payload must carry
//      kind === "client_mail_session" plus a mailAccountId/emailAddress; a
//      staff payload must carry a workosUserId. Each verifier rejects the
//      other's shape.
//
// The cookie is also scoped to Path=/api/mail-client, so the browser never
// even sends it to /api/app/* (the staff API), and SameSite=Strict, so it
// is never attached to a cross-site request (CSRF).
//
// The payload holds identifiers only. Eligibility (mailbox still active,
// still a client-hosted mailbox, service still active) is re-checked on
// every request by ./account.ts, like the staff side re-reads `users` on
// every request, so deactivating the mailbox ends the session on the very
// next request. The mailbox password is never part of this cookie.

import { hmacSha256Hex, timingSafeEqual } from "../crypto";

export const MAIL_CLIENT_COOKIE_NAME = "ck_mail_client_session";
export const MAIL_CLIENT_COOKIE_PATH = "/api/mail-client";
export const MAIL_CLIENT_SESSION_KIND = "client_mail_session";
// Mixed into the HMAC input (layer 2 above). Never reuse this string for
// any other signed value.
const SIGNING_CONTEXT = "client_mail_session.v1.";
export const MAIL_CLIENT_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000; // same window as the staff session
const CLOCK_SKEW_MS = 5 * 60 * 1000;

export interface MailClientSessionPayload {
  kind: typeof MAIL_CLIENT_SESSION_KIND;
  mailAccountId: string;
  emailAddress: string;
  issuedAt: number;
}

function base64UrlEncode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(input: string): string {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(input.length / 4) * 4, "=");
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
}

function sign(secret: string, encodedPayload: string): Promise<string> {
  return hmacSha256Hex(secret, `${SIGNING_CONTEXT}${encodedPayload}`);
}

/** The raw `value` part of the cookie (exported for tests). */
export async function signMailClientSession(secret: string, payload: MailClientSessionPayload): Promise<string> {
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  return `${encodedPayload}.${await sign(secret, encodedPayload)}`;
}

export async function createMailClientSessionCookie(secret: string, account: { mailAccountId: string; emailAddress: string }): Promise<string> {
  const value = await signMailClientSession(secret, {
    kind: MAIL_CLIENT_SESSION_KIND,
    mailAccountId: account.mailAccountId,
    emailAddress: account.emailAddress,
    issuedAt: Date.now(),
  });
  const maxAgeSeconds = Math.floor(MAIL_CLIENT_SESSION_MAX_AGE_MS / 1000);
  return `${MAIL_CLIENT_COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Strict; Path=${MAIL_CLIENT_COOKIE_PATH}; Max-Age=${maxAgeSeconds}`;
}

export function clearMailClientSessionCookie(): string {
  return `${MAIL_CLIENT_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=${MAIL_CLIENT_COOKIE_PATH}; Max-Age=0`;
}

// Reads ONLY the cookie named MAIL_CLIENT_COOKIE_NAME. A header carrying it
// more than once is refused outright rather than guessing which one wins.
function readOwnCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  let found: string | null = null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== MAIL_CLIENT_COOKIE_NAME) continue;
    if (found !== null) return null;
    found = part.slice(eq + 1).trim();
  }
  return found;
}

export async function verifyMailClientSessionCookie(secret: string, cookieHeader: string | null): Promise<MailClientSessionPayload | null> {
  const raw = readOwnCookie(cookieHeader);
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 2) return null;
  const [encodedPayload, signature] = parts as [string, string];
  if (!encodedPayload || !/^[0-9a-f]{64}$/.test(signature)) return null;

  const expected = await sign(secret, encodedPayload);
  if (!timingSafeEqual(signature, expected)) return null;

  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(base64UrlDecode(encodedPayload)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    payload = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  if (payload.kind !== MAIL_CLIENT_SESSION_KIND) return null;
  if (typeof payload.mailAccountId !== "string" || !payload.mailAccountId) return null;
  if (typeof payload.emailAddress !== "string" || !payload.emailAddress) return null;
  if (typeof payload.issuedAt !== "number" || !Number.isFinite(payload.issuedAt)) return null;
  // A staff payload's field must never ride along in a client session.
  if ("workosUserId" in payload) return null;
  const age = Date.now() - payload.issuedAt;
  if (age > MAIL_CLIENT_SESSION_MAX_AGE_MS || age < -CLOCK_SKEW_MS) return null;

  return { kind: MAIL_CLIENT_SESSION_KIND, mailAccountId: payload.mailAccountId, emailAddress: payload.emailAddress, issuedAt: payload.issuedAt };
}
