// The Webmail Connect session must be structurally incapable of standing
// in for EITHER of the other two session types, and neither of them for it
// (CLAUDE.md §38). These run the REAL guards: the staff middleware
// (functions/api/app/_middleware.ts), the mailbox-owner guard (via the real
// /api/mail-client/me route) and the connect guard (via the real
// /api/mail-connect/me route). Every rejection has a positive control, so a
// guard that rejected everything would fail the suite.

import { test } from "node:test";
import assert from "node:assert/strict";
import { onRequest as staffMiddleware } from "../../functions/api/app/_middleware";
import { hmacSha256Hex } from "../../functions/_lib/crypto";
import { me as clientMe } from "../../functions/_lib/mailClient/routes";
import { MAIL_CLIENT_COOKIE_NAME, signMailClientSession, verifyMailClientSessionCookie } from "../../functions/_lib/mailClient/session";
import { me as connectMe, listMessagesRoute } from "../../functions/_lib/mailConnect/routes";
import { MAIL_CONNECT_COOKIE_NAME, createMailConnectSessionCookie, signMailConnectSession, verifyMailConnectSessionCookie } from "../../functions/_lib/mailConnect/session";
import { SESSION_COOKIE_NAME, verifySessionCookie } from "../../functions/_lib/session";
import { A, SECRET, call, clientCookieFor, connectCookie, grant, seedConnect, staffCookie } from "./helpers";

const valueOf = (pair: string) => pair.slice(pair.indexOf("=") + 1);
const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const connectPayload = (integrationId: string, extra: Record<string, unknown> = {}) => ({ kind: "mail_connect_session", integrationId, externalUserId: "u-1", launchId: "l-1", issuedAt: Date.now(), ...extra });

// ---------- positive controls ----------

test("control: each guard accepts its own valid cookie", async () => {
  const f = await seedConnect();
  grant(f, f.intA.id, "u-1", A.id);
  const s = await call(staffMiddleware, f.env, "/api/app/me", { cookie: await staffCookie() });
  assert.equal(s.state.nextCalled, true);
  const c = await call(clientMe, f.env, "/api/mail-client/me", { cookie: await clientCookieFor(A) });
  assert.equal(c.status, 200);
  const k = await call(connectMe, f.env, "/api/mail-connect/me", { cookie: await connectCookie(f.intA.id, "u-1") });
  assert.equal(k.status, 200);
  assert.deepEqual((k.json!.mailboxes as { emailAddress: string }[]).map((m) => m.emailAddress), [A.email]);
});

// ---------- the other two sessions -> connect routes ----------

test("a valid staff session and a valid mailbox-owner session each grant nothing on connect routes (401)", async () => {
  const f = await seedConnect();
  grant(f, f.intA.id, "u-1", A.id);
  for (const cookie of [await staffCookie(), await clientCookieFor(A), `${await staffCookie()}; ${await clientCookieFor(A)}`]) {
    for (const [fn, url] of [
      [connectMe, "/api/mail-connect/me"],
      [listMessagesRoute, `/api/mail-connect/messages?mailboxId=${A.id}&folder=inbox`],
    ] as const) {
      const r = await call(fn, f.env, url, { cookie });
      assert.equal(r.status, 401, `${cookie.slice(0, 30)} on ${url}`);
    }
  }
});

test("a staff or mailbox-owner cookie VALUE renamed to the connect cookie name is rejected (different signed message)", async () => {
  const f = await seedConnect();
  for (const source of [await staffCookie(), await clientCookieFor(A)]) {
    const forged = `${MAIL_CONNECT_COOKIE_NAME}=${valueOf(source)}`;
    assert.equal((await call(connectMe, f.env, "/api/mail-connect/me", { cookie: forged })).status, 401);
    assert.equal(await verifyMailConnectSessionCookie(SECRET, forged), null);
  }
});

