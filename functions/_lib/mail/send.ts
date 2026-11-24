// The outbound send pipeline: queue -> attempt -> (retry) -> sent/failed.
//
// Reliability model (spec §13/§14):
//  1. queueOutboundMessage() writes the mail_messages row, its recipients,
//     its mail_send_jobs row and (for a draft) the attachment hand-over and
//     draft deletion in ONE transactional D1 batch, before any SMTP
//     traffic. So there is never an email out in the world with no record
//     here: worst case a record exists for an email that wasn't sent yet.
//  2. The Message-ID is generated once at queue time and reused on every
//     attempt, so a retried send is recognizably the same message.
//  3. idempotency_key (UNIQUE) is supplied by the composer per send action:
//     a double-click or a network-retried request maps to the existing job
//     instead of creating a second one.
//  4. attemptSendJob() takes a lease (status -> 'sending', locked_until)
//     with a conditional UPDATE, so two workers can never send the same
//     job concurrently.
//  5. Retry: transient failures (network errors, timeouts, SMTP 4xx) are
//     rescheduled with exponential backoff (1, 2, 4, 8 min, +/-20% jitter)
//     up to max_attempts; permanent failures (SMTP 5xx, bad config,
//     missing attachment) are not retried automatically. A job stuck in
//     'sending' past its lease, or a connection lost after the message
//     body was handed over, is marked failed as "outcome unknown" -- never
//     auto-resent, because the server may already have accepted it.
//  6. Status wording is honest: 'sent' = the SMTP server answered 250 to
//     the end of DATA ("accepted by the mail server"), never "delivered".
//
// Durable background processing: Pages Functions have no cron, so retries
// are driven by the mail worker's scheduled() handler (every minute,
// mail-worker/wrangler.toml) calling processDueSendJobs(). The first
// attempt runs inline in the request that queued it.

import { coerceAddressArray, dedupeAddresses, normalizeEmail, type MailAddress } from "./address";
import type { MailAccess } from "./access";
import { loadPolicy, resolveSmtpConfig, type MailEnv } from "./config";
import { mailEventStatement, logMailEvent } from "./events";
import { buildMimeMessage, type MimeAttachment } from "./mime";
import { sanitizeOutboundHtml } from "./sanitize";
import { SmtpError } from "./smtp";
import type { SmtpTransport } from "./smtpTransport";
import { buildMessageInsert, findThreadByMessageIds, indexMessage, loadRecipients, permanentlyDeleteMessages, type MessageRow, MESSAGE_COLUMNS } from "./store";
import { htmlToText, makeSnippet } from "./text";
import { buildReplyHeaders, generateMessageId, parseMessageIdList } from "./threading";

export type ComposeMode = "new" | "reply" | "reply_all" | "forward";

export interface ComposeInput {
  accountId: string;
  mode: ComposeMode;
  sourceMessageId: string | null;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  html: string;
  idempotencyKey: string;
  draftId: string | null;
}

export type QueueResult =
  | { ok: true; jobId: string; messageId: string; threadId: string; existing: boolean }
  | { ok: false; status: number; error: string; extra?: Record<string, unknown> };

const IDEMPOTENCY_RE = /^[A-Za-z0-9_-]{8,100}$/;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const LEASE_MS = 3 * 60 * 1000;

