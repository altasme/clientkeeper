// Full message payloads for the reading pane: metadata + sanitized HTML
// body + attachments + labels + (outbound) send-job status. The raw stored
// HTML never leaves the server unsanitized.

import { placeholders } from "./access";
import { loadPolicy } from "./config";
import { sanitizeEmailHtml } from "./sanitize";
import { loadAttachmentsFor, loadLabelsFor, loadRecipients, MESSAGE_COLUMNS, serializeAttachment, serializeMessageMeta, type MessageRow } from "./store";

export async function loadMessageDetails(
  db: D1Database,
  accountIds: string[],
  sel: { messageIds?: string[]; threadId?: string; folders?: string[] | null },
  requestRemoteImages: boolean
) {
  if (!accountIds.length) return [];
  let rows: (MessageRow & { body_html: string; body_text: string })[];
  if (sel.threadId) {
    const folders = sel.folders ?? null;
    const r = await db
      .prepare(
        `SELECT ${MESSAGE_COLUMNS}, body_html, body_text FROM mail_messages
         WHERE thread_id = ? AND account_id IN (${placeholders(accountIds.length)}) ${folders ? `AND folder IN (${placeholders(folders.length)})` : ""}
         ORDER BY COALESCE(received_at, sent_at, created_at) ASC`
      )
      .bind(sel.threadId, ...accountIds, ...(folders ?? []))
      .all<MessageRow & { body_html: string; body_text: string }>();
    rows = r.results;
  } else {
    const ids = sel.messageIds ?? [];
    if (!ids.length) return [];
    const r = await db
      .prepare(`SELECT ${MESSAGE_COLUMNS}, body_html, body_text FROM mail_messages WHERE id IN (${placeholders(ids.length)}) AND account_id IN (${placeholders(accountIds.length)})`)
      .bind(...ids, ...accountIds)
      .all<MessageRow & { body_html: string; body_text: string }>();
    rows = r.results;
  }
  if (!rows.length) return [];

  const ids = rows.map((r) => r.id);
  const policy = await loadPolicy(db);
  const allowRemote = policy.remoteImagePolicy === "allow" || (policy.remoteImagePolicy === "block" && requestRemoteImages);
  const recipients = await loadRecipients(db, ids);
  const attachments = await loadAttachmentsFor(db, "message_id", ids);
  const labels = await loadLabelsFor(db, ids);
  const jobs = await db
    .prepare(`SELECT message_id, status, attempts, last_error, next_retry_at, last_attempted_at FROM mail_send_jobs WHERE message_id IN (${placeholders(ids.length)})`)
    .bind(...ids)
    .all<{ message_id: string; status: string; attempts: number; last_error: string | null; next_retry_at: string | null; last_attempted_at: string | null }>();
  const jobMap = new Map(jobs.results.map((j) => [j.message_id, j]));

  const out = [];
  for (const row of rows) {
    const atts = attachments.get(row.id) ?? [];
    const cidMap = new Map<string, string>();
    for (const a of atts) {
      if (a.content_id && a.storage_status === "stored") cidMap.set(a.content_id.replace(/[<>]/g, "").toLowerCase(), `/api/app/mail/attachments/${a.id}/preview`);
    }
    const sanitized = await sanitizeEmailHtml(row.body_html, { allowRemoteImages: allowRemote, cidMap });
    const usedCids = new Set([...cidMap.keys()].filter((cid) => row.body_html.toLowerCase().includes(`cid:${cid}`)));
    const job = jobMap.get(row.id);
    out.push({
      ...serializeMessageMeta(row, recipients.get(row.id) ?? [], labels.get(row.id) ?? []),
      bodyHtml: sanitized.html,
      bodyText: row.body_text,
      remoteImagesBlocked: sanitized.remoteImagesBlocked,
      remoteImagePolicy: policy.remoteImagePolicy,
      remoteImagesShown: allowRemote,
      // Inline images already rendered in the body aren't repeated in the attachment list.
      attachments: atts.filter((a) => !(a.is_inline && a.content_id && usedCids.has(a.content_id.replace(/[<>]/g, "").toLowerCase()))).map(serializeAttachment),
      sendJob: job
        ? { status: job.status, attempts: job.attempts, lastError: job.last_error, nextRetryAt: job.next_retry_at, lastAttemptedAt: job.last_attempted_at }
        : null,
    });
  }
  return out;
}
