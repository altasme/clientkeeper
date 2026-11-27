// POST /api/mail-client/login -- a mailbox owner signs in with the
// mailbox's own email address and its real password.
//
// How the password is checked: we never store or know it. The mailbox's
// SMTP server (resolved from mail_accounts.smtp_profile exactly the way
// outbound sending resolves it, @altasme/webmail-kit's resolveSmtpConfig)
// is asked to AUTH with the submitted password; 235 = correct. Nothing is
// sent. The password exists only in memory for that one AUTH attempt: it
// is not written to D1, not logged, not put in the cookie, not echoed in
// any response or error.
//
// The SMTP username used is the profile's configured username, and it must
// BE this mailbox's own address. If an operator ever pointed a client
// mailbox at a shared profile (e.g. the business relay login), refusing
// here stops a shared password from opening a client's mailbox.
//
// Failure responses are identical whatever went wrong (unknown address,
// ineligible mailbox, wrong password, SMTP unreachable), and every failure
// is padded to a minimum response time, so the response doesn't reveal
// whether an address exists. The real reason is recorded server-side only.
//
// Rate limiting (no KV/rate-limit binding exists on this Pages project, and
// the shared schema lives in clienthub, so no new table was added): failed
// attempts are written to the existing mail_events audit table and counted
// from there.
//   - per submitted email (existing or not): 5 failures / 15 min
//   - per client IP:                         20 failures / 15 min
// The keys are HMACs of the email/IP under SESSION_SECRET (no raw IP or
// unknown address is stored), namespaced "client-login:..." so they can
// never collide with a real account/message UUID, and placed in the two
// indexed columns (account_id with created_at; message_id). Counting per
// submitted email -- not only per real account -- is what keeps a lockout
// from revealing that an address exists. Only credential failures count;
// an SMTP outage doesn't lock anyone out. Trade-off, stated plainly:
// anyone can lock a mailbox's web login for 15 minutes with 5 wrong
// passwords (it does not affect the mailbox itself or staff access).

import { isValidEmail, normalizeEmail } from "@altasme/webmail-kit/address";
import { resolveSmtpConfig } from "@altasme/webmail-kit/config";
import { errorResponse, jsonResponse, readJsonBody } from "@altasme/webmail-kit/http";
import type { SmtpConfig, SmtpLoginResult } from "@altasme/webmail-kit/smtp";
import { hmacSha256Hex } from "../crypto";
import { findEligibleAccountByEmail } from "./account";
import { clientMailActorId, rejectCrossSite, type MailClientEnv } from "./handler";
import { createMailClientSessionCookie } from "./session";

export type SmtpLoginVerifier = (config: SmtpConfig, username: string, password: string) => Promise<SmtpLoginResult>;

export interface LoginDeps {
  verify: SmtpLoginVerifier;
  /** Every failure response takes at least this long (plus jitter). Tests pass 0. */
  minFailureMs?: number;
  now?: () => number;
}

export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const MAX_FAILURES_PER_EMAIL = 5;
export const MAX_FAILURES_PER_IP = 20;
export const LOGIN_FAILED_EVENT = "client_mail_login_failed";
export const LOGIN_ERROR_EVENT = "client_mail_login_error";
const GENERIC_FAILURE = "We couldn't sign you in. Check your email address and password and try again.";

type FailureReason = "invalid_input" | "no_eligible_mailbox" | "smtp_not_configured" | "profile_username_mismatch" | "auth_failed" | "connection_failed" | "timeout";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function loginKeys(secret: string, email: string, ip: string) {
  return {
    emailKey: `client-login:email:${(await hmacSha256Hex(secret, `client_mail_login.email.${email}`)).slice(0, 32)}`,
    ipKey: `client-login:ip:${(await hmacSha256Hex(secret, `client_mail_login.ip.${ip}`)).slice(0, 32)}`,
  };
}

