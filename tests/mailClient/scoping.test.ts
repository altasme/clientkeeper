// Every /api/mail-client route touches ONLY the session's own mailbox,
// whatever ids the request supplies (CLAUDE.md §36). Signed in as mailbox
// A, each test aims at mailbox B (another client) or S (Altaventures
// staff) and checks both the response and that nothing changed in the
// database. Real route handlers, real SQL, FKs ON.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  composePrefillRoute,
  downloadAttachmentRoute,
  getMessageRoute,
  getThreadRoute,
  listMessagesRoute,
  moveMessageRoute,
  patchMessageRoute,
  previewAttachmentRoute,
  sendRoute,
} from "../../functions/_lib/mailClient/routes";
import { queueOutboundMessage } from "@altasme/webmail-kit/send";
import { smtpSend } from "@altasme/webmail-kit/smtp";
import type { SmtpTransport } from "@altasme/webmail-kit/smtpTransport";
import { createFakeSmtp } from "../mail/fakeSmtp";
import { A, B, S, STAFF_ID, call, clientCookieFor, installHtmlRewriterStub, seedMail } from "./helpers";

installHtmlRewriterStub();

function fakeTransport() {
  const { connector, log } = createFakeSmtp();
  const calls: { host: string; from: string }[] = [];
  const transport: SmtpTransport = (config, envelope, data) => {
    calls.push({ host: config.host, from: envelope.from });
    return smtpSend(connector, config, envelope, data);
  };
  return { transport, calls, log };
}

const folderOf = (db: ReturnType<typeof seedMail>["db"], id: string) => ({ ...(db.raw.prepare(`SELECT folder, is_starred, is_read FROM mail_messages WHERE id = ?`).get(id) as object) }) as { folder: string; is_starred: number; is_read: number };

test("list: only the session's mailbox, even when another accountId is requested", async () => {
  const { env } = seedMail();
  const cookie = await clientCookieFor(A);
  for (const q of ["", `&accountId=${B.id}`, `&accountId=${S.id}`, "&accountId=all"]) {
    const r = await call(listMessagesRoute, env, `/api/mail-client/messages?folder=inbox${q}`, { cookie });
    assert.equal(r.status, 200);
    const threads = r.json!.threads as { threadId: string }[];
    assert.deepEqual(threads.map((t) => t.threadId), ["thr-a"], q);
  }
});

test("search: a term that only exists in B and S finds nothing for A", async () => {
  const { env } = seedMail();
  const cookie = await clientCookieFor(A);
  const r = await call(listMessagesRoute, env, `/api/mail-client/messages?folder=all&q=zebrapassphrase&accountId=${B.id}`, { cookie });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json!.threads, []);
  // control: the same search as B finds B's message only
  const rb = await call(listMessagesRoute, env, `/api/mail-client/messages?folder=all&q=zebrapassphrase`, { cookie: await clientCookieFor(B) });
  assert.deepEqual((rb.json!.threads as { threadId: string }[]).map((t) => t.threadId), ["thr-b"]);
});

test("read: another mailbox's message and thread are 404; own are 200 with client attachment URLs", async () => {
  const { env } = seedMail();
  const cookie = await clientCookieFor(A);
  for (const id of ["msg-b", "msg-s"]) {
    assert.equal((await call(getMessageRoute, env, `/api/mail-client/messages/${id}`, { cookie, params: { id } })).status, 404);
  }
  for (const id of ["thr-b", "thr-s"]) {
    assert.equal((await call(getThreadRoute, env, `/api/mail-client/threads/${id}`, { cookie, params: { id } })).status, 404);
  }
  const own = await call(getThreadRoute, env, `/api/mail-client/threads/thr-a`, { cookie, params: { id: "thr-a" } });
  assert.equal(own.status, 200);
  assert.equal((own.json!.messages as unknown[]).length, 1);
  assert.equal("accountId" in own.json!, false, "the thread response doesn't expose an account id");
});

