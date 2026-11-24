// GET /api/app/mail/counts?accountId=<id|all>&since=<iso>
// Folder totals + unread counts per mailbox, label unread counts, the
// caller's draft count, and (when `since` is given) up to 10 inbound
// messages that arrived after it -- the auto-refresh poll uses this for the
// "new mail" toast without re-fetching the list.

import { placeholders, scopeAccountIds } from "../../../_lib/mail/access";
import { jsonResponse } from "../../../_lib/mail/http";
import { mailHandler } from "../../../_lib/mail/route";

export const onRequestGet = mailHandler(async ({ ctx, db, user, access }) => {
  const url = new URL(ctx.request.url);
  const ids = scopeAccountIds(access, url.searchParams.get("accountId"));
  const allIds = [...access.keys()];
  const since = url.searchParams.get("since");
  if (!allIds.length) return jsonResponse(200, { accounts: {}, labels: {}, newMessages: [], serverTime: new Date().toISOString() });
  const ph = placeholders(allIds.length);

  const folderRows = await db
    .prepare(
      `SELECT account_id, folder, COUNT(*) AS total, SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS unread
       FROM mail_messages WHERE account_id IN (${ph}) GROUP BY account_id, folder`
    )
    .bind(...allIds)
    .all<{ account_id: string; folder: string; total: number; unread: number }>();
  const starredRows = await db
    .prepare(
      `SELECT account_id, COUNT(*) AS total, SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS unread
       FROM mail_messages WHERE account_id IN (${ph}) AND is_starred = 1 AND folder NOT IN ('trash', 'junk') GROUP BY account_id`
    )
    .bind(...allIds)
    .all<{ account_id: string; total: number; unread: number }>();
  const draftRows = await db
    .prepare(`SELECT account_id, COUNT(*) AS total FROM mail_drafts WHERE account_id IN (${ph}) AND created_by = ? GROUP BY account_id`)
    .bind(...allIds, user.id)
    .all<{ account_id: string; total: number }>();
  const failedRows = await db
    .prepare(`SELECT account_id, COUNT(*) AS total FROM mail_messages WHERE account_id IN (${ph}) AND direction = 'outbound' AND status = 'failed' AND folder != 'trash' GROUP BY account_id`)
    .bind(...allIds)
    .all<{ account_id: string; total: number }>();

  const accounts: Record<string, Record<string, { total: number; unread: number }>> = {};
  const bucket = (a: string) => (accounts[a] ??= {});
  for (const id of allIds) bucket(id);
  for (const r of folderRows.results) bucket(r.account_id)[r.folder] = { total: r.total, unread: r.unread ?? 0 };
  for (const r of starredRows.results) bucket(r.account_id).starred = { total: r.total, unread: r.unread ?? 0 };
  for (const r of draftRows.results) bucket(r.account_id).drafts = { total: r.total, unread: 0 };
  for (const r of failedRows.results) bucket(r.account_id).failed = { total: r.total, unread: 0 };

  const labelRows = await db
    .prepare(
      `SELECT ml.label_id, COUNT(*) AS total, SUM(CASE WHEN m.is_read = 0 THEN 1 ELSE 0 END) AS unread
       FROM mail_message_labels ml JOIN mail_messages m ON m.id = ml.message_id
       WHERE m.account_id IN (${ph}) AND m.folder NOT IN ('trash', 'junk') GROUP BY ml.label_id`
    )
    .bind(...allIds)
    .all<{ label_id: string; total: number; unread: number }>();
  const labels: Record<string, { total: number; unread: number }> = {};
  for (const r of labelRows.results) labels[r.label_id] = { total: r.total, unread: r.unread ?? 0 };

  let newMessages: { id: string; threadId: string; accountId: string; fromName: string | null; fromEmail: string; subject: string; createdAt: string }[] = [];
  if (since && !Number.isNaN(Date.parse(since)) && ids.length) {
    const rows = await db
      .prepare(
        `SELECT id, thread_id, account_id, from_name, from_email, subject, created_at FROM mail_messages
         WHERE account_id IN (${placeholders(ids.length)}) AND direction = 'inbound' AND folder = 'inbox' AND is_read = 0 AND created_at > ?
         ORDER BY created_at DESC LIMIT 10`
      )
      .bind(...ids, new Date(since).toISOString())
      .all<{ id: string; thread_id: string; account_id: string; from_name: string | null; from_email: string; subject: string; created_at: string }>();
    newMessages = rows.results.map((r) => ({
      id: r.id,
      threadId: r.thread_id,
      accountId: r.account_id,
      fromName: r.from_name,
      fromEmail: r.from_email,
      subject: r.subject,
      createdAt: r.created_at,
    }));
  }
  return jsonResponse(200, { accounts, labels, newMessages, serverTime: new Date().toISOString() });
});
