// Inbound email processing for Cloudflare Email Routing -> this Worker's
// email() handler -> D1 (+ R2 for raw copies and attachments).
//
// Order of operations is chosen so mail is never silently lost:
//  1. Resolve the destination mailbox from the SMTP envelope recipient
//     (+tags stripped). Unknown/disabled address -> reject with a 550 so
//     the sender gets a bounce (an explicit refusal, not a silent drop).
//  2. Store the raw .eml in private R2 FIRST. Everything after this point
//     can be reconstructed from it.
//  3. Parse (postal-mime), compute the dedupe key, skip exact duplicates.
//  4. Resolve the thread from In-Reply-To/References.
//  5. Store attachments in R2 one by one; an individual failure is
//     recorded on that attachment (storage_status='failed') and the
//     message is still stored.
//  6. Insert message + recipients + attachment rows + thread bookkeeping +
//     an audit event in ONE transactional D1 batch.
//  7. Any failure in 3-6 is recorded in mail_inbound_failures (with the
//     raw copy's key) and re-thrown to the caller (index.ts), which either
//     forwards the message to MAIL_FALLBACK_FORWARD or lets the delivery
//     fail so the sending server knows it did not arrive.

import PostalMime from "postal-mime";
import { stripPlusTag } from "../../functions/_lib/mail/address";
import type { MailEnv } from "../../functions/_lib/mail/config";
import { mailEventStatement } from "../../functions/_lib/mail/events";
import { attachmentKey, normalizeMimeType, rawEmailKey, sanitizeFilename } from "../../functions/_lib/mail/storage";
import { buildMessageInsert, findThreadByMessageIds, indexMessage, type RecipientInput } from "../../functions/_lib/mail/store";
import { threadLookupIds } from "../../functions/_lib/mail/threading";
import { attachmentFilename, computeDedupeKey, normalizeParsed } from "./parse";

export interface WorkerEnv extends MailEnv {
  /** Optional verified Email Routing destination to forward to if processing fails. */
  MAIL_FALLBACK_FORWARD?: string;
}

export type InboundOutcome =
  | { status: "stored"; messageId: string; threadId: string; accountId: string }
  | { status: "duplicate"; existingId: string }
  | { status: "rejected"; reason: string };

export class InboundProcessingError extends Error {}

