// /api/mail-connect/* data routes: every request is authorized against the
// caller's LIVE grants, per mailbox and per permission, server-side.
// Real route handlers, real SQL, FKs ON. Each refusal checks the database
// didn't change, and has a positive control.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  composePrefillRoute,
  createSignatureRoute,
  downloadAttachmentRoute,
  getMessageRoute,
  getThreadRoute,
  listMessagesRoute,
  me,
  moveMessageRoute,
  patchMessageRoute,
  sendRoute,
} from "../../functions/_lib/mailConnect/routes";
import { smtpSend } from "@altasme/webmail-kit/smtp";
import type { SmtpTransport } from "@altasme/webmail-kit/smtpTransport";
import { createFakeSmtp } from "../mail/fakeSmtp";
import { A, B, S, attach, call, connectCookie, grant, installHtmlRewriterStub, launchRow, seedConnect } from "./helpers";

installHtmlRewriterStub();

function fakeTransport() {
  const { connector } = createFakeSmtp();
  const calls: string[] = [];
  const transport: SmtpTransport = (config, envelope, data) => {
    calls.push(envelope.from);
    return smtpSend(connector, config, envelope, data);
  };
  return { transport, calls };
}

const sendBody = (mailboxId: string, extra: Record<string, unknown> = {}) => ({
  mailboxId,
  mode: "new",
  to: [{ email: "customer@example.com" }],
  cc: [],
  bcc: [],
  subject: "Hi",
  html: "<p>Hello</p>",
  idempotencyKey: `k-${crypto.randomUUID()}`,
  ...extra,
});
const count = (f: Awaited<ReturnType<typeof seedConnect>>, sql: string) => (f.db.raw.prepare(sql).get() as { n: number }).n;

test("zero grants: /me is 200 with no mailboxes (the page shows 'no email account assigned'), and every mailbox route is 404", async () => {
  const f = await seedConnect();
  const cookie = await connectCookie(f.intA.id, "u-nobody");
  const r = await call(me, f.env, "/api/mail-connect/me", { cookie });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json!.mailboxes, []);
  assert.equal(r.json!.unavailableCount, 0);
  assert.equal((await call(listMessagesRoute, f.env, `/api/mail-connect/messages?mailboxId=${A.id}&folder=inbox`, { cookie })).status, 404);
});

test("service unavailable: a grant whose service is suspended isn't usable and is counted as unavailable, not as 'no mailbox'", async () => {
  const f = await seedConnect();
  grant(f, f.intA.id, "u-1", A.id);
  const cookie = await connectCookie(f.intA.id, "u-1");
  f.db.raw.exec(`UPDATE email_services SET status = 'suspended' WHERE id = 'svc-a'`);
  const r = await call(me, f.env, "/api/mail-connect/me", { cookie });
  assert.deepEqual(r.json!.mailboxes, []);
  assert.equal(r.json!.unavailableCount, 1);
  assert.equal((await call(listMessagesRoute, f.env, `/api/mail-connect/messages?mailboxId=${A.id}&folder=inbox`, { cookie })).status, 404);
});

