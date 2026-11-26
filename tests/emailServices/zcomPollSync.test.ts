// Z.com inbound poll sync (mail-worker/src/zcomPollSync.ts, CLAUDE.md §35),
// against the real schema through the D1 shim, a fake R2 bucket, and a
// scripted provider. Messages go through @altasme/webmail-kit's real
// processInbound().

import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeProvider, STAFF, seed } from "./helpers";
import { fulfillMailboxManually, requestMailboxByClient } from "../../functions/_lib/emailServices/engine";
import { NotConfiguredProvider } from "../../functions/_lib/emailServices/provider/notConfigured";
import type { ProviderError, ProviderMessageDetails, ProviderMessageSummary, ProviderResult } from "../../functions/_lib/emailServices/provider";
import { MAX_NEW_PER_MAILBOX, runZcomPollSync } from "../../mail-worker/src/zcomPollSync";

class FakeR2 {
  objects = new Map<string, Uint8Array>();
  async put(key: string, value: Uint8Array | string) {
    this.objects.set(key, typeof value === "string" ? new TextEncoder().encode(value) : value);
    return {};
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  async get(key: string) {
    return this.objects.get(key) ?? null;
  }
}

function rawMime(id: string, subject: string, body: string): string {
  return [
    `From: Juan <juan@customer.ph>`,
    `To: sales@acme.ph`,
    `Subject: ${subject}`,
    `Date: Wed, 25 Nov 2026 10:00:00 +0800`,
    `Message-ID: <${id}@customer.ph>`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    body,
    ``,
  ].join("\r\n");
}

interface ScriptedMessage {
  details: ProviderMessageDetails;
  attachmentBytes?: Uint8Array;
}

// Configured provider whose message API is scripted per provider mailbox id.
class MessageProvider extends FakeProvider {
  messages = new Map<string, ScriptedMessage[]>();
  failList = new Set<string>();
  listCalls: string[] = [];
  detailCalls: string[] = [];
  attachmentCalls: string[] = [];