/** Parses + validates a send request body into a ComposeInput (no DB access). */
export function parseComposeBody(body: Record<string, unknown>, mode: ComposeMode): { ok: true; input: ComposeInput } | { ok: false; error: string; invalid?: string[] } {
  const to = coerceAddressArray(body.to);
  const cc = coerceAddressArray(body.cc);
  const bcc = coerceAddressArray(body.bcc);
  const invalid = [...to.invalid, ...cc.invalid, ...bcc.invalid];
  if (invalid.length) return { ok: false, error: "Some recipients are not valid email addresses.", invalid };
  const accountId = typeof body.accountId === "string" ? body.accountId : "";
  const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
  if (!accountId) return { ok: false, error: "Choose a From identity." };
  if (!IDEMPOTENCY_RE.test(idempotencyKey)) return { ok: false, error: "Missing or invalid idempotencyKey." };
  const subject = typeof body.subject === "string" ? body.subject.replace(/[\r\n]+/g, " ").trim() : "";
  if (subject.length > 900) return { ok: false, error: "Subject is too long." };
  const html = typeof body.html === "string" ? body.html : "";
  if (new TextEncoder().encode(html).length > MAX_HTML_BYTES) return { ok: false, error: "Message body is too large." };
  const sourceMessageId = typeof body.sourceMessageId === "string" && body.sourceMessageId ? body.sourceMessageId : null;
  if (mode !== "new" && !sourceMessageId) return { ok: false, error: "sourceMessageId is required for replies and forwards." };
  return {
    ok: true,
    input: {
      accountId,
      mode,
      sourceMessageId,
      to: to.valid,
      cc: cc.valid,
      bcc: bcc.valid,
      subject,
      html,
      idempotencyKey,
      draftId: typeof body.draftId === "string" && body.draftId ? body.draftId : null,
    },
  };
}

async function findJobByKey(db: D1Database, key: string) {
  return db.prepare(`SELECT j.id, j.message_id, j.created_by, m.thread_id FROM mail_send_jobs j JOIN mail_messages m ON m.id = j.message_id WHERE j.idempotency_key = ?`).bind(key).first<{
    id: string;
    message_id: string;
    created_by: string | null;
    thread_id: string;
  }>();
}