async function recentFailures(db: D1Database, column: "account_id" | "message_id", key: string, sinceIso: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM mail_events WHERE ${column} = ? AND event_type = ? AND created_at > ?`)
    .bind(key, LOGIN_FAILED_EVENT, sinceIso)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function handleMailClientLogin(ctx: { request: Request; env: MailClientEnv }, deps: LoginDeps): Promise<Response> {
  const started = Date.now();
  const now = deps.now ?? Date.now;
  const db = ctx.env.DB;
  const secret = ctx.env.SESSION_SECRET;
  if (!db || !secret) return errorResponse(500, "Not configured");
  const csrf = rejectCrossSite(ctx.request);
  if (csrf) return csrf;

  const body = await readJsonBody(ctx.request);
  const rawEmail = typeof body?.email === "string" ? body.email : "";
  const password = typeof body?.password === "string" ? body.password : "";
  const email = normalizeEmail(rawEmail.slice(0, 320));
  const ip = ctx.request.headers.get("CF-Connecting-IP") || "unknown";
  const { emailKey, ipKey } = await loginKeys(secret, email, ip);

  // `counts` = whether this failure counts toward the lockout. Non-credential
  // failures (SMTP unreachable/timeout) are recorded under a different
  // event type so they're visible in the audit trail but never lock anyone out.
  const fail = async (reason: FailureReason, accountId: string | null, counts = true): Promise<Response> => {
    try {
      await db
        .prepare(`INSERT INTO mail_events (id, account_id, message_id, event_type, event_data, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(crypto.randomUUID(), emailKey, ipKey, counts ? LOGIN_FAILED_EVENT : LOGIN_ERROR_EVENT, JSON.stringify({ reason, accountId }), "client-login", new Date(now()).toISOString())
        .run();
    } catch (err) {
      console.error("client mail login: failure record not written", err instanceof Error ? err.message : err);
    }
    const floor = deps.minFailureMs ?? 1500;
    if (floor > 0) {
      const wait = floor + Math.floor(Math.random() * 400) - (Date.now() - started);
      if (wait > 0) await sleep(wait);
    }
    return errorResponse(401, GENERIC_FAILURE);
  };

  // Rate limits are checked before any lookup or SMTP traffic.
  const since = new Date(now() - LOGIN_WINDOW_MS).toISOString();
  if ((await recentFailures(db, "account_id", emailKey, since)) >= MAX_FAILURES_PER_EMAIL || (await recentFailures(db, "message_id", ipKey, since)) >= MAX_FAILURES_PER_IP) {
    return errorResponse(429, "Too many sign-in attempts. Please wait 15 minutes and try again.");
  }

  if (!isValidEmail(email) || !password || password.length > 1024) return fail("invalid_input", null);

  const account = await findEligibleAccountByEmail(db, email);
  if (!account) return fail("no_eligible_mailbox", null);
  const config = resolveSmtpConfig(ctx.env, account.smtpProfile, account.emailAddress);
  if (!config) return fail("smtp_not_configured", account.id);
  if (normalizeEmail(config.username) !== account.emailAddress) return fail("profile_username_mismatch", account.id);

  const result = await deps.verify(config, config.username, password);
  // Only a wrong password counts toward the lockout; an SMTP outage
  // shouldn't lock people out. (Unknown addresses always count, above.)
  if (!result.ok) return fail(result.reason, account.id, result.reason === "auth_failed");

  try {
    await db
      .prepare(`INSERT INTO mail_events (id, account_id, message_id, event_type, event_data, actor_id, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), account.id, "client_mail_login", JSON.stringify({ ipKey }), clientMailActorId(account.id), new Date(now()).toISOString())
      .run();
  } catch (err) {
    console.error("client mail login: audit not written", err instanceof Error ? err.message : err);
  }
  const cookie = await createMailClientSessionCookie(secret, { mailAccountId: account.id, emailAddress: account.emailAddress });
  return jsonResponse(200, { ok: true, emailAddress: account.emailAddress, displayName: account.displayName }, { "Set-Cookie": cookie });
}