export async function processInbound(env: WorkerEnv, input: { raw: Uint8Array; envelopeFrom: string; envelopeTo: string }): Promise<InboundOutcome> {
  const db = env.DB;
  if (!db) throw new InboundProcessingError("DB binding missing");
  const target = stripPlusTag(input.envelopeTo);
  const account = await db
    .prepare(`SELECT id, email_address FROM mail_accounts WHERE email_address = ? AND is_active = 1 AND inbound_enabled = 1`)
    .bind(target)
    .first<{ id: string; email_address: string }>();
  if (!account) return { status: "rejected", reason: "550 5.1.1 No such mailbox here" };

  const messageId = crypto.randomUUID();
  let rawKey: string | null = rawEmailKey(account.id, messageId);
  try {
    if (!env.MAIL_ATTACHMENTS) throw new Error("R2 binding missing");
    await env.MAIL_ATTACHMENTS.put(rawKey, input.raw, { httpMetadata: { contentType: "message/rfc822" }, customMetadata: { envelopeFrom: input.envelopeFrom.slice(0, 300), envelopeTo: target } });
  } catch (err) {
    console.error("raw email R2 write failed", err instanceof Error ? err.message : err);
    rawKey = null;
  }

  try {
    const parsed = await PostalMime.parse(input.raw, { attachmentEncoding: "arraybuffer" });
    const n = normalizeParsed(parsed, input.envelopeFrom);
    const dedupeKey = await computeDedupeKey(n);
    const dupe = await db.prepare(`SELECT id FROM mail_messages WHERE account_id = ? AND dedupe_key = ?`).bind(account.id, dedupeKey).first<{ id: string }>();
    if (dupe) {
      if (rawKey && env.MAIL_ATTACHMENTS) await env.MAIL_ATTACHMENTS.delete(rawKey).catch(() => undefined);
      await db
        .prepare(`INSERT INTO mail_events (id, account_id, message_id, event_type, event_data, actor_id, created_at) VALUES (?, ?, ?, 'inbound_duplicate', ?, 'mail-worker', ?)`)
        .bind(crypto.randomUUID(), account.id, dupe.id, JSON.stringify({ dedupeKey }), new Date().toISOString())
        .run()
        .catch(() => undefined);
      return { status: "duplicate", existingId: dupe.id };
    }

    const threadId = await findThreadByMessageIds(db, account.id, threadLookupIds(n.inReplyTo, n.references));

    // Attachments -> R2 (individually; one failure doesn't drop the message)
    const attachmentRows: { id: string; filename: string; mimeType: string; size: number; key: string; contentId: string | null; inline: boolean; stored: boolean }[] = [];
    for (const [i, a] of parsed.attachments.entries()) {
      const id = crypto.randomUUID();
      const filename = sanitizeFilename(attachmentFilename(a.filename, a.mimeType, i));
      const mimeType = normalizeMimeType(a.mimeType);
      const bytes = typeof a.content === "string" ? new TextEncoder().encode(a.content) : a.content instanceof Uint8Array ? a.content : new Uint8Array(a.content);
      const key = attachmentKey(account.id, messageId, id);
      let stored = false;
      try {
        if (!env.MAIL_ATTACHMENTS) throw new Error("R2 binding missing");
        await env.MAIL_ATTACHMENTS.put(key, bytes, { httpMetadata: { contentType: mimeType }, customMetadata: { filename } });
        stored = true;
      } catch (err) {
        console.error("attachment R2 write failed", err instanceof Error ? err.message : err);
      }
      const contentId = a.contentId ? a.contentId.replace(/[<>\s]/g, "").slice(0, 300) || null : null;
      attachmentRows.push({ id, filename, mimeType, size: bytes.byteLength, key, contentId, inline: !!(contentId && (a.related || a.disposition === "inline")), stored });
    }

    // Recipients: header To/Cc, plus the envelope address as Bcc when we
    // were blind-copied (it's the only record of how the message reached us).
    const recipients: RecipientInput[] = [...n.to.map((address) => ({ type: "to" as const, address })), ...n.cc.map((address) => ({ type: "cc" as const, address }))];
    if (!recipients.some((r) => r.address.email === account.email_address)) {
      recipients.push({ type: "bcc" as const, address: { name: null, email: account.email_address } });
    }

    const now = new Date().toISOString();
    const { threadId: finalThreadId, statements } = await buildMessageInsert(db, {
      id: messageId,
      accountId: account.id,
      threadId,
      direction: "inbound",
      folder: n.likelyJunk ? "junk" : "inbox",
      status: "received",
      messageIdHeader: n.messageIdHeader,
      inReplyTo: n.inReplyTo,
      references: n.references,
      dedupeKey,
      fromName: n.from.name,
      fromEmail: n.from.email,
      replyTo: n.replyTo.map((r) => (r.name ? `${r.name} <${r.email}>` : r.email)).join(", ") || null,
      subject: n.subject,
      bodyText: n.text,
      bodyHtml: n.html,
      snippet: n.snippet,
      isRead: false,
      hasAttachments: attachmentRows.some((a) => !a.inline),
      sizeBytes: input.raw.byteLength,
      rawStorageKey: rawKey,
      authResults: n.authResults,
      receivedAt: now,
      sentAt: null,
      createdBy: null,
      recipients,
      attachmentNames: attachmentRows.map((a) => a.filename),
    });
    for (const a of attachmentRows) {
      statements.push(
        db
          .prepare(
            `INSERT INTO mail_attachments (id, account_id, message_id, draft_id, filename, mime_type, size_bytes, storage_key, content_id, is_inline, storage_status, uploaded_by, created_at)
             VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`
          )
          .bind(a.id, account.id, messageId, a.filename, a.mimeType, a.size, a.key, a.contentId, a.inline ? 1 : 0, a.stored ? "stored" : "failed", now)
      );
    }
    statements.push(
      mailEventStatement(db, {
        accountId: account.id,
        messageId,
        type: "inbound_received",
        data: { truncated: n.truncated, junk: n.likelyJunk, attachments: attachmentRows.length, attachmentFailures: attachmentRows.filter((a) => !a.stored).length, rawStored: !!rawKey },
        actorId: "mail-worker",
      })
    );

    try {
      await db.batch(statements);
    } catch (err) {
      // A concurrent delivery of the same message won the UNIQUE(account_id, dedupe_key) race.
      const raced = await db.prepare(`SELECT id FROM mail_messages WHERE account_id = ? AND dedupe_key = ?`).bind(account.id, dedupeKey).first<{ id: string }>();
      if (raced) return { status: "duplicate", existingId: raced.id };
      throw err;
    }
    await indexMessage(db, {
      id: messageId,
      accountId: account.id,
      fromName: n.from.name,
      fromEmail: n.from.email,
      subject: n.subject,
      bodyText: n.text,
      recipients,
      attachmentNames: attachmentRows.map((a) => a.filename),
    });
    return { status: "stored", messageId, threadId: finalThreadId, accountId: account.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    let failedKey = rawKey;
    if (!failedKey && env.MAIL_ATTACHMENTS) {
      failedKey = rawEmailKey(account.id, messageId, true);
      await env.MAIL_ATTACHMENTS.put(failedKey, input.raw).catch(() => {
        failedKey = null;
      });
    }
    await db
      .prepare(`INSERT INTO mail_inbound_failures (id, envelope_from, envelope_to, raw_storage_key, error, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), input.envelopeFrom.slice(0, 300), target, failedKey, message.slice(0, 1000), new Date().toISOString())
      .run()
      .catch((e: unknown) => console.error("could not record inbound failure", e instanceof Error ? e.message : e));
    throw new InboundProcessingError(message);
  }
}