export async function queueOutboundMessage(env: MailEnv, userId: string, access: MailAccess, input: ComposeInput): Promise<QueueResult> {
  const db = env.DB!;
  const existing = await findJobByKey(db, input.idempotencyKey);
  if (existing) {
    if (existing.created_by !== userId) return { ok: false, status: 409, error: "idempotencyKey already used." };
    return { ok: true, jobId: existing.id, messageId: existing.message_id, threadId: existing.thread_id, existing: true };
  }

  const entry = access.get(input.accountId);
  if (!entry) return { ok: false, status: 404, error: "Mailbox not found." };
  if (!entry.canSend) return { ok: false, status: 403, error: "You have read-only access to this mailbox." };
  const account = await db
    .prepare(`SELECT id, email_address, display_name, reply_to, outbound_enabled, is_active FROM mail_accounts WHERE id = ?`)
    .bind(input.accountId)
    .first<{ id: string; email_address: string; display_name: string; reply_to: string | null; outbound_enabled: number; is_active: number }>();
  if (!account || !account.is_active) return { ok: false, status: 404, error: "Mailbox not found." };
  if (!account.outbound_enabled) return { ok: false, status: 403, error: "Sending is disabled for this identity." };

  const policy = await loadPolicy(db);
  const to = dedupeAddresses(input.to);
  const cc = dedupeAddresses(input.cc, to.map((a) => a.email));
  const bcc = dedupeAddresses(input.bcc, [...to, ...cc].map((a) => a.email));
  const total = to.length + cc.length + bcc.length;
  if (!total) return { ok: false, status: 400, error: "Add at least one recipient." };
  if (total > policy.maxRecipients) return { ok: false, status: 400, error: `A message can have at most ${policy.maxRecipients} recipients.` };

  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const sentLastHour = await db.prepare(`SELECT COUNT(*) AS n FROM mail_send_jobs WHERE created_by = ? AND created_at > ?`).bind(userId, hourAgo).first<{ n: number }>();
  if ((sentLastHour?.n ?? 0) >= policy.sendsPerHourPerUser) {
    return { ok: false, status: 429, error: `Send limit reached (${policy.sendsPerHourPerUser} messages per hour). Try again later.` };
  }

  // Reply / forward context
  let threadId: string | null = null;
  let inReplyTo: string | null = null;
  let references: string | null = null;
  if (input.sourceMessageId) {
    const ids = [...access.keys()];
    const src = await db
      .prepare(`SELECT ${MESSAGE_COLUMNS} FROM mail_messages WHERE id = ? AND account_id IN (${ids.map(() => "?").join(", ")})`)
      .bind(input.sourceMessageId, ...ids)
      .first<MessageRow>();
    if (!src) return { ok: false, status: 404, error: "Original message not found." };
    if (input.mode === "reply" || input.mode === "reply_all") {
      const h = buildReplyHeaders(src);
      inReplyTo = h.inReplyTo;
      references = h.references;
    }
    if (src.account_id === input.accountId) threadId = src.thread_id;
    else if (references) threadId = await findThreadByMessageIds(db, input.accountId, parseMessageIdList(references));
  }

  // Draft hand-over (attachments live on the draft until sent)
  let attachmentRows: { id: string; size_bytes: number; filename: string }[] = [];
  if (input.draftId) {
    const draft = await db.prepare(`SELECT id, account_id, created_by FROM mail_drafts WHERE id = ?`).bind(input.draftId).first<{ id: string; account_id: string; created_by: string }>();
    if (!draft || draft.created_by !== userId || !access.has(draft.account_id)) return { ok: false, status: 404, error: "Draft not found." };
    const atts = await db.prepare(`SELECT id, size_bytes, filename, storage_status FROM mail_attachments WHERE draft_id = ?`).bind(input.draftId).all<{
      id: string;
      size_bytes: number;
      filename: string;
      storage_status: string;
    }>();
    if (atts.results.some((a) => a.storage_status !== "stored")) return { ok: false, status: 400, error: "An attachment failed to upload. Remove it and try again." };
    attachmentRows = atts.results;
    if (attachmentRows.length > policy.maxAttachmentCount) return { ok: false, status: 400, error: `At most ${policy.maxAttachmentCount} attachments per message.` };
    const totalBytes = attachmentRows.reduce((s, a) => s + a.size_bytes, 0);
    if (totalBytes > policy.maxTotalAttachmentBytes) return { ok: false, status: 400, error: "Attachments exceed the total size limit." };
  }

  const html = await sanitizeOutboundHtml(input.html || "");
  const text = htmlToText(html);
  const messageId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  const messageIdHeader = generateMessageId(account.email_address);

  const { threadId: finalThreadId, statements } = await buildMessageInsert(db, {
    id: messageId,
    accountId: account.id,
    threadId,
    direction: "outbound",
    folder: "sent",
    status: "queued",
    messageIdHeader,
    inReplyTo,
    references,
    dedupeKey: `out:${messageId}`,
    fromName: account.display_name,
    fromEmail: account.email_address,
    replyTo: account.reply_to,
    subject: input.subject,
    bodyText: text,
    bodyHtml: html,
    snippet: makeSnippet(text),
    isRead: true,
    hasAttachments: attachmentRows.length > 0,
    sizeBytes: new TextEncoder().encode(html).length + attachmentRows.reduce((s, a) => s + a.size_bytes, 0),
    rawStorageKey: null,
    authResults: null,
    receivedAt: null,
    sentAt: null,
    createdBy: userId,
    recipients: [
      ...to.map((address) => ({ type: "to" as const, address })),
      ...cc.map((address) => ({ type: "cc" as const, address })),
      ...bcc.map((address) => ({ type: "bcc" as const, address })),
    ],
  });

  statements.push(
    db
      .prepare(
        `INSERT INTO mail_send_jobs (id, message_id, account_id, idempotency_key, status, attempts, max_attempts, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'queued', 0, 5, ?, ?, ?)`
      )
      .bind(jobId, messageId, account.id, input.idempotencyKey, userId, now, now)
  );
  if (input.draftId) {
    statements.push(db.prepare(`UPDATE mail_attachments SET message_id = ?, draft_id = NULL WHERE draft_id = ?`).bind(messageId, input.draftId));
    statements.push(db.prepare(`DELETE FROM mail_drafts WHERE id = ?`).bind(input.draftId));
  }
  statements.push(
    mailEventStatement(db, {
      accountId: account.id,
      messageId,
      type: "send_queued",
      data: { mode: input.mode, recipients: total, attachments: attachmentRows.length },
      actorId: userId,
    })
  );

  try {
    await db.batch(statements);
  } catch (err) {
    // Lost a race on the same idempotency key: return the winner's job.
    const raced = await findJobByKey(db, input.idempotencyKey);
    if (raced && raced.created_by === userId) return { ok: true, jobId: raced.id, messageId: raced.message_id, threadId: raced.thread_id, existing: true };
    throw err;
  }

  await indexMessage(db, {
    id: messageId,
    accountId: account.id,
    fromName: account.display_name,
    fromEmail: account.email_address,
    subject: input.subject,
    bodyText: text,
    recipients: [...to, ...cc, ...bcc].map((address) => ({ type: "to" as const, address })),
    attachmentNames: attachmentRows.map((a) => a.filename),
  });

  return { ok: true, jobId, messageId, threadId: finalThreadId, existing: false };
}