test("IDOR: a mailboxId the caller wasn't granted is 404 everywhere -- another client's mailbox, the staff mailbox, a missing id", async () => {
  const f = await seedConnect();
  grant(f, f.intA.id, "u-1", A.id, { send: true, delete: true, settings: true });
  // A grant row pointing at B planted on A's integration (as if the boundary were bypassed) is still unusable: it's outside A's grantable set.
  grant(f, f.intA.id, "u-1", B.id, { send: true, delete: true });
  const cookie = await connectCookie(f.intA.id, "u-1");
  const { transport, calls } = fakeTransport();
  for (const mailboxId of [B.id, S.id, "", "all"]) {
    assert.equal((await call(listMessagesRoute, f.env, `/api/mail-connect/messages?mailboxId=${mailboxId}&folder=inbox`, { cookie })).status, 404, mailboxId);
    assert.equal((await call(getThreadRoute, f.env, `/api/mail-connect/threads/thr-b?mailboxId=${mailboxId}`, { cookie, params: { id: "thr-b" } })).status, 404);
    assert.equal((await call(patchMessageRoute, f.env, "/api/mail-connect/messages/msg-b", { method: "PATCH", cookie, params: { id: "msg-b" }, body: { mailboxId, isStarred: true } })).status, 404);
    assert.equal((await call(moveMessageRoute, f.env, "/api/mail-connect/messages/msg-b/move", { method: "POST", cookie, params: { id: "msg-b" }, body: { mailboxId, to: "trash" } })).status, 404);
    assert.equal((await call(sendRoute(transport), f.env, "/api/mail-connect/send", { method: "POST", cookie, body: sendBody(mailboxId) })).status, 404);
  }
  assert.equal(calls.length, 0);
  assert.equal(count(f, `SELECT COUNT(*) AS n FROM mail_messages WHERE id = 'msg-b' AND (is_starred = 1 OR folder != 'inbox')`), 0);
  // own mailbox id + another mailbox's message id -> 404 too
  assert.equal((await call(getMessageRoute, f.env, `/api/mail-connect/messages/msg-b?mailboxId=${A.id}`, { cookie, params: { id: "msg-b" } })).status, 404);
  assert.equal((await call(getThreadRoute, f.env, `/api/mail-connect/threads/thr-b?mailboxId=${A.id}`, { cookie, params: { id: "thr-b" } })).status, 404);
  // control: own mailbox works
  const own = await call(listMessagesRoute, f.env, `/api/mail-connect/messages?mailboxId=${A.id}&folder=inbox`, { cookie });
  assert.deepEqual((own.json!.threads as { threadId: string }[]).map((t) => t.threadId), ["thr-a"]);
});

test("the same opaque user id on ANOTHER integration is a different person and sees nothing", async () => {
  const f = await seedConnect();
  grant(f, f.intA.id, "u-1", A.id);
  const r = await call(me, f.env, "/api/mail-connect/me", { cookie: await connectCookie(f.intB.id, "u-1") });
  assert.deepEqual(r.json!.mailboxes, []);
});

test("send permission: can_send = 0 is refused server-side (403) before anything is queued; can_send = 1 sends from that mailbox", async () => {
  const f = await seedConnect();
  grant(f, f.intA.id, "u-ro", A.id, { send: false });
  grant(f, f.intA.id, "u-rw", A.id, { send: true });
  const { transport, calls } = fakeTransport();
  const ro = await call(sendRoute(transport), f.env, "/api/mail-connect/send", { method: "POST", cookie: await connectCookie(f.intA.id, "u-ro"), body: sendBody(A.id) });
  assert.equal(ro.status, 403);
  assert.equal(ro.json!.error, "You have read-only access to this mailbox.");
  assert.equal((await call(composePrefillRoute, f.env, `/api/mail-connect/compose?mailboxId=${A.id}&mode=new`, { cookie: await connectCookie(f.intA.id, "u-ro") })).status, 403);
  assert.equal(count(f, `SELECT COUNT(*) AS n FROM mail_send_jobs`), 0);
  assert.equal(calls.length, 0);

  const rw = await call(sendRoute(transport), f.env, "/api/mail-connect/send", { method: "POST", cookie: await connectCookie(f.intA.id, "u-rw"), body: sendBody(A.id) });
  assert.equal(rw.status, 201);
  assert.equal(rw.json!.status, "sent");
  assert.deepEqual(calls, [A.email]);
  const ev = f.db.raw.prepare(`SELECT actor_id FROM mail_events WHERE event_type = 'connect_send'`).get() as { actor_id: string };
  assert.equal(ev.actor_id, `connect:${f.intA.id}:u-rw`);
});

