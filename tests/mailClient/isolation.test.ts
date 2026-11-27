// The staff session and the mailbox-owner ("client mail") session must be
// structurally incapable of standing in for each other (CLAUDE.md §36).
// These tests run the REAL guards: the staff middleware
// (functions/api/app/_middleware.ts) and the client guard
// (functions/_lib/mailClient/handler.ts, via the real /me route).
// Each rejection test has a matching positive control, so a guard that
// rejected everything would fail the suite.

import { test } from "node:test";
import assert from "node:assert/strict";
import { onRequest as staffMiddleware } from "../../functions/api/app/_middleware";
import { hmacSha256Hex } from "../../functions/_lib/crypto";
import { MAIL_CLIENT_COOKIE_NAME, signMailClientSession, verifyMailClientSessionCookie } from "../../functions/_lib/mailClient/session";
import { SESSION_COOKIE_NAME, verifySessionCookie } from "../../functions/_lib/session";
import { me, listMessagesRoute } from "../../functions/_lib/mailClient/routes";
import { A, S, SECRET, call, clientCookieFor, seedMail, staffCookie } from "./helpers";

const valueOf = (pair: string) => pair.slice(pair.indexOf("=") + 1);
const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");

// ---------- positive controls ----------

test("control: a valid staff cookie passes the staff middleware", async () => {
  const { env } = seedMail();
  const r = await call(staffMiddleware, env, "/api/app/me", { cookie: await staffCookie() });
  assert.equal(r.state.nextCalled, true);
  assert.equal((r.data.staffUser as { id: string }).id, "user_staff_owner");
});

test("control: a valid client cookie passes the client guard", async () => {
  const { env } = seedMail();
  const r = await call(me, env, "/api/mail-client/me", { cookie: await clientCookieFor(A) });
  assert.equal(r.status, 200);
  assert.equal(r.json?.emailAddress, A.email);
});

// ---------- staff session -> client routes ----------

test("a valid staff session grants nothing on client routes (no client cookie -> 401)", async () => {
  const { env } = seedMail();
  const cookie = await staffCookie();
  for (const fn of [me, listMessagesRoute]) {
    const r = await call(fn, env, "/api/mail-client/me", { cookie });
    assert.equal(r.status, 401);
  }
});

test("a staff cookie VALUE renamed to the client cookie name is rejected (different signed message)", async () => {
  const { env } = seedMail();
  const forged = `${MAIL_CLIENT_COOKIE_NAME}=${valueOf(await staffCookie())}`;
  const r = await call(me, env, "/api/mail-client/me", { cookie: forged });
  assert.equal(r.status, 401);
  assert.equal(await verifyMailClientSessionCookie(SECRET, forged), null);
});

test("a client-shaped payload signed the STAFF way (no domain prefix) is rejected by the client guard", async () => {
  const { env } = seedMail();
  const payload = b64url(JSON.stringify({ kind: "client_mail_session", mailAccountId: A.id, emailAddress: A.email, issuedAt: Date.now() }));
  const staffStyleSig = await hmacSha256Hex(SECRET, payload);
  const r = await call(me, env, "/api/mail-client/me", { cookie: `${MAIL_CLIENT_COOKIE_NAME}=${payload}.${staffStyleSig}` });
  assert.equal(r.status, 401);
});

test("a correctly client-signed payload carrying a staff field is rejected", async () => {
  const { env } = seedMail();
  const value = await signMailClientSession(SECRET, { kind: "client_mail_session", mailAccountId: A.id, emailAddress: A.email, issuedAt: Date.now(), workosUserId: "user_staff_owner" } as never);
  const r = await call(me, env, "/api/mail-client/me", { cookie: `${MAIL_CLIENT_COOKIE_NAME}=${value}` });
  assert.equal(r.status, 401);
});

// ---------- client session -> staff routes ----------

test("a valid client cookie grants nothing on the staff middleware (-> 401, route never reached)", async () => {
  const { env } = seedMail();
  const r = await call(staffMiddleware, env, "/api/app/mail/messages", { cookie: await clientCookieFor(A) });
  assert.equal(r.status, 401);
  assert.equal(r.state.nextCalled, false);
});

test("a client cookie VALUE renamed to ck_session is rejected by the staff middleware", async () => {
  const { env } = seedMail();
  const forged = `${SESSION_COOKIE_NAME}=${valueOf(await clientCookieFor(A))}`;
  const r = await call(staffMiddleware, env, "/api/app/mail/messages", { cookie: forged });
  assert.equal(r.status, 401);
  assert.equal(r.state.nextCalled, false);
  assert.equal(await verifySessionCookie(SECRET, forged), null);
});

test("a staff-shaped payload signed the CLIENT way is rejected by the staff middleware", async () => {
  const { env } = seedMail();
  const value = await signMailClientSession(SECRET, { workosUserId: "user_staff_owner", issuedAt: Date.now() } as never);
  const r = await call(staffMiddleware, env, "/api/app/me", { cookie: `${SESSION_COOKIE_NAME}=${value}` });
  assert.equal(r.status, 401);
  assert.equal(r.state.nextCalled, false);
});