test("star / read flags and move: another mailbox's message is 404 and unchanged", async () => {
  const { db, env } = seedMail();
  const cookie = await clientCookieFor(A);
  const before = folderOf(db, "msg-b");
  const p = await call(patchMessageRoute, env, "/api/mail-client/messages/msg-b", { method: "PATCH", cookie, params: { id: "msg-b" }, body: { isStarred: true, isRead: true } });
  assert.equal(p.status, 404);
  for (const to of ["archive", "junk", "trash", "inbox"]) {
    const m = await call(moveMessageRoute, env, "/api/mail-client/messages/msg-b/move", { method: "POST", cookie, params: { id: "msg-b" }, body: { to } });
    assert.equal(m.status, 404);
  }
  assert.deepEqual(folderOf(db, "msg-b"), before);
  assert.deepEqual(folderOf(db, "msg-s"), { folder: "inbox", is_starred: 0, is_read: 0 });

  // control: the same operations on A's own message work
  assert.equal((await call(patchMessageRoute, env, "/api/mail-client/messages/msg-a", { method: "PATCH", cookie, params: { id: "msg-a" }, body: { isStarred: true } })).status, 200);
  assert.equal(folderOf(db, "msg-a").is_starred, 1);
  for (const [to, expected] of [["archive", "archive"], ["inbox", "inbox"], ["junk", "junk"], ["inbox", "inbox"], ["trash", "trash"], ["inbox", "inbox"]] as const) {
    const m = await call(moveMessageRoute, env, "/api/mail-client/messages/msg-a/move", { method: "POST", cookie, params: { id: "msg-a" }, body: { to } });
    assert.equal(m.status, 200);
    assert.equal(folderOf(db, "msg-a").folder, expected, `move to ${to}`);
  }
  const ev = db.raw.prepare(`SELECT DISTINCT actor_id FROM mail_events WHERE event_type LIKE 'action_%'`).all() as { actor_id: string }[];
  assert.deepEqual(ev.map((e) => e.actor_id), [`mailbox:${A.id}`], "audit trail names the mailbox, not a staff user");
});

test("attachments: another mailbox's attachment and a staff draft's attachment in the SAME mailbox are 404", async () => {
  const { env } = seedMail();
  const cookie = await clientCookieFor(A);
  for (const fn of [downloadAttachmentRoute, previewAttachmentRoute]) {
    for (const id of ["att-b", "att-draft", "no-such-id"]) {
      assert.equal((await call(fn, env, `/api/mail-client/attachments/${id}`, { cookie, params: { id } })).status, 404, id);
    }
    const own = await call(fn, env, `/api/mail-client/attachments/att-a`, { cookie, params: { id: "att-a" } });
    assert.equal(own.status, 200);
    assert.equal(own.text, "AAAAA");
  }
});

test("compose prefill: replying to another mailbox's message is 404", async () => {
  const { env } = seedMail();
  const cookie = await clientCookieFor(A);
  for (const src of ["msg-b", "msg-s"]) {
    const r = await call(composePrefillRoute, env, `/api/mail-client/compose?mode=reply&sourceMessageId=${src}`, { cookie });
    assert.equal(r.status, 404);
  }
  const own = await call(composePrefillRoute, env, `/api/mail-client/compose?mode=reply&sourceMessageId=msg-a`, { cookie });
  assert.equal(own.status, 200);
  assert.deepEqual(own.json!.to, [{ name: null, email: "friend@example.com" }]);
});

const sendBody = (extra: Record<string, unknown> = {}) => ({ mode: "new", to: [{ email: "someone@example.com" }], subject: "Hi", html: "<p>hello</p>", idempotencyKey: `key-${crypto.randomUUID()}`, ...extra });

test("send: sends From the session's mailbox over its own SMTP profile, recorded with created_by NULL", async () => {
  const { db, env } = seedMail();
  const { transport, calls, log } = fakeTransport();
  const r = await call(sendRoute(transport), env, "/api/mail-client/send", { method: "POST", cookie: await clientCookieFor(A), body: sendBody() });
  assert.equal(r.status, 201);
  assert.equal(r.json!.status, "sent");
  assert.deepEqual(calls, [{ host: "smtp.acme.test", from: A.email }]);
  assert.match(log.data, new RegExp(`From: .*${A.email}`));
  const msg = { ...(db.raw.prepare(`SELECT account_id, folder, from_email, created_by FROM mail_messages WHERE id = ?`).get(r.json!.messageId as string) as object) };
  assert.deepEqual(msg, { account_id: A.id, folder: "sent", from_email: A.email, created_by: null });
  const job = { ...(db.raw.prepare(`SELECT account_id, created_by FROM mail_send_jobs WHERE id = ?`).get(r.json!.jobId as string) as object) };
  assert.deepEqual(job, { account_id: A.id, created_by: null });
});

test("send: an accountId, draftId or sourceMessageId pointing outside the session's mailbox is refused and nothing is queued", async () => {
  const { db, env } = seedMail();
  const { transport, calls } = fakeTransport();
  const cookie = await clientCookieFor(A);
  const route = sendRoute(transport);
  const cases: [Record<string, unknown>, number][] = [
    [{ accountId: B.id }, 404],
    [{ accountId: S.id }, 404],
    [{ draftId: "draft-staff" }, 404],
    [{ mode: "reply", sourceMessageId: "msg-b" }, 404],
    [{ mode: "forward", sourceMessageId: "msg-s" }, 404],
  ];
  for (const [extra, status] of cases) {
    const r = await call(route, env, "/api/mail-client/send", { method: "POST", cookie, body: sendBody(extra) });
    assert.equal(r.status, status, JSON.stringify(extra));
  }
  assert.equal(calls.length, 0);
  assert.equal((db.raw.prepare(`SELECT COUNT(*) AS n FROM mail_send_jobs`).get() as { n: number }).n, 0);
  assert.equal((db.raw.prepare(`SELECT COUNT(*) AS n FROM mail_drafts WHERE id = 'draft-staff'`).get() as { n: number }).n, 1, "the staff draft is untouched");
});