test("send permission also follows the mailbox's own outbound switch", async () => {
  const f = await seedConnect();
  grant(f, f.intA.id, "u-rw", A.id, { send: true });
  f.db.raw.exec(`UPDATE mail_accounts SET outbound_enabled = 0 WHERE id = '${A.id}'`);
  const { transport } = fakeTransport();
  const r = await call(sendRoute(transport), f.env, "/api/mail-connect/send", { method: "POST", cookie: await connectCookie(f.intA.id, "u-rw"), body: sendBody(A.id) });
  assert.equal(r.status, 403);
});

test("delete permission: moving to Trash needs can_delete; archiving doesn't", async () => {
  const f = await seedConnect();
  grant(f, f.intA.id, "u-1", A.id, { delete: false });
  const cookie = await connectCookie(f.intA.id, "u-1");
  const denied = await call(moveMessageRoute, f.env, "/api/mail-connect/messages/msg-a/move", { method: "POST", cookie, params: { id: "msg-a" }, body: { mailboxId: A.id, to: "trash" } });
  assert.equal(denied.status, 403);
  assert.equal((f.db.raw.prepare(`SELECT folder FROM mail_messages WHERE id = 'msg-a'`).get() as { folder: string }).folder, "inbox");
  const archived = await call(moveMessageRoute, f.env, "/api/mail-connect/messages/msg-a/move", { method: "POST", cookie, params: { id: "msg-a" }, body: { mailboxId: A.id, to: "archive" } });
  assert.equal(archived.status, 200);
  f.db.raw.exec(`UPDATE mail_external_mailbox_access SET can_delete = 1`);
  const trashed = await call(moveMessageRoute, f.env, "/api/mail-connect/messages/msg-a/move", { method: "POST", cookie, params: { id: "msg-a" }, body: { mailboxId: A.id, to: "trash" } });
  assert.equal(trashed.status, 200);
  assert.equal(trashed.json!.folder, "trash");
});

test("settings permission: creating a signature needs can_manage_settings", async () => {
  const f = await seedConnect();
  grant(f, f.intA.id, "u-1", A.id);
  const cookie = await connectCookie(f.intA.id, "u-1");
  const body = { mailboxId: A.id, name: "Main", bodyHtml: "<p>Thanks</p>", useForNew: true };
  assert.equal((await call(createSignatureRoute, f.env, "/api/mail-connect/signatures", { method: "POST", cookie, body })).status, 403);
  assert.equal(count(f, `SELECT COUNT(*) AS n FROM mail_signatures`), 0);
  f.db.raw.exec(`UPDATE mail_external_mailbox_access SET can_manage_settings = 1`);
  assert.equal((await call(createSignatureRoute, f.env, "/api/mail-connect/signatures", { method: "POST", cookie, body })).status, 201);
  assert.equal(count(f, `SELECT COUNT(*) AS n FROM mail_signatures WHERE account_id = '${A.id}'`), 1);
});

test("a grant with can_read = 0 is no grant at all", async () => {
  const f = await seedConnect();
  grant(f, f.intA.id, "u-1", A.id, { read: false, send: true });
  const cookie = await connectCookie(f.intA.id, "u-1");
  assert.deepEqual((await call(me, f.env, "/api/mail-connect/me", { cookie })).json!.mailboxes, []);
  const { transport } = fakeTransport();
  assert.equal((await call(sendRoute(transport), f.env, "/api/mail-connect/send", { method: "POST", cookie, body: sendBody(A.id) })).status, 404);
});

test("revocation takes effect on the very next request, with the same cookie and no session refresh", async () => {
  const f = await seedConnect();
  grant(f, f.intA.id, "u-1", A.id, { send: true });
  const cookie = await connectCookie(f.intA.id, "u-1");
  const url = `/api/mail-connect/messages?mailboxId=${A.id}&folder=inbox`;
  assert.equal((await call(listMessagesRoute, f.env, url, { cookie })).status, 200);
  f.db.raw.exec(`DELETE FROM mail_external_mailbox_access`);
  assert.equal((await call(listMessagesRoute, f.env, url, { cookie })).status, 404);
  assert.deepEqual((await call(me, f.env, "/api/mail-connect/me", { cookie })).json!.mailboxes, []);
});