  override async listMessages(ref: { providerMailboxId: string }): Promise<ProviderResult<ProviderMessageSummary[]>> {
    this.listCalls.push(ref.providerMailboxId);
    if (this.failList.has(ref.providerMailboxId)) {
      const error: ProviderError = { code: "unavailable", message: "Z.com is down", outcome: "not_performed", retryable: true };
      return { ok: false, error };
    }
    const list = this.messages.get(ref.providerMailboxId) ?? [];
    return { ok: true, value: list.map(({ details: d }) => ({ providerMessageId: d.providerMessageId, subject: d.subject, from: d.from, date: d.date, hasAttachments: d.hasAttachments })) };
  }
  override async getMessageDetails(ref: { providerMailboxId: string; providerMessageId: string }): Promise<ProviderResult<ProviderMessageDetails>> {
    this.detailCalls.push(ref.providerMessageId);
    const m = (this.messages.get(ref.providerMailboxId) ?? []).find((x) => x.details.providerMessageId === ref.providerMessageId);
    if (!m) return { ok: false, error: { code: "not_found", message: "gone", outcome: "not_performed", retryable: false } };
    return { ok: true, value: m.details };
  }
  override async getAttachment(ref: { providerMailboxId: string; providerMessageId: string; attachmentId: string }): Promise<ProviderResult<{ filename: string; contentType: string; data: ArrayBuffer }>> {
    this.attachmentCalls.push(`${ref.providerMessageId}/${ref.attachmentId}`);
    const m = (this.messages.get(ref.providerMailboxId) ?? []).find((x) => x.details.providerMessageId === ref.providerMessageId)!;
    const bytes = m.attachmentBytes ?? new Uint8Array([1, 2, 3]);
    return { ok: true, value: { filename: "invoice.pdf", contentType: "application/pdf", data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer } };
  }
}

const details = (id: string, extra: Partial<ProviderMessageDetails> = {}): ProviderMessageDetails => ({
  providerMessageId: id,
  subject: `Subject ${id}`,
  from: "Juan <juan@customer.ph>",
  date: "2026-11-25T02:00:00Z",
  hasAttachments: false,
  to: ["sales@acme.ph"],
  cc: [],
  attachments: [],
  rawMime: rawMime(id, `Subject ${id}`, `Body of ${id}`),
  bodyText: null,
  bodyHtml: null,
  ...extra,
});

// A service with N bridged, active mailboxes (fulfilled manually).
async function bridged(locals: string[]) {
  const { db, serviceId, domainId } = await seed({ planId: "growth" });
  const ids: { mailboxId: string; accountId: string; providerMailboxId: string }[] = [];
  for (const [i, local] of locals.entries()) {
    const r = await requestMailboxByClient(db, { serviceId, clientId: "client_1", domainId, localPart: local, isPrimary: false, idempotencyKey: null });
    assert.ok(r.ok);
    const f = await fulfillMailboxManually(db, { serviceId, mailboxId: r.value.mailbox.id, providerMailboxId: `zbox-${i}`, smtpProfileKey: `k-${local}`, createBridgeAccount: true, actor: STAFF });
    assert.ok(f.ok);
    ids.push({ mailboxId: r.value.mailbox.id, accountId: f.value.mailAccountId!, providerMailboxId: `zbox-${i}` });
  }
  const env = { DB: db, MAIL_ATTACHMENTS: new FakeR2() as unknown as R2Bucket };
  return { db, env, serviceId, ids };
}

const count = (db: Awaited<ReturnType<typeof bridged>>["db"], sql: string, ...args: string[]) => (db.raw.prepare(sql).get(...args) as { n: number }).n;

test("poll sync: skipped entirely (no calls, no log rows) while the provider is the placeholder", async () => {
  const { db, env } = await bridged(["sales"]);
  const r = await runZcomPollSync(env, new NotConfiguredProvider("zcom"));
  assert.equal(r.skipped, "provider_not_configured");
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM email_provisioning_logs WHERE operation = 'message_sync'`), 0);
});

test("poll sync: a new message is stored through the package's inbound path, with thread, recipients and a sync log", async () => {
  const { db, env, ids } = await bridged(["sales"]);
  const p = new MessageProvider();
  p.messages.set("zbox-0", [{ details: details("m1") }]);
  const r = await runZcomPollSync(env, p);
  assert.equal(r.mailboxes.length, 1);
  assert.equal(r.mailboxes[0]!.stored, 1);

  const msg = db.raw.prepare(`SELECT * FROM mail_messages WHERE account_id = ?`).get(ids[0]!.accountId) as Record<string, unknown>;
  assert.equal(msg.subject, "Subject m1");
  assert.equal(msg.direction, "inbound");
  assert.equal(msg.folder, "inbox");
  assert.equal(msg.from_email, "juan@customer.ph");
  assert.ok(String(msg.body_text).includes("Body of m1"));
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM mail_threads WHERE account_id = ?`, ids[0]!.accountId), 1);
  assert.ok(count(db, `SELECT COUNT(*) AS n FROM mail_recipients WHERE message_id = ?`, String(msg.id)) >= 1);
  assert.ok(env.MAIL_ATTACHMENTS && (env.MAIL_ATTACHMENTS as unknown as FakeR2).objects.size >= 1, "raw .eml kept in R2");

  const log = db.raw.prepare(`SELECT outcome, actor_type, details_json FROM email_provisioning_logs WHERE operation = 'message_sync' AND mailbox_id = ?`).get(ids[0]!.mailboxId) as Record<string, string>;
  assert.equal(log.outcome, "succeeded");
  assert.equal(log.actor_type, "system");
  assert.equal(JSON.parse(log.details_json).stored, 1);
  const mb = db.raw.prepare(`SELECT last_synced_at FROM email_mailboxes WHERE id = ?`).get(ids[0]!.mailboxId) as { last_synced_at: string | null };
  assert.ok(mb.last_synced_at);
});