test("send: a reply to the session's own message threads correctly", async () => {
  const { db, env } = seedMail();
  const { transport } = fakeTransport();
  const r = await call(sendRoute(transport), env, "/api/mail-client/send", { method: "POST", cookie: await clientCookieFor(A), body: sendBody({ mode: "reply", sourceMessageId: "msg-a" }) });
  assert.equal(r.status, 201);
  assert.equal(r.json!.threadId, "thr-a");
  assert.equal((db.raw.prepare(`SELECT account_id FROM mail_threads WHERE id = 'thr-a'`).get() as { account_id: string }).account_id, A.id);
});

test("send: an idempotency key is owned by the mailbox that used it (other mailbox and staff get 409, replay gets the same job)", async () => {
  const { db, env } = seedMail();
  const { transport, calls } = fakeTransport();
  const route = sendRoute(transport);
  const body = sendBody();
  const first = await call(route, env, "/api/mail-client/send", { method: "POST", cookie: await clientCookieFor(A), body });
  assert.equal(first.status, 201);
  const replay = await call(route, env, "/api/mail-client/send", { method: "POST", cookie: await clientCookieFor(A), body });
  assert.equal(replay.status, 200);
  assert.equal(replay.json!.duplicate, true);
  assert.equal(replay.json!.jobId, first.json!.jobId);
  const asB = await call(route, env, "/api/mail-client/send", { method: "POST", cookie: await clientCookieFor(B), body });
  assert.equal(asB.status, 409);
  assert.equal("jobId" in asB.json!, false, "no job/message id leaks to another mailbox");
  const access = new Map([[A.id, { accountId: A.id, canSend: true, emailAddress: A.email, displayName: "ana" }]]);
  const asStaff = await queueOutboundMessage({ DB: db }, STAFF_ID, access, { accountId: A.id, mode: "new", sourceMessageId: null, to: [{ name: null, email: "x@example.com" }], cc: [], bcc: [], subject: "", html: "", idempotencyKey: body.idempotencyKey, draftId: null });
  assert.equal(asStaff.ok, false);
  assert.equal(calls.length, 1);
});

test("send: the hourly limit is per mailbox for owners, separate from staff", async () => {
  const { db, env } = seedMail();
  db.raw.prepare(`INSERT INTO mail_settings (key, value, updated_at) VALUES ('sendsPerHourPerUser', '1', ?)`).run(new Date().toISOString());
  const { transport } = fakeTransport();
  const route = sendRoute(transport);
  assert.equal((await call(route, env, "/api/mail-client/send", { method: "POST", cookie: await clientCookieFor(A), body: sendBody() })).status, 201);
  assert.equal((await call(route, env, "/api/mail-client/send", { method: "POST", cookie: await clientCookieFor(A), body: sendBody() })).status, 429);
  assert.equal((await call(route, env, "/api/mail-client/send", { method: "POST", cookie: await clientCookieFor(B), body: sendBody() })).status, 201, "B has its own budget");
});

test("send: outbound disabled on the mailbox -> 403, nothing sent", async () => {
  const { db, env } = seedMail();
  db.raw.exec(`UPDATE mail_accounts SET outbound_enabled = 0 WHERE id = '${A.id}'`);
  const { transport, calls } = fakeTransport();
  const r = await call(sendRoute(transport), env, "/api/mail-client/send", { method: "POST", cookie: await clientCookieFor(A), body: sendBody() });
  assert.equal(r.status, 403);
  assert.equal(calls.length, 0);
});

test("why drafts aren't offered: mail_drafts.created_by is NOT NULL REFERENCES users(id), so a mailbox owner can't own one", () => {
  const { db } = seedMail();
  const now = new Date().toISOString();
  assert.throws(
    () =>
      db.raw
        .prepare(`INSERT INTO mail_drafts (id, account_id, compose_mode, to_json, cc_json, bcc_json, subject, body_html, body_text, version, created_by, created_at, updated_at) VALUES ('d2', ?, 'new', '[]', '[]', '[]', '', '', '', 1, ?, ?, ?)`)
        .run(A.id, `mailbox:${A.id}`, now, now),
    /FOREIGN KEY/
  );
});