test("permission downgrade also applies on the next request (send -> read-only)", async () => {
  const f = await seedConnect();
  grant(f, f.intA.id, "u-1", A.id, { send: true });
  const cookie = await connectCookie(f.intA.id, "u-1");
  const { transport } = fakeTransport();
  assert.equal((await call(sendRoute(transport), f.env, "/api/mail-connect/send", { method: "POST", cookie, body: sendBody(A.id) })).status, 201);
  f.db.raw.exec(`UPDATE mail_external_mailbox_access SET can_send = 0`);
  assert.equal((await call(sendRoute(transport), f.env, "/api/mail-connect/send", { method: "POST", cookie, body: sendBody(A.id) })).status, 403);
});

test("detaching a staff-attached mailbox stops existing grants to it on the next request", async () => {
  const f = await seedConnect();
  attach(f, f.intA.id, S.id);
  grant(f, f.intA.id, "u-1", S.id);
  const cookie = await connectCookie(f.intA.id, "u-1");
  const url = `/api/mail-connect/messages?mailboxId=${S.id}&folder=inbox`;
  const ok = await call(listMessagesRoute, f.env, url, { cookie });
  assert.deepEqual((ok.json!.threads as { threadId: string }[]).map((t) => t.threadId), ["thr-s"]);
  f.db.raw.exec(`DELETE FROM mail_client_integration_mailboxes`);
  assert.equal((await call(listMessagesRoute, f.env, url, { cookie })).status, 404);
});

test("multiple mailboxes: /me lists exactly the live grants, default first", async () => {
  const f = await seedConnect();
  attach(f, f.intA.id, S.id);
  grant(f, f.intA.id, "u-1", A.id);
  grant(f, f.intA.id, "u-1", S.id, { isDefault: true, send: true });
  const launchId = launchRow(f, f.intA.id, "u-1", "https://panel.acme.ph/");
  const r = await call(me, f.env, "/api/mail-connect/me", { cookie: await connectCookie(f.intA.id, "u-1", launchId) });
  assert.deepEqual((r.json!.mailboxes as { emailAddress: string; isDefault: boolean }[]).map((m) => [m.emailAddress, m.isDefault]), [
    [S.email, true],
    [A.email, false],
  ]);
  assert.equal(r.json!.returnUrl, "https://panel.acme.ph/");
  // another user's launch id can't be used to read someone else's return URL
  const otherLaunch = launchRow(f, f.intA.id, "u-other", "https://evil.example/");
  const r2 = await call(me, f.env, "/api/mail-connect/me", { cookie: await connectCookie(f.intA.id, "u-1", otherLaunch) });
  assert.equal(r2.json!.returnUrl, null);
});

test("attachments: only from mailboxes the caller can currently read; draft attachments never", async () => {
  const f = await seedConnect();
  grant(f, f.intA.id, "u-1", A.id);
  const cookie = await connectCookie(f.intA.id, "u-1");
  for (const id of ["att-b", "att-draft"]) assert.equal((await call(downloadAttachmentRoute, f.env, `/api/mail-connect/attachments/${id}`, { cookie, params: { id } })).status, 404, id);
  const own = await call(downloadAttachmentRoute, f.env, "/api/mail-connect/attachments/att-a", { cookie, params: { id: "att-a" } });
  assert.equal(own.status, 200);
  assert.equal(own.text, "AAAAA");
  f.db.raw.exec(`DELETE FROM mail_external_mailbox_access`);
  assert.equal((await call(downloadAttachmentRoute, f.env, "/api/mail-connect/attachments/att-a", { cookie, params: { id: "att-a" } })).status, 404);
});