test("a connect-shaped payload signed the staff way or the mailbox-owner way is rejected by the connect guard", async () => {
  const f = await seedConnect();
  grant(f, f.intA.id, "u-1", A.id);
  const payload = b64url(JSON.stringify(connectPayload(f.intA.id)));
  const staffSig = await hmacSha256Hex(SECRET, payload);
  const clientSig = await hmacSha256Hex(SECRET, `client_mail_session.v1.${payload}`);
  for (const sig of [staffSig, clientSig]) {
    assert.equal((await call(connectMe, f.env, "/api/mail-connect/me", { cookie: `${MAIL_CONNECT_COOKIE_NAME}=${payload}.${sig}` })).status, 401);
  }
  // control: the same payload signed the connect way is accepted
  const connectSig = await hmacSha256Hex(SECRET, `mail_connect_session.v1.${payload}`);
  assert.equal((await call(connectMe, f.env, "/api/mail-connect/me", { cookie: `${MAIL_CONNECT_COOKIE_NAME}=${payload}.${connectSig}` })).status, 200);
});

test("a correctly connect-signed payload carrying a staff or mailbox-owner field is rejected", async () => {
  const f = await seedConnect();
  grant(f, f.intA.id, "u-1", A.id);
  for (const extra of [{ workosUserId: "user_staff_owner" }, { mailAccountId: A.id }, { emailAddress: A.email }]) {
    const value = await signMailConnectSession(SECRET, connectPayload(f.intA.id, extra) as never);
    assert.equal((await call(connectMe, f.env, "/api/mail-connect/me", { cookie: `${MAIL_CONNECT_COOKIE_NAME}=${value}` })).status, 401, JSON.stringify(extra));
  }
});

// ---------- connect session -> the other two guards ----------

test("a valid connect cookie grants nothing on the staff middleware (401, route never reached)", async () => {
  const f = await seedConnect();
  const cookie = await connectCookie(f.intA.id, "u-1");
  for (const c of [cookie, `${SESSION_COOKIE_NAME}=${valueOf(cookie)}`]) {
    const r = await call(staffMiddleware, f.env, "/api/app/mail/messages", { cookie: c });
    assert.equal(r.status, 401);
    assert.equal(r.state.nextCalled, false);
  }
  assert.equal(await verifySessionCookie(SECRET, `${SESSION_COOKIE_NAME}=${valueOf(cookie)}`), null);
});

test("a valid connect cookie grants nothing on the mailbox-owner guard (401), even renamed", async () => {
  const f = await seedConnect();
  const cookie = await connectCookie(f.intA.id, "u-1");
  for (const c of [cookie, `${MAIL_CLIENT_COOKIE_NAME}=${valueOf(cookie)}`]) {
    assert.equal((await call(clientMe, f.env, "/api/mail-client/me", { cookie: c })).status, 401);
  }
  assert.equal(await verifyMailClientSessionCookie(SECRET, `${MAIL_CLIENT_COOKIE_NAME}=${valueOf(cookie)}`), null);
});

test("payloads of the other two shapes signed the CONNECT way are rejected by their own guards", async () => {
  const f = await seedConnect();
  const staffShaped = await signMailConnectSession(SECRET, { workosUserId: "user_staff_owner", issuedAt: Date.now() } as never);
  const r1 = await call(staffMiddleware, f.env, "/api/app/me", { cookie: `${SESSION_COOKIE_NAME}=${staffShaped}` });
  assert.equal(r1.status, 401);
  assert.equal(r1.state.nextCalled, false);
  const clientShaped = await signMailConnectSession(SECRET, { kind: "client_mail_session", mailAccountId: A.id, emailAddress: A.email, issuedAt: Date.now() } as never);
  assert.equal((await call(clientMe, f.env, "/api/mail-client/me", { cookie: `${MAIL_CLIENT_COOKIE_NAME}=${clientShaped}` })).status, 401);
  // and a mailbox-owner-signed value can't pass as connect
  const asClient = await signMailClientSession(SECRET, connectPayload(f.intA.id) as never);
  assert.equal((await call(connectMe, f.env, "/api/mail-connect/me", { cookie: `${MAIL_CONNECT_COOKIE_NAME}=${asClient}` })).status, 401);
});

