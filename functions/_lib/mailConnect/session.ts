// Webmail Connect ("mail connect") session cookie: a user of a CLIENT'S OWN
// admin panel who was handed into webmail by a single-use launch code
// (./exchange.ts), never by a password. This is the third session type in
// this app, and it can't be mistaken for either of the other two: the
// staff session (../session.ts, `ck_session`) or the mailbox-owner session
// (../mailClient/session.ts, `ck_mail_client_session`). Three independent
// layers enforce that, against BOTH of them, any one of which is enough:
//
//   1. Different cookie NAME. This module reads only
//      `ck_mail_connect_session`. The staff check reads only `ck_session`;
//      the mailbox-owner check reads only `ck_mail_client_session`. None of
//      the three ever looks at another's cookie.
//   2. Different SIGNED MESSAGE. Staff cookies are HMAC(SESSION_SECRET,
//      payload); mailbox-owner cookies are HMAC(SESSION_SECRET,
//      "client_mail_session.v1." + payload); these are HMAC(SESSION_SECRET,
//      "mail_connect_session.v1." + payload). A value copied from any one
//      cookie into either of the other names fails that verifier's
//      signature check, despite all three using the same secret.
//   3. Different PAYLOAD SHAPE. A connect payload must carry
//      kind === "mail_connect_session", integrationId, externalUserId,
//      launchId and issuedAt, and must NOT carry a staff field
//      (workosUserId) or a mailbox-owner field (mailAccountId,
//      emailAddress). The other two verifiers reject this shape in turn.
//
// The cookie is also scoped to Path=/api/mail-connect (browsers never send
// it to /api/app/* or /api/mail-client/*), SameSite=Strict, HttpOnly,
// Secure.
//
// The payload is IDENTITY ONLY: which integration, which of its users, and
// which launch created the session. It deliberately holds no mailbox list
// and no permission. Every route re-derives the caller's current grants
// from mail_external_mailbox_access (./account.ts) on every request, so a
// revoked grant, a disabled integration or a suspended service takes
// effect on the very next request, with no session refresh. launchId is
// not permission-bearing either: it only lets /me look up that launch's
// return URL, and that lookup is itself scoped to this integration + user.

import { hmacSha256Hex, timingSafeEqual } from "../crypto";

export const MAIL_CONNECT_COOKIE_NAME = "ck_mail_connect_session";
export const MAIL_CONNECT_COOKIE_PATH = "/api/mail-connect";
export const MAIL_CONNECT_SESSION_KIND = "mail_connect_session";
// Mixed into the HMAC input (layer 2 above). Never reuse this string for
// any other signed value.
const SIGNING_CONTEXT = "mail_connect_session.v1.";
// Shorter than the 12 h staff and mailbox-owner sessions: getting a fresh
// one is a single click on "Mail" in the panel, so there's no reason to
// keep a handed-over session alive for a whole day.
export const MAIL_CONNECT_SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_ID_LENGTH = 200;

export interface MailConnectSessionPayload {
  kind: typeof MAIL_CONNECT_SESSION_KIND;
  integrationId: string;
  externalUserId: string;
  launchId: string;
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
export async function signMailConnectSession(secret: string, payload: MailConnectSessionPayload): Promise<string> {
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  return `${encodedPayload}.${await sign(secret, encodedPayload)}`;
}

export async function createMailConnectSessionCookie(secret: string, identity: { integrationId: string; externalUserId: string; launchId: string }): Promise<string> {
  const value = await signMailConnectSession(secret, {
    kind: MAIL_CONNECT_SESSION_KIND,
    integrationId: identity.integrationId,
    externalUserId: identity.externalUserId,
    launchId: identity.launchId,
    issuedAt: Date.now(),
  });
  const maxAgeSeconds = Math.floor(MAIL_CONNECT_SESSION_MAX_AGE_MS / 1000);
  return `${MAIL_CONNECT_COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Strict; Path=${MAIL_CONNECT_COOKIE_PATH}; Max-Age=${maxAgeSeconds}`;
}

export function clearMailConnectSessionCookie(): string {
  return `${MAIL_CONNECT_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=${MAIL_CONNECT_COOKIE_PATH}; Max-Age=0`;
}

// Reads ONLY the cookie named MAIL_CONNECT_COOKIE_NAME. A header carrying
// it more than once is refused outright rather than guessing which wins.
function readOwnCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  let found: string | null = null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== MAIL_CONNECT_COOKIE_NAME) continue;
    if (found !== null) return null;
    found = part.slice(eq + 1).trim();
  }
  return found;
}

const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= MAX_ID_LENGTH;

export async function verifyMailConnectSessionCookie(secret: string, cookieHeader: string | null): Promise<MailConnectSessionPayload | null> {
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

  if (payload.kind !== MAIL_CONNECT_SESSION_KIND) return null;
  if (!isId(payload.integrationId) || !isId(payload.externalUserId) || !isId(payload.launchId)) return null;
  if (typeof payload.issuedAt !== "number" || !Number.isFinite(payload.issuedAt)) return null;
  // Neither of the other two session types' fields may ride along here.
  if ("workosUserId" in payload || "mailAccountId" in payload || "emailAddress" in payload) return null;
  const age = Date.now() - payload.issuedAt;
  if (age > MAIL_CONNECT_SESSION_MAX_AGE_MS || age < -CLOCK_SKEW_MS) return null;

  return {
    kind: MAIL_CONNECT_SESSION_KIND,
    integrationId: payload.integrationId,
    externalUserId: payload.externalUserId,
    launchId: payload.launchId,
    issuedAt: payload.issuedAt,
  };
}
