// Mailbox actions (single + bulk), shared by the per-message routes and
// POST /messages/bulk. Every statement is scoped by BOTH the requested ids
// AND the caller's accessible account ids, so an id from someone else's
// mailbox is silently a no-op (and the response count tells the truth).

import { placeholders } from "./access";
import { logMailEvent } from "./events";
import { permanentlyDeleteMessages } from "./store";

export const MESSAGE_ACTIONS = [
  "markRead",
  "markUnread",
  "star",
  "unstar",
  "archive",
  "moveToInbox",
  "junk",
  "notJunk",
  "trash",
  "restore",
  "deleteForever",
  "applyLabel",
  "removeLabel",
] as const;
export type MessageAction = (typeof MESSAGE_ACTIONS)[number];

export function isMessageAction(v: unknown): v is MessageAction {
  return typeof v === "string" && (MESSAGE_ACTIONS as readonly string[]).includes(v);
}

export async function applyMessageAction(
  db: D1Database,
  bucket: R2Bucket | undefined,
  args: { ids: string[]; accountIds: string[]; action: MessageAction; labelId?: string | null; actorId: string }
): Promise<{ ok: true; affected: number } | { ok: false; status: number; error: string }> {
  const ids = [...new Set(args.ids)].slice(0, 500);
  if (!ids.length) return { ok: false, status: 400, error: "No messages selected." };
  if (!args.accountIds.length) return { ok: true, affected: 0 };
  const now = new Date().toISOString();
  let affected = 0;

  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80);
    const scope = `id IN (${placeholders(chunk.length)}) AND account_id IN (${placeholders(args.accountIds.length)})`;
    const scopeParams = [...chunk, ...args.accountIds];
    const run = async (sql: string, pre: unknown[] = []) => {
      const r = await db.prepare(sql).bind(...pre, ...scopeParams).run();
      affected += r.meta.changes ?? 0;
    };
    switch (args.action) {
      case "markRead":
        await run(`UPDATE mail_messages SET is_read = 1, updated_at = ? WHERE ${scope} AND is_read = 0`, [now]);
        break;
      case "markUnread":
        await run(`UPDATE mail_messages SET is_read = 0, updated_at = ? WHERE ${scope} AND is_read = 1`, [now]);
        break;
      case "star":
        await run(`UPDATE mail_messages SET is_starred = 1, updated_at = ? WHERE ${scope}`, [now]);
        break;
      case "unstar":
        await run(`UPDATE mail_messages SET is_starred = 0, updated_at = ? WHERE ${scope}`, [now]);
        break;
      case "archive":
        await run(`UPDATE mail_messages SET previous_folder = folder, folder = 'archive', trashed_at = NULL, updated_at = ? WHERE ${scope} AND folder != 'archive'`, [now]);
        break;
      case "moveToInbox":
        await run(
          `UPDATE mail_messages SET previous_folder = NULL, folder = CASE WHEN direction = 'inbound' THEN 'inbox' ELSE 'sent' END, trashed_at = NULL, updated_at = ?
           WHERE ${scope} AND folder = 'archive'`,
          [now]
        );
        break;
      case "junk":
        await run(`UPDATE mail_messages SET previous_folder = folder, folder = 'junk', updated_at = ? WHERE ${scope} AND direction = 'inbound' AND folder != 'junk'`, [now]);
        break;
      case "trash":
        await run(`UPDATE mail_messages SET previous_folder = folder, folder = 'trash', trashed_at = ?, updated_at = ? WHERE ${scope} AND folder != 'trash'`, [now, now]);
        break;
      case "notJunk":
      case "restore":
        await run(
          `UPDATE mail_messages SET folder = CASE
              WHEN previous_folder IN ('inbox', 'sent', 'archive') THEN previous_folder
              WHEN previous_folder = 'junk' AND folder = 'trash' THEN 'junk'
              WHEN direction = 'inbound' THEN 'inbox' ELSE 'sent' END,
            previous_folder = NULL, trashed_at = NULL, updated_at = ?
           WHERE ${scope} AND folder IN (${args.action === "notJunk" ? "'junk'" : "'junk', 'trash'"})`,
          [now]
        );
        break;
      case "deleteForever": {
        const rows = await db.prepare(`SELECT id FROM mail_messages WHERE ${scope} AND folder = 'trash'`).bind(...scopeParams).all<{ id: string }>();
        await permanentlyDeleteMessages(db, bucket, rows.results.map((r) => r.id));
        affected += rows.results.length;
        break;
      }
      case "applyLabel":
      case "removeLabel": {
        if (!args.labelId) return { ok: false, status: 400, error: "labelId is required." };
        const label = await db
          .prepare(`SELECT id, account_id FROM mail_labels WHERE id = ? AND account_id IN (${placeholders(args.accountIds.length)})`)
          .bind(args.labelId, ...args.accountIds)
          .first<{ id: string; account_id: string }>();
        if (!label) return { ok: false, status: 404, error: "Label not found." };
        if (args.action === "applyLabel") {
          const r = await db
            .prepare(
              `INSERT OR IGNORE INTO mail_message_labels (message_id, label_id, created_at)
               SELECT id, ?, ? FROM mail_messages WHERE id IN (${placeholders(chunk.length)}) AND account_id = ?`
            )
            .bind(label.id, now, ...chunk, label.account_id)
            .run();
          affected += r.meta.changes ?? 0;
        } else {
          const r = await db
            .prepare(`DELETE FROM mail_message_labels WHERE label_id = ? AND message_id IN (${placeholders(chunk.length)})`)
            .bind(label.id, ...chunk)
            .run();
          affected += r.meta.changes ?? 0;
        }
        break;
      }
    }
  }

  await logMailEvent(db, {
    accountId: args.accountIds.length === 1 ? args.accountIds[0] : null,
    messageId: ids.length === 1 ? ids[0] : null,
    type: `action_${args.action}`,
    data: { count: ids.length, affected, labelId: args.labelId ?? undefined, ids: ids.slice(0, 50) },
    actorId: args.actorId,
  });
  return { ok: true, affected };
}