test("all three cookies present at once: each guard uses only its own", async () => {
  const f = await seedConnect();
  grant(f, f.intA.id, "u-1", A.id);
  const all = `${await staffCookie()}; ${await clientCookieFor(A)}; ${await connectCookie(f.intA.id, "u-1")}`;
  const s = await call(staffMiddleware, f.env, "/api/app/me", { cookie: all });
  assert.equal((s.data.staffUser as { id: string }).id, "user_staff_owner");
  assert.equal((await call(clientMe, f.env, "/api/mail-client/me", { cookie: all })).json?.emailAddress, A.email);
  assert.equal((await call(connectMe, f.env, "/api/mail-connect/me", { cookie: all })).json?.integrationName, "Acme Admin Panel");
});

// ---------- forged / tampered / expired ----------

test("tampered connect cookies are rejected: flipped bytes, wrong secret, expired, duplicated, swapped identity", async () => {
  const f = await seedConnect();
  grant(f, f.intA.id, "u-1", A.id);
  const good = await connectCookie(f.intA.id, "u-1");
  const [payload, sig] = valueOf(good).split(".") as [string, string];
  const flip = (s: string, i: number) => s.slice(0, i) + (s[i] === "a" ? "b" : "a") + s.slice(i + 1);
  const expired = await signMailConnectSession(SECRET, { ...connectPayload(f.intA.id), issuedAt: Date.now() - 9 * 3600_000 } as never);
  const otherUser = b64url(JSON.stringify(connectPayload(f.intA.id, { externalUserId: "u-admin" })));
  const cases = [
    `${MAIL_CONNECT_COOKIE_NAME}=${payload}.${flip(sig, 10)}`,
    `${MAIL_CONNECT_COOKIE_NAME}=${flip(payload, 5)}.${sig}`,
    await connectCookie(f.intA.id, "u-1", "l-1", "a-different-secret"),
    `${MAIL_CONNECT_COOKIE_NAME}=${expired}`,
    `${good}; ${good}`,
    `${MAIL_CONNECT_COOKIE_NAME}=${otherUser}.${sig}`,
    `${MAIL_CONNECT_COOKIE_NAME}=${payload}`,
    `${MAIL_CONNECT_COOKIE_NAME}=`,
  ];
  for (const cookie of cases) assert.equal((await call(connectMe, f.env, "/api/mail-connect/me", { cookie })).status, 401, cookie.slice(0, 60));
});

test("the connect cookie is HttpOnly, Secure, SameSite=Strict, scoped to /api/mail-connect, and holds no mailbox or permission", async () => {
  const c = await createMailConnectSessionCookie(SECRET, { integrationId: "i", externalUserId: "u", launchId: "l" });
  assert.match(c, /^ck_mail_connect_session=/);
  for (const attr of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/api/mail-connect"]) assert.ok(c.includes(attr), attr);
  const payload = JSON.parse(Buffer.from(valueOf(c.split(";")[0]!).split(".")[0]!, "base64url").toString("utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(payload).sort(), ["externalUserId", "integrationId", "issuedAt", "kind", "launchId"]);
});

test("state-changing connect requests must be JSON and same-origin", async () => {
  const f = await seedConnect();
  grant(f, f.intA.id, "u-1", A.id);
  const { patchMessageRoute } = await import("../../functions/_lib/mailConnect/routes");
  const cookie = await connectCookie(f.intA.id, "u-1");
  const body = { mailboxId: A.id, isStarred: true };
  assert.equal((await call(patchMessageRoute, f.env, "/api/mail-connect/messages/msg-a", { method: "PATCH", cookie, params: { id: "msg-a" }, body, contentType: "text/plain" })).status, 415);
  assert.equal((await call(patchMessageRoute, f.env, "/api/mail-connect/messages/msg-a", { method: "PATCH", cookie, params: { id: "msg-a" }, body, headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await call(patchMessageRoute, f.env, "/api/mail-connect/messages/msg-a", { method: "PATCH", cookie, params: { id: "msg-a" }, body, headers: { origin: "https://mail.altasme.com" } })).status, 200);
});
