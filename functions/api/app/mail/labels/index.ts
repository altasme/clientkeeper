// GET  /api/app/mail/labels?accountId=<id|all>
// POST /api/app/mail/labels -- { accountId, name, color }

import { scopeAccountIds, placeholders } from "../../../../_lib/mail/access";
import { asString, errorResponse, jsonResponse, nowIso, readJsonBody } from "../../../../_lib/mail/http";
import { mailHandler } from "../../../../_lib/mail/route";

export const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export const onRequestGet = mailHandler(async ({ ctx, db, access }) => {
  const ids = scopeAccountIds(access, new URL(ctx.request.url).searchParams.get("accountId"));
  if (!ids.length) return jsonResponse(200, { labels: [] });
  const rows = await db
    .prepare(`SELECT id, account_id, name, color FROM mail_labels WHERE account_id IN (${placeholders(ids.length)}) ORDER BY name COLLATE NOCASE`)
    .bind(...ids)
    .all<{ id: string; account_id: string; name: string; color: string }>();
  return jsonResponse(200, { labels: rows.results.map((r) => ({ id: r.id, accountId: r.account_id, name: r.name, color: r.color })) });
});

export const onRequestPost = mailHandler(async ({ ctx, db, access }) => {
  const body = await readJsonBody(ctx.request);
  if (!body) return errorResponse(400, "Invalid request body");
  const accountId = asString(body.accountId, 100);
  if (!access.has(accountId)) return errorResponse(404, "Mailbox not found.");
  const name = asString(body.name, 60).replace(/[\r\n]+/g, " ").trim();
  if (!name) return errorResponse(400, "Label name is required.");
  const color = asString(body.color, 7) || "#0D68EF";
  if (!COLOR_RE.test(color)) return errorResponse(400, "Color must be a hex value like #0D68EF.");
  const dupe = await db.prepare(`SELECT id FROM mail_labels WHERE account_id = ? AND name = ? COLLATE NOCASE`).bind(accountId, name).first();
  if (dupe) return errorResponse(409, "A label with that name already exists in this mailbox.");
  const id = crypto.randomUUID();
  const now = nowIso();
  await db.prepare(`INSERT INTO mail_labels (id, account_id, name, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(id, accountId, name, color, now, now).run();
  return jsonResponse(201, { id, accountId, name, color });
});