test("both cookies present: each guard uses only its own (staff sees the staff user; client sees mailbox A)", async () => {
  const { env } = seedMail();
  const both = `${await staffCookie()}; ${await clientCookieFor(A)}`;
  const s = await call(staffMiddleware, env, "/api/app/me", { cookie: both });
  assert.equal((s.data.staffUser as { id: string }).id, "user_staff_owner");
  const c = await call(me, env, "/api/mail-client/me", { cookie: both });
  assert.equal(c.json?.emailAddress, A.email);
});

// ---------- forged / tampered / expired client cookies ----------

test("tampered client cookies are rejected: flipped signature byte, flipped payload byte, wrong secret, expired, duplicated", async () => {
  const { env } = seedMail();
  const good = await clientCookieFor(A);
  const value = valueOf(good);
  const [payload, sig] = value.split(".") as [string, string];
  const flip = (s: string, i: number) => s.slice(0, i) + (s[i] === "a" ? "b" : "a") + s.slice(i + 1);
  const expired = await signMailClientSession(SECRET, { kind: "client_mail_session", mailAccountId: A.id, emailAddress: A.email, issuedAt: Date.now() - 13 * 3600_000 });
  const cases = [
    `${MAIL_CLIENT_COOKIE_NAME}=${payload}.${flip(sig, 10)}`,
    `${MAIL_CLIENT_COOKIE_NAME}=${flip(payload, 5)}.${sig}`,
    await clientCookieFor(A, "a-different-secret"),
    `${MAIL_CLIENT_COOKIE_NAME}=${expired}`,
    `${good}; ${good}`,
    `${MAIL_CLIENT_COOKIE_NAME}=${payload}`,
    `${MAIL_CLIENT_COOKIE_NAME}=`,
  ];
  for (const cookie of cases) {
    const r = await call(me, env, "/api/mail-client/me", { cookie });
    assert.equal(r.status, 401, `expected 401 for ${cookie.slice(0, 60)}`);
  }
});

test("a cookie re-signed to point at another mailbox needs the secret: swapping the payload's account id breaks the signature", async () => {
  const { env } = seedMail();
  const [, sig] = valueOf(await clientCookieFor(A)).split(".") as [string, string];
  const otherPayload = b64url(JSON.stringify({ kind: "client_mail_session", mailAccountId: "acct-b", emailAddress: "ben@beta.ph", issuedAt: Date.now() }));
  const r = await call(me, env, "/api/mail-client/me", { cookie: `${MAIL_CLIENT_COOKIE_NAME}=${otherPayload}.${sig}` });
  assert.equal(r.status, 401);
});

// ---------- eligibility, re-checked every request ----------

test("a validly-signed session for a staff (non client-hosted) mailbox is refused", async () => {
  const { env } = seedMail();
  const r = await call(me, env, "/api/mail-client/me", { cookie: await clientCookieFor(S) });
  assert.equal(r.status, 401);
});

test("suspending the service, deleting the mailbox or deactivating the account ends an existing session on its next request", async () => {
  for (const sql of [
    `UPDATE email_services SET status = 'suspended' WHERE id = 'svc-a'`,
    `UPDATE email_mailboxes SET status = 'deleted' WHERE id = 'mb-a'`,
    `UPDATE mail_accounts SET is_active = 0 WHERE id = 'acct-a'`,
    `UPDATE mail_accounts SET smtp_profile = NULL WHERE id = 'acct-a'`,
    `UPDATE mail_accounts SET email_address = 'renamed@acme.ph' WHERE id = 'acct-a'`,
  ]) {
    const { db, env } = seedMail();
    const cookie = await clientCookieFor(A);
    assert.equal((await call(me, env, "/api/mail-client/me", { cookie })).status, 200);
    db.raw.exec(sql);
    const r = await call(me, env, "/api/mail-client/me", { cookie });
    assert.equal(r.status, 401, sql);
    assert.match(r.res.headers.get("set-cookie") ?? "", /ck_mail_client_session=;.*Max-Age=0/, "the stale cookie is cleared");
  }
});

// ---------- cookie attributes ----------

test("the client cookie is HttpOnly, Secure, SameSite=Strict and scoped to /api/mail-client", async () => {
  const { createMailClientSessionCookie } = await import("../../functions/_lib/mailClient/session");
  const c = await createMailClientSessionCookie(SECRET, { mailAccountId: A.id, emailAddress: A.email });
  assert.match(c, /^ck_mail_client_session=/);
  for (const attr of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/api/mail-client"]) assert.ok(c.includes(attr), attr);
});

// ---------- CSRF ----------

test("state-changing client requests must be JSON and same-origin", async () => {
  const { env } = seedMail();
  const { patchMessageRoute } = await import("../../functions/_lib/mailClient/routes");
  const cookie = await clientCookieFor(A);
  const asForm = await call(patchMessageRoute, env, "/api/mail-client/messages/msg-a", { method: "PATCH", cookie, params: { id: "msg-a" }, body: { isStarred: true }, contentType: "text/plain" });
  assert.equal(asForm.status, 415);
  const crossSite = await call(patchMessageRoute, env, "/api/mail-client/messages/msg-a", { method: "PATCH", cookie, params: { id: "msg-a" }, body: { isStarred: true }, headers: { origin: "https://evil.example" } });
  assert.equal(crossSite.status, 403);
  const ok = await call(patchMessageRoute, env, "/api/mail-client/messages/msg-a", { method: "PATCH", cookie, params: { id: "msg-a" }, body: { isStarred: true }, headers: { origin: "https://mail.altasme.com" } });
  assert.equal(ok.status, 200);
});