test("poll sync: a message already stored is skipped without re-fetching; a duplicate by dedupe key is skipped without erroring", async () => {
  const { db, env, ids } = await bridged(["sales"]);
  const p = new MessageProvider();
  p.messages.set("zbox-0", [{ details: details("m1") }]);
  await runZcomPollSync(env, p);
  assert.equal(p.detailCalls.length, 1);

  // Second pass (past the poll interval): known id -> no detail fetch at all.
  const later = new Date(Date.now() + 10 * 60_000).toISOString();
  const r2 = await runZcomPollSync(env, p, later);
  assert.equal(r2.mailboxes[0]!.skippedKnown, 1);
  assert.equal(p.detailCalls.length, 1);

  // Same message under a new provider id (no marker): processInbound's
  // dedupe key catches it, nothing errors, still one stored row.
  p.messages.set("zbox-0", [{ details: details("m1") }, { details: { ...details("m1"), providerMessageId: "m1-again" } }]);
  const r3 = await runZcomPollSync(env, p, new Date(Date.now() + 20 * 60_000).toISOString());
  assert.equal(r3.mailboxes[0]!.duplicates, 1);
  assert.equal(r3.mailboxes[0]!.ok, true);
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM mail_messages WHERE account_id = ?`, ids[0]!.accountId), 1);
});

test("poll sync: a provider error on one mailbox doesn't stop the others", async () => {
  const { db, env, ids } = await bridged(["sales", "info", "help"]);
  const p = new MessageProvider();
  p.failList.add("zbox-1");
  p.messages.set("zbox-0", [{ details: details("a1") }]);
  p.messages.set("zbox-2", [{ details: details("c1") }]);
  const r = await runZcomPollSync(env, p);
  assert.equal(r.mailboxes.length, 3);
  assert.deepEqual(new Set(p.listCalls), new Set(["zbox-0", "zbox-1", "zbox-2"]));
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM mail_messages WHERE account_id = ?`, ids[0]!.accountId), 1);
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM mail_messages WHERE account_id = ?`, ids[2]!.accountId), 1);

  const failed = db.raw.prepare(`SELECT outcome, error_code FROM email_provisioning_logs WHERE operation = 'message_sync' AND mailbox_id = ?`).get(ids[1]!.mailboxId) as Record<string, string>;
  assert.deepEqual({ ...failed }, { outcome: "failed", error_code: "unavailable" });
  const stale = db.raw.prepare(`SELECT last_synced_at FROM email_mailboxes WHERE id = ?`).get(ids[1]!.mailboxId) as { last_synced_at: string | null };
  assert.equal(stale.last_synced_at, null, "last_synced_at only moves on a successful pass");
  // One log row per mailbox per poll, not per message.
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM email_provisioning_logs WHERE operation = 'message_sync'`), 3);
});

test("poll sync: attachments are fetched only when hasAttachments is true, and never when raw MIME is available", async () => {
  const { db, env, ids } = await bridged(["sales"]);
  const p = new MessageProvider();
  const structured = (id: string, withAttachment: boolean) =>
    details(id, {
      rawMime: null,
      bodyText: `Plain body ${id}`,
      bodyHtml: `<p>Plain body ${id}</p>`,
      hasAttachments: withAttachment,
      attachments: withAttachment ? [{ attachmentId: "att-1", filename: "invoice.pdf", contentType: "application/pdf", sizeBytes: 3 }] : [],
    });
  p.messages.set("zbox-0", [
    { details: structured("no-att", false) },
    { details: structured("with-att", true) },
    { details: { ...details("raw-att"), hasAttachments: true, attachments: [{ attachmentId: "att-9", filename: "x.pdf", contentType: "application/pdf", sizeBytes: 3 }] } },
  ]);
  const r = await runZcomPollSync(env, p);
  assert.equal(r.mailboxes[0]!.stored, 3);
  assert.deepEqual(p.attachmentCalls, ["with-att/att-1"]);

  const withAtt = db.raw.prepare(`SELECT id, has_attachments FROM mail_messages WHERE account_id = ? AND subject = 'Subject with-att'`).get(ids[0]!.accountId) as { id: string; has_attachments: number };
  assert.equal(withAtt.has_attachments, 1);
  const att = db.raw.prepare(`SELECT filename, mime_type, storage_status FROM mail_attachments WHERE message_id = ?`).get(withAtt.id) as Record<string, string>;
  assert.deepEqual({ ...att }, { filename: "invoice.pdf", mime_type: "application/pdf", storage_status: "stored" });
  const noAtt = db.raw.prepare(`SELECT body_text FROM mail_messages WHERE account_id = ? AND subject = 'Subject no-att'`).get(ids[0]!.accountId) as { body_text: string };
  assert.ok(noAtt.body_text.includes("Plain body no-att"));
});

test("poll sync: work per mailbox per tick is bounded; the rest is picked up later", async () => {
  const { db, env, ids } = await bridged(["sales"]);
  const p = new MessageProvider();
  p.messages.set("zbox-0", Array.from({ length: MAX_NEW_PER_MAILBOX + 3 }, (_, i) => ({ details: details(`bulk${i}`) })));
  const r = await runZcomPollSync(env, p);
  assert.equal(r.mailboxes[0]!.stored, MAX_NEW_PER_MAILBOX);
  assert.equal(r.mailboxes[0]!.deferred, 3);
  await runZcomPollSync(env, p, new Date(Date.now() + 10 * 60_000).toISOString());
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM mail_messages WHERE account_id = ?`, ids[0]!.accountId), MAX_NEW_PER_MAILBOX + 3);

  // And a mailbox polled moments ago isn't polled again yet.
  const again = await runZcomPollSync(env, p);
  assert.equal(again.mailboxes.length, 0);
});
