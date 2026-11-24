// Mailbox listing + search. Results are grouped into conversations: one
// row per thread, showing the newest matching message, with every matching
// message id attached so row-level actions (archive, star, label...) apply
// to exactly the messages that made that row appear in this view.
//
// Search runs in the database (FTS5 MATCH, falling back to LIKE if the FTS
// table is unavailable) and is ALWAYS scoped to the caller's accessible
// account ids -- nothing is fetched to the browser for client-side
// filtering.

import { placeholders } from "./access";
import { EFFECTIVE_DATE, loadLabelsFor, loadRecipients, MESSAGE_COLUMNS, serializeMessageMeta, type MessageRow } from "./store";

export interface ListParams {
  folder: string; // inbox | sent | archive | junk | trash | starred | all
  labelId?: string | null;
  q?: string | null;
  unread?: boolean;
  read?: boolean;
  starred?: boolean;
  hasAttachments?: boolean;
  from?: string | null;
  to?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  sort: "newest" | "oldest";
  limit: number;
  offset: number;
}

/** Turns free text into a safe FTS5 query: every term quoted (no operator injection) and prefix-matched. */
export function toFtsQuery(q: string): string | null {
  const terms = q
    .split(/\s+/)
    .map((t) => t.replace(/["*^:(){}[\]]/g, "").trim())
    .filter((t) => t.length > 0)
    .slice(0, 12);
  if (!terms.length) return null;
  return terms.map((t) => `"${t}"*`).join(" ");
}

function likeEscape(s: string): string {
  return `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export function parseListParams(url: URL): ListParams {
  const sp = url.searchParams;
  const bool = (k: string) => sp.get(k) === "1" || sp.get(k) === "true";
  const date = (k: string) => {
    const v = sp.get(k);
    return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
  };
  const limit = Math.min(100, Math.max(1, Number(sp.get("limit")) || 50));
  return {
    folder: sp.get("folder") || "inbox",
    labelId: sp.get("labelId") || null,
    q: (sp.get("q") || "").trim().slice(0, 200) || null,
    unread: bool("unread"),
    read: bool("read"),
    starred: bool("starred"),
    hasAttachments: bool("hasAttachments"),
    from: (sp.get("from") || "").trim().slice(0, 200) || null,
    to: (sp.get("to") || "").trim().slice(0, 200) || null,
    dateFrom: date("dateFrom"),
    dateTo: date("dateTo"),
    sort: sp.get("sort") === "oldest" ? "oldest" : "newest",
    limit,
    offset: Math.max(0, Number(sp.get("offset")) || 0),
  };
}

function buildWhere(accountIds: string[], p: ListParams, useFts: boolean): { where: string; params: unknown[] } {
  const conds: string[] = [`m.account_id IN (${placeholders(accountIds.length)})`];
  const params: unknown[] = [...accountIds];

  switch (p.folder) {
    case "inbox":
    case "sent":
    case "archive":
    case "junk":
    case "trash":
      conds.push(`m.folder = ?`);
      params.push(p.folder);
      break;
    case "starred":
      conds.push(`m.is_starred = 1 AND m.folder NOT IN ('trash', 'junk')`);
      break;
    default: // "all" (search across everything except trash/junk)
      conds.push(`m.folder NOT IN ('trash', 'junk')`);
  }
  if (p.labelId) {
    conds.push(`EXISTS (SELECT 1 FROM mail_message_labels ml WHERE ml.message_id = m.id AND ml.label_id = ?)`);
    params.push(p.labelId);
  }
  if (p.unread) conds.push(`m.is_read = 0`);
  if (p.read) conds.push(`m.is_read = 1`);
  if (p.starred) conds.push(`m.is_starred = 1`);
  if (p.hasAttachments) conds.push(`m.has_attachments = 1`);
  if (p.from) {
    conds.push(`(m.from_email LIKE ? ESCAPE '\\' OR m.from_name LIKE ? ESCAPE '\\')`);
    params.push(likeEscape(p.from), likeEscape(p.from));
  }
  if (p.to) {
    conds.push(`EXISTS (SELECT 1 FROM mail_recipients r WHERE r.message_id = m.id AND (r.email LIKE ? ESCAPE '\\' OR r.display_name LIKE ? ESCAPE '\\'))`);
    params.push(likeEscape(p.to), likeEscape(p.to));
  }
  if (p.dateFrom) {
    conds.push(`${EFFECTIVE_DATE} >= ?`);
    params.push(`${p.dateFrom}T00:00:00.000Z`);
  }
  if (p.dateTo) {
    conds.push(`${EFFECTIVE_DATE} <= ?`);
    params.push(`${p.dateTo}T23:59:59.999Z`);
  }
  if (p.q) {
    const labelMatch = `EXISTS (SELECT 1 FROM mail_message_labels ml2 JOIN mail_labels l ON l.id = ml2.label_id WHERE ml2.message_id = m.id AND l.name LIKE ? ESCAPE '\\')`;
    const fts = useFts ? toFtsQuery(p.q) : null;
    if (fts) {
      conds.push(
        `(m.id IN (SELECT message_id FROM mail_messages_fts WHERE mail_messages_fts MATCH ? AND account_id IN (${placeholders(accountIds.length)})) OR ${labelMatch})`
      );
      params.push(fts, ...accountIds, likeEscape(p.q));
    } else {
      const like = likeEscape(p.q);
      conds.push(
        `(m.subject LIKE ? ESCAPE '\\' OR m.body_text LIKE ? ESCAPE '\\' OR m.from_email LIKE ? ESCAPE '\\' OR m.from_name LIKE ? ESCAPE '\\'
          OR EXISTS (SELECT 1 FROM mail_recipients r2 WHERE r2.message_id = m.id AND (r2.email LIKE ? ESCAPE '\\' OR r2.display_name LIKE ? ESCAPE '\\'))
          OR EXISTS (SELECT 1 FROM mail_attachments a2 WHERE a2.message_id = m.id AND a2.filename LIKE ? ESCAPE '\\')
          OR ${labelMatch})`
      );
      params.push(like, like, like, like, like, like, like, like);
    }
  }
  return { where: conds.join(" AND "), params };
}

export async function listThreads(db: D1Database, accountIds: string[], p: ListParams) {
  if (!accountIds.length) return { threads: [], hasMore: false, searchMode: "none" as const };
  let searchMode: "fts" | "like" | "none" = p.q ? "fts" : "none";
  const run = async (useFts: boolean) => {
    const { where, params } = buildWhere(accountIds, p, useFts);
    return db
      .prepare(
        `SELECT m.thread_id, MAX(${EFFECTIVE_DATE}) AS latest_at, COUNT(*) AS cnt,
                SUM(CASE WHEN m.is_read = 0 THEN 1 ELSE 0 END) AS unread, MAX(m.is_starred) AS starred, MAX(m.has_attachments) AS att
         FROM mail_messages m WHERE ${where}
         GROUP BY m.thread_id ORDER BY latest_at ${p.sort === "oldest" ? "ASC" : "DESC"} LIMIT ? OFFSET ?`
      )
      .bind(...params, p.limit + 1, p.offset)
      .all<{ thread_id: string; latest_at: string; cnt: number; unread: number; starred: number; att: number }>();
  };
  let groups;
  try {
    groups = await run(!!p.q);
  } catch (err) {
    if (!p.q) throw err;
    searchMode = "like";
    groups = await run(false);
  }
  const hasMore = groups.results.length > p.limit;
  const page = groups.results.slice(0, p.limit);
  if (!page.length) return { threads: [], hasMore: false, searchMode };

  // Fetch the matching messages for these threads (same filters) to build each row.
  const { where, params } = buildWhere(accountIds, p, searchMode === "fts");
  const threadIds = page.map((g) => g.thread_id);
  const msgs = await db
    .prepare(`SELECT ${MESSAGE_COLUMNS.replace(/(^|,\s*)(\w)/g, "$1m.$2")} FROM mail_messages m WHERE ${where} AND m.thread_id IN (${placeholders(threadIds.length)})`)
    .bind(...params, ...threadIds)
    .all<MessageRow>();
  const byThread = new Map<string, MessageRow[]>();
  for (const m of msgs.results) {
    const list = byThread.get(m.thread_id) ?? [];
    list.push(m);
    byThread.set(m.thread_id, list);
  }
  const latest = new Map<string, MessageRow>();
  for (const [tid, list] of byThread) {
    list.sort((a, b) => (b.received_at ?? b.sent_at ?? b.created_at).localeCompare(a.received_at ?? a.sent_at ?? a.created_at));
    latest.set(tid, list[0]!);
  }
  const latestIds = [...latest.values()].map((m) => m.id);
  const recipients = await loadRecipients(db, latestIds);
  const labels = await loadLabelsFor(db, msgs.results.map((m) => m.id));

  const counts = await db
    .prepare(`SELECT id, message_count FROM mail_threads WHERE id IN (${placeholders(threadIds.length)})`)
    .bind(...threadIds)
    .all<{ id: string; message_count: number }>();
  const threadCount = new Map(counts.results.map((c) => [c.id, c.message_count]));

  const threads = page
    .filter((g) => latest.has(g.thread_id))
    .map((g) => {
      const list = byThread.get(g.thread_id)!;
      const m = latest.get(g.thread_id)!;
      const labelIds = [...new Set(list.flatMap((x) => labels.get(x.id) ?? []))];
      return {
        threadId: g.thread_id,
        latest: serializeMessageMeta(m, recipients.get(m.id) ?? [], labels.get(m.id) ?? []),
        messageIds: list.map((x) => x.id),
        matchCount: g.cnt,
        threadMessageCount: threadCount.get(g.thread_id) ?? g.cnt,
        unreadCount: g.unread,
        isStarred: !!g.starred,
        hasAttachments: !!g.att,
        labelIds,
        failedSend: list.some((x) => x.status === "failed"),
        pendingSend: list.some((x) => x.status === "queued" || x.status === "sending" || x.status === "retry_scheduled"),
        latestAt: g.latest_at,
      };
    });
  return { threads, hasMore, searchMode };
}
