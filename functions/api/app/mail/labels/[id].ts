// PATCH  /api/app/mail/labels/:id -- { name?, color? }
// DELETE /api/app/mail/labels/:id -- removes the label from every message, then deletes it

import { asString, errorResponse, jsonResponse, normalizeParam, nowIso, readJsonBody } from "@altasme/webmail-kit";
import { mailHandler } from "../../../../_lib/mailHandler";
import { COLOR_RE } from "./index";

async function loadLabel(db: D1Database, id: string) {
  return db.prepare(`SELECT id, account_id, name, color FROM mail_labels WHERE id = ?`).bind(id).first<{ id: string; account_id: string; name: string; color: string }>();
}

export const onRequestPatch = mailHandler<"id">(async ({ ctx, db, access }) => {
  const label = await loadLabel(db, normalizeParam(ctx.params.id));
  if (!label || !access.has(label.account_id)) return errorResponse(404, "Label not found.");
  const body = await readJsonBody(ctx.request);
  if (!body) return errorResponse(400, "Invalid request body");
  const name = body.name !== undefined ? asString(body.name, 60).replace(/[\r\n]+/g, " ").trim() : label.name;
  const color = body.color !== undefined ? asString(body.color, 7) : label.color;
  if (!name) return errorResponse(400, "Label name is required.");
  if (!COLOR_RE.test(color)) return errorResponse(400, "Color must be a hex value like #0D68EF.");
  const dupe = await db.prepare(`SELECT id FROM mail_labels WHERE account_id = ? AND name = ? COLLATE NOCASE AND id != ?`).bind(label.account_id, name, label.id).first();
  if (dupe) return errorResponse(409, "A label with that name already exists in this mailbox.");
  await db.prepare(`UPDATE mail_labels SET name = ?, color = ?, updated_at = ? WHERE id = ?`).bind(name, color, nowIso(), label.id).run();
  return jsonResponse(200, { id: label.id, accountId: label.account_id, name, color });
});

export const onRequestDelete = mailHandler<"id">(async ({ ctx, db, access }) => {
  const label = await loadLabel(db, normalizeParam(ctx.params.id));
  if (!label || !access.has(label.account_id)) return errorResponse(404, "Label not found.");
  await db.batch([db.prepare(`DELETE FROM mail_message_labels WHERE label_id = ?`).bind(label.id), db.prepare(`DELETE FROM mail_labels WHERE id = ?`).bind(label.id)]);
  return jsonResponse(200, { ok: true });
});