export function backoffMs(attempts: number, random = Math.random()): number {
  const base = Math.min(2 ** Math.max(0, attempts - 1), 60) * 60_000;
  return Math.round(base * (0.8 + random * 0.4));
}

export interface AttemptOutcome {
  status: "sent" | "retry_scheduled" | "failed" | "busy";
  error?: string;
}

async function recordAttempt(db: D1Database, jobId: string, attempt: number, status: string, code: number | null, error: string | null) {
  await db
    .prepare(`INSERT INTO mail_send_attempts (id, send_job_id, attempt_number, status, smtp_code, error, attempted_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), jobId, attempt, status, code, error, new Date().toISOString())
    .run();
}

async function markJob(db: D1Database, jobId: string, messageId: string, jobStatus: string, fields: { error?: string | null; nextRetryAt?: string | null; sentAt?: string | null }) {
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(`UPDATE mail_send_jobs SET status = ?, last_error = ?, next_retry_at = ?, locked_until = NULL, updated_at = ? WHERE id = ?`)
      .bind(jobStatus, fields.error ?? null, fields.nextRetryAt ?? null, now, jobId),
    db
      .prepare(`UPDATE mail_messages SET status = ?, sent_at = COALESCE(?, sent_at), updated_at = ? WHERE id = ?`)
      .bind(jobStatus, fields.sentAt ?? null, now, messageId),
  ]);
}

/** Runs one send attempt for a job (if it can take the lease). */
export async function attemptSendJob(env: MailEnv, jobId: string, transport: SmtpTransport): Promise<AttemptOutcome> {
  const db = env.DB!;
  const now = new Date();
  const lease = await db
    .prepare(
      `UPDATE mail_send_jobs SET status = 'sending', attempts = attempts + 1, locked_until = ?, last_attempted_at = ?, updated_at = ?
       WHERE id = ? AND status IN ('queued', 'retry_scheduled')`
    )
    .bind(new Date(now.getTime() + LEASE_MS).toISOString(), now.toISOString(), now.toISOString(), jobId)
    .run();
  if (!lease.meta.changes) return { status: "busy" };

  const job = await db.prepare(`SELECT id, message_id, account_id, attempts, max_attempts FROM mail_send_jobs WHERE id = ?`).bind(jobId).first<{
    id: string;
    message_id: string;
    account_id: string;
    attempts: number;
    max_attempts: number;
  }>();
  if (!job) return { status: "busy" };
  await db.prepare(`UPDATE mail_messages SET status = 'sending', updated_at = ? WHERE id = ?`).bind(now.toISOString(), job.message_id).run();

  const fail = async (message: string, kind: "permanent" | "transient" | "unknown", code: number | null): Promise<AttemptOutcome> => {
    const attemptStatus = kind === "permanent" ? "permanent_failure" : kind === "unknown" ? "unknown" : "transient_failure";
    await recordAttempt(db, job.id, job.attempts, attemptStatus, code, message);
    if (kind === "transient" && job.attempts < job.max_attempts) {
      const next = new Date(Date.now() + backoffMs(job.attempts)).toISOString();
      await markJob(db, job.id, job.message_id, "retry_scheduled", { error: message, nextRetryAt: next });
      await logMailEvent(db, { accountId: job.account_id, messageId: job.message_id, type: "send_retry_scheduled", data: { attempt: job.attempts, next, code }, actorId: null });
      return { status: "retry_scheduled", error: message };
    }
    await markJob(db, job.id, job.message_id, "failed", { error: message });
    await logMailEvent(db, { accountId: job.account_id, messageId: job.message_id, type: "send_failed", data: { attempt: job.attempts, code, kind }, actorId: null });
    return { status: "failed", error: message };
  };

  try {
    const msg = await db
      .prepare(`SELECT id, from_name, from_email, reply_to, subject, body_text, body_html, message_id_header, in_reply_to, references_header FROM mail_messages WHERE id = ?`)
      .bind(job.message_id)
      .first<{
        id: string;
        from_name: string | null;
        from_email: string;
        reply_to: string | null;
        subject: string;
        body_text: string;
        body_html: string;
        message_id_header: string;
        in_reply_to: string | null;
        references_header: string | null;
      }>();
    const account = await db.prepare(`SELECT email_address, smtp_profile, outbound_enabled, is_active FROM mail_accounts WHERE id = ?`).bind(job.account_id).first<{
      email_address: string;
      smtp_profile: string | null;
      outbound_enabled: number;
      is_active: number;
    }>();
    if (!msg || !account) return await fail("Message or identity no longer exists.", "permanent", null);
    if (!account.is_active || !account.outbound_enabled) return await fail("Sending is disabled for this identity.", "permanent", null);
    const config = resolveSmtpConfig(env, account.smtp_profile, account.email_address);
    if (!config) return await fail("Outgoing mail (SMTP) is not configured for this identity.", "permanent", null);

    const recipients = (await loadRecipients(db, [msg.id])).get(msg.id) ?? [];
    const attachments: MimeAttachment[] = [];
    const attRows = await db
      .prepare(`SELECT filename, mime_type, storage_key, content_id, is_inline FROM mail_attachments WHERE message_id = ? AND storage_status = 'stored'`)
      .bind(msg.id)
      .all<{ filename: string; mime_type: string; storage_key: string; content_id: string | null; is_inline: number }>();
    for (const a of attRows.results) {
      const obj = env.MAIL_ATTACHMENTS ? await env.MAIL_ATTACHMENTS.get(a.storage_key) : null;
      if (!obj) return await fail(`Attachment "${a.filename}" is no longer available.`, "permanent", null);
      attachments.push({ filename: a.filename, mimeType: a.mime_type, content: new Uint8Array(await obj.arrayBuffer()), contentId: a.content_id, inline: !!a.is_inline });
    }

    const pick = (t: string) => recipients.filter((r) => r.type === t).map((r) => ({ name: r.name, email: r.email }));
    const data = buildMimeMessage({
      from: { name: msg.from_name, email: account.email_address },
      to: pick("to"),
      cc: pick("cc"),
      replyTo: msg.reply_to ? { name: null, email: msg.reply_to } : null,
      subject: msg.subject,
      text: msg.body_text,
      html: msg.body_html,
      messageId: msg.message_id_header,
      inReplyTo: msg.in_reply_to,
      references: msg.references_header,
      attachments,
    });
    const envelopeRecipients = [...new Set(recipients.map((r) => normalizeEmail(r.email)))];
    const result = await transport(config, { from: account.email_address, recipients: envelopeRecipients }, data);

    const sentAt = new Date().toISOString();
    await recordAttempt(db, job.id, job.attempts, "accepted", result.code, null);
    await markJob(db, job.id, job.message_id, "sent", { sentAt });
    await logMailEvent(db, { accountId: job.account_id, messageId: job.message_id, type: "send_accepted", data: { attempt: job.attempts, response: result.response.slice(0, 200) }, actorId: null });
    return { status: "sent" };
  } catch (err) {
    if (err instanceof SmtpError) return await fail(err.message, err.kind, err.code);
    const message = err instanceof Error ? err.message.slice(0, 300) : "Unexpected send failure";
    // An unexpected error before SMTP completed: treat as transient.
    return await fail(message, "transient", null);
  }
}

/**
 * Manual retry of a failed (or scheduled) job. Grants a fresh budget of
 * attempts, then runs one attempt immediately.
 */
export async function retrySendJob(env: MailEnv, access: MailAccess, messageId: string, transport: SmtpTransport): Promise<{ ok: true; outcome: AttemptOutcome } | { ok: false; status: number; error: string }> {
  const db = env.DB!;
  const job = await db.prepare(`SELECT id, account_id, status, attempts FROM mail_send_jobs WHERE message_id = ?`).bind(messageId).first<{
    id: string;
    account_id: string;
    status: string;
    attempts: number;
  }>();
  if (!job || !access.has(job.account_id)) return { ok: false, status: 404, error: "Send job not found." };
  if (!access.get(job.account_id)!.canSend) return { ok: false, status: 403, error: "You have read-only access to this mailbox." };
  if (job.status !== "failed" && job.status !== "retry_scheduled") return { ok: false, status: 409, error: `This message is ${job.status}; only failed messages can be retried.` };
  const now = new Date().toISOString();
  await db
    .prepare(`UPDATE mail_send_jobs SET status = 'queued', next_retry_at = NULL, max_attempts = ?, updated_at = ? WHERE id = ? AND status IN ('failed', 'retry_scheduled')`)
    .bind(job.attempts + 3, now, job.id)
    .run();
  await db.prepare(`UPDATE mail_messages SET status = 'queued', updated_at = ? WHERE id = ?`).bind(now, messageId).run();
  const outcome = await attemptSendJob(env, job.id, transport);
  return { ok: true, outcome };
}

const TRASH_RETENTION_DAYS = 30;

/** Cron entry point (mail worker scheduled()): reap stuck jobs, run due retries, purge old Trash. */
export async function processDueSendJobs(env: MailEnv, transport: SmtpTransport): Promise<{ reaped: number; attempted: number; purged: number }> {
  const db = env.DB!;
  const nowIso = new Date().toISOString();

  // 1. Jobs whose lease expired mid-send: outcome unknown, never auto-resend.
  const stuck = await db.prepare(`SELECT id, message_id, account_id, attempts FROM mail_send_jobs WHERE status = 'sending' AND locked_until < ? LIMIT 50`).bind(nowIso).all<{
    id: string;
    message_id: string;
    account_id: string;
    attempts: number;
  }>();
  for (const j of stuck.results) {
    const msg = "The send was interrupted and its outcome is unknown; the mail server may already have accepted it. Check with the recipient before retrying.";
    await recordAttempt(db, j.id, j.attempts, "unknown", null, msg);
    await markJob(db, j.id, j.message_id, "failed", { error: msg });
    await logMailEvent(db, { accountId: j.account_id, messageId: j.message_id, type: "send_outcome_unknown", actorId: "mail-worker" });
  }

  // 2. Due retries, plus queued jobs whose inline first attempt never ran.
  const twoMinAgo = new Date(Date.now() - 120_000).toISOString();
  const due = await db
    .prepare(
      `SELECT id FROM mail_send_jobs WHERE (status = 'retry_scheduled' AND next_retry_at <= ?) OR (status = 'queued' AND created_at < ?)
       ORDER BY created_at LIMIT 20`
    )
    .bind(nowIso, twoMinAgo)
    .all<{ id: string }>();
  let attempted = 0;
  for (const j of due.results) {
    const r = await attemptSendJob(env, j.id, transport);
    if (r.status !== "busy") attempted++;
  }

  // 3. Trash older than the retention window is permanently deleted.
  const cutoff = new Date(Date.now() - TRASH_RETENTION_DAYS * 86400_000).toISOString();
  const old = await db.prepare(`SELECT id FROM mail_messages WHERE folder = 'trash' AND trashed_at < ? LIMIT 200`).bind(cutoff).all<{ id: string }>();
  if (old.results.length) {
    await permanentlyDeleteMessages(db, env.MAIL_ATTACHMENTS, old.results.map((r) => r.id));
    await logMailEvent(db, { type: "trash_purged", data: { count: old.results.length }, actorId: "mail-worker" });
  }
  return { reaped: stuck.results.length, attempted, purged: old.results.length };
}
