// D1 persistence for webmail messages/threads, shared by the Pages
// Functions (outbound + mailbox actions) and the inbound mail worker, so
// both writers produce byte-identical rows and thread bookkeeping.

import type { MailAddress } from "./address";
import { normalizeMessageId } from "./threading";
import { placeholders } from "./access";
import { deleteUnreferencedObjects } from "./storage";

export const FOLDERS = ["inbox", "sent", "archive", "junk", "trash"] as const;
export type Folder = (typeof FOLDERS)[number];

export interface MessageRow {
  id: string;
  account_id: string;
  thread_id: string;
  direction: "inbound" | "outbound";
  folder: Folder;
  previous_folder: string | null;
  status: string;
  message_id_header: string | null;
  message_id_normalized: string | null;
  in_reply_to: string | null;
  references_header: string | null;
  from_name: string | null;
  from_email: string;
  reply_to: string | null;
  subject: string;
  snippet: string;
  is_read: number;
  is_starred: number;
  has_attachments: number;
  size_bytes: number;
  auth_results: string | null;
  trashed_at: string | null;
  received_at: string | null;
  sent_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export const MESSAGE_COLUMNS = `id, account_id, thread_id, direction, folder, previous_folder, status, message_id_header, message_id_normalized,
  in_reply_to, references_header, from_name, from_email, reply_to, subject, snippet, is_read, is_starred, has_attachments, size_bytes,
  auth_results, trashed_at, received_at, sent_at, created_by, created_at, updated_at`;

export const EFFECTIVE_DATE = `COALESCE(m.received_at, m.sent_at, m.created_at)`;

export interface RecipientInput {
  type: "to" | "cc" | "bcc";
  address: MailAddress;
}

export interface NewMessage {
  id: string;
  accountId: string;
  threadId: string | null;
  direction: "inbound" | "outbound";
  folder: Folder;
  status: "received" | "queued" | "sending" | "sent" | "failed" | "retry_scheduled";
  messageIdHeader: string | null;
  inReplyTo: string | null;
  references: string | null;
  dedupeKey: string;
  fromName: string | null;
  fromEmail: string;
  replyTo: string | null;
  subject: string;
  bodyText: string;
  bodyHtml: string;
  snippet: string;
  isRead: boolean;
  hasAttachments: boolean;
  sizeBytes: number;
  rawStorageKey: string | null;
  authResults: string | null;
  receivedAt: string | null;
  sentAt: string | null;
  createdBy: string | null;
  recipients: RecipientInput[];
  attachmentNames?: string[];
}

/** Finds the thread an incoming/outgoing message belongs to from its header id list. */
export async function findThreadByMessageIds(db: D1Database, accountId: string, ids: string[]): Promise<string | null> {
  if (!ids.length) return null;
  const row = await db
    .prepare(
      `SELECT thread_id FROM mail_messages WHERE account_id = ? AND message_id_normalized IN (${placeholders(ids.length)})
       ORDER BY created_at DESC LIMIT 1`
    )
    .bind(accountId, ...ids)
    .first<{ thread_id: string }>();
  return row?.thread_id ?? null;
}

/**
 * Returns the D1 statements that insert a message, its recipients and the
 * thread bookkeeping, for the caller to run inside one db.batch() (D1
 * batches are transactional) together with anything else that must be
 * atomic with it (a send job, attachment re-pointing, deleting a draft).
 */
export async function buildMessageInsert(db: D1Database, m: NewMessage): Promise<{ threadId: string; statements: D1PreparedStatement[] }> {
  const now = new Date().toISOString();
  const at = m.receivedAt ?? m.sentAt ?? now;
  const participants = new Set<string>([m.fromEmail.toLowerCase(), ...m.recipients.map((r) => r.address.email.toLowerCase())]);
  const statements: D1PreparedStatement[] = [];

  let threadId = m.threadId;
  if (threadId) {
    const existing = await db.prepare(`SELECT participants FROM mail_threads WHERE id = ? AND account_id = ?`).bind(threadId, m.accountId).first<{ participants: string }>();
    if (!existing) {
      threadId = null;
    } else {
      try {
        for (const p of JSON.parse(existing.participants) as string[]) participants.add(p);
      } catch {
        /* ignore */
      }
    }
  }
  const participantsJson = JSON.stringify([...participants].slice(0, 100));
  if (!threadId) {
    threadId = crypto.randomUUID();
    statements.push(
      db
        .prepare(
          `INSERT INTO mail_threads (id, account_id, subject, participants, message_count, latest_message_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, 0, ?, ?, ?)`
        )
        .bind(threadId, m.accountId, m.subject.slice(0, 500), participantsJson, at, now, now)
    );
  }

  statements.push(
    db
      .prepare(
        `INSERT INTO mail_messages (id, account_id, thread_id, direction, folder, previous_folder, status, message_id_header, message_id_normalized,
           in_reply_to, references_header, dedupe_key, from_name, from_email, reply_to, subject, body_text, body_html, snippet, is_read, is_starred,
           has_attachments, size_bytes, raw_storage_key, auth_results, trashed_at, received_at, sent_at, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`
      )
      .bind(
        m.id,
        m.accountId,
        threadId,
        m.direction,
        m.folder,
        m.status,
        m.messageIdHeader,
        normalizeMessageId(m.messageIdHeader),
        m.inReplyTo,
        m.references,
        m.dedupeKey,
        m.fromName,
        m.fromEmail.toLowerCase(),
        m.replyTo,
        m.subject.slice(0, 1000),
        m.bodyText,
        m.bodyHtml,
        m.snippet,
        m.isRead ? 1 : 0,
        m.hasAttachments ? 1 : 0,
        m.sizeBytes,
        m.rawStorageKey,
        m.authResults,
        m.receivedAt,
        m.sentAt,
        m.createdBy,
        now,
        now
      )
  );

  m.recipients.forEach((r, i) => {
    statements.push(
      db
        .prepare(`INSERT INTO mail_recipients (id, message_id, recipient_type, display_name, email, position) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(crypto.randomUUID(), m.id, r.type, r.address.name, r.address.email.toLowerCase(), i)
    );
  });

  statements.push(
    db
      .prepare(
        `UPDATE mail_threads SET message_count = (SELECT COUNT(*) FROM mail_messages WHERE thread_id = ?),
           latest_message_at = CASE WHEN latest_message_at > ? THEN latest_message_at ELSE ? END,
           participants = ?, updated_at = ? WHERE id = ?`
      )
      .bind(threadId, at, at, participantsJson, now, threadId)
  );

  return { threadId, statements };
}

/** Adds the message to the FTS5 search index. Best-effort: search falls back to LIKE if this fails. */
export async function indexMessage(db: D1Database, m: Pick<NewMessage, "id" | "accountId" | "fromName" | "fromEmail" | "subject" | "bodyText" | "recipients" | "attachmentNames">) {
  try {
    await db
      .prepare(`INSERT INTO mail_messages_fts (message_id, account_id, sender, recipients, subject, body, attachments) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        m.id,
        m.accountId,
        `${m.fromName ?? ""} ${m.fromEmail}`,
        m.recipients.map((r) => `${r.address.name ?? ""} ${r.address.email}`).join(" "),
        m.subject,
        m.bodyText.slice(0, 200_000),
        (m.attachmentNames ?? []).join(" ")
      )
      .run();
  } catch (err) {
    console.error("mail fts index failed", err instanceof Error ? err.message : err);
  }
}

export async function reindexAttachments(db: D1Database, messageId: string) {
  try {
    const names = await db.prepare(`SELECT filename FROM mail_attachments WHERE message_id = ?`).bind(messageId).all<{ filename: string }>();
    await db.prepare(`UPDATE mail_messages_fts SET attachments = ? WHERE message_id = ?`).bind(names.results.map((n) => n.filename).join(" "), messageId).run();
  } catch {
    /* best effort */
  }
}

export async function loadRecipients(db: D1Database, messageIds: string[]) {
  const map = new Map<string, { type: "to" | "cc" | "bcc"; name: string | null; email: string }[]>();
  if (!messageIds.length) return map;
  for (let i = 0; i < messageIds.length; i += 90) {
    const ids = messageIds.slice(i, i + 90);
    const rows = await db
      .prepare(`SELECT message_id, recipient_type, display_name, email FROM mail_recipients WHERE message_id IN (${placeholders(ids.length)}) ORDER BY position`)
      .bind(...ids)
      .all<{ message_id: string; recipient_type: "to" | "cc" | "bcc"; display_name: string | null; email: string }>();
    for (const r of rows.results) {
      const list = map.get(r.message_id) ?? [];
      list.push({ type: r.recipient_type, name: r.display_name, email: r.email });
      map.set(r.message_id, list);
    }
  }
  return map;
}

export interface AttachmentRow {
  id: string;
  account_id: string;
  message_id: string | null;
  draft_id: string | null;
  filename: string;
  mime_type: string;
  size_bytes: number;
  storage_key: string;
  content_id: string | null;
  is_inline: number;
  storage_status: string;
  created_at: string;
}

export async function loadAttachmentsFor(db: D1Database, column: "message_id" | "draft_id", ids: string[]) {
  const map = new Map<string, AttachmentRow[]>();
  if (!ids.length) return map;
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const rows = await db
      .prepare(
        `SELECT id, account_id, message_id, draft_id, filename, mime_type, size_bytes, storage_key, content_id, is_inline, storage_status, created_at
         FROM mail_attachments WHERE ${column} IN (${placeholders(chunk.length)}) ORDER BY created_at`
      )
      .bind(...chunk)
      .all<AttachmentRow>();
    for (const r of rows.results) {
      const key = (column === "message_id" ? r.message_id : r.draft_id)!;
      const list = map.get(key) ?? [];
      list.push(r);
      map.set(key, list);
    }
  }
  return map;
}

export function serializeAttachment(a: AttachmentRow) {
  return {
    id: a.id,
    filename: a.filename,
    mimeType: a.mime_type,
    size: a.size_bytes,
    contentId: a.content_id,
    isInline: !!a.is_inline,
    available: a.storage_status === "stored",
  };
}

export async function loadLabelsFor(db: D1Database, messageIds: string[]) {
  const map = new Map<string, string[]>();
  if (!messageIds.length) return map;
  for (let i = 0; i < messageIds.length; i += 90) {
    const ids = messageIds.slice(i, i + 90);
    const rows = await db
      .prepare(`SELECT message_id, label_id FROM mail_message_labels WHERE message_id IN (${placeholders(ids.length)})`)
      .bind(...ids)
      .all<{ message_id: string; label_id: string }>();
    for (const r of rows.results) {
      const list = map.get(r.message_id) ?? [];
      list.push(r.label_id);
      map.set(r.message_id, list);
    }
  }
  return map;
}

export async function loadMessages(db: D1Database, ids: string[], accountIds: string[]): Promise<MessageRow[]> {
  if (!ids.length || !accountIds.length) return [];
  const out: MessageRow[] = [];
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80);
    const rows = await db
      .prepare(
        `SELECT ${MESSAGE_COLUMNS} FROM mail_messages
         WHERE id IN (${placeholders(chunk.length)}) AND account_id IN (${placeholders(accountIds.length)})`
      )
      .bind(...chunk, ...accountIds)
      .all<MessageRow>();
    out.push(...rows.results);
  }
  return out;
}

export function serializeMessageMeta(
  row: MessageRow,
  recipients: { type: string; name: string | null; email: string }[] = [],
  labelIds: string[] = []
) {
  return {
    id: row.id,
    accountId: row.account_id,
    threadId: row.thread_id,
    direction: row.direction,
    folder: row.folder,
    status: row.status,
    from: { name: row.from_name, email: row.from_email },
    replyTo: row.reply_to,
    to: recipients.filter((r) => r.type === "to").map((r) => ({ name: r.name, email: r.email })),
    cc: recipients.filter((r) => r.type === "cc").map((r) => ({ name: r.name, email: r.email })),
    bcc: recipients.filter((r) => r.type === "bcc").map((r) => ({ name: r.name, email: r.email })),
    subject: row.subject,
    snippet: row.snippet,
    isRead: !!row.is_read,
    isStarred: !!row.is_starred,
    hasAttachments: !!row.has_attachments,
    size: row.size_bytes,
    messageIdHeader: row.message_id_header,
    inReplyTo: row.in_reply_to,
    references: row.references_header,
    authResults: row.auth_results,
    date: row.received_at ?? row.sent_at ?? row.created_at,
    receivedAt: row.received_at,
    sentAt: row.sent_at,
    labelIds,
  };
}

/** Permanently removes messages (only ever called for messages already in Trash) and everything hanging off them. */
export async function permanentlyDeleteMessages(db: D1Database, bucket: R2Bucket | undefined, ids: string[]): Promise<void> {
  if (!ids.length) return;
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const ph = placeholders(chunk.length);
    const keys = await db.prepare(`SELECT storage_key FROM mail_attachments WHERE message_id IN (${ph})`).bind(...chunk).all<{ storage_key: string }>();
    const raws = await db.prepare(`SELECT raw_storage_key, thread_id FROM mail_messages WHERE id IN (${ph})`).bind(...chunk).all<{ raw_storage_key: string | null; thread_id: string }>();
    const threadIds = [...new Set(raws.results.map((r) => r.thread_id))];
    await db.batch([
      db.prepare(`DELETE FROM mail_send_attempts WHERE send_job_id IN (SELECT id FROM mail_send_jobs WHERE message_id IN (${ph}))`).bind(...chunk),
      db.prepare(`DELETE FROM mail_send_jobs WHERE message_id IN (${ph})`).bind(...chunk),
      db.prepare(`DELETE FROM mail_message_labels WHERE message_id IN (${ph})`).bind(...chunk),
      db.prepare(`DELETE FROM mail_recipients WHERE message_id IN (${ph})`).bind(...chunk),
      db.prepare(`DELETE FROM mail_attachments WHERE message_id IN (${ph})`).bind(...chunk),
      db.prepare(`UPDATE mail_drafts SET source_message_id = NULL WHERE source_message_id IN (${ph})`).bind(...chunk),
      db.prepare(`DELETE FROM mail_messages WHERE id IN (${ph})`).bind(...chunk),
    ]);
    try {
      await db.prepare(`DELETE FROM mail_messages_fts WHERE message_id IN (${ph})`).bind(...chunk).run();
    } catch {
      /* best effort */
    }
    if (threadIds.length) {
      const tph = placeholders(threadIds.length);
      await db.batch([
        db.prepare(`UPDATE mail_threads SET message_count = (SELECT COUNT(*) FROM mail_messages WHERE thread_id = mail_threads.id) WHERE id IN (${tph})`).bind(...threadIds),
        db.prepare(`UPDATE mail_drafts SET thread_id = NULL WHERE thread_id IN (${tph}) AND thread_id IN (SELECT id FROM mail_threads WHERE message_count = 0)`).bind(...threadIds),
        db.prepare(`DELETE FROM mail_threads WHERE id IN (${tph}) AND message_count = 0`).bind(...threadIds),
      ]);
    }
    await deleteUnreferencedObjects(db, bucket, keys.results.map((k) => k.storage_key));
    if (bucket) {
      for (const r of raws.results) {
        if (r.raw_storage_key) await bucket.delete(r.raw_storage_key).catch(() => undefined);
      }
    }
  }
}
