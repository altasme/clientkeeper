// GET  /api/app/mail/identities/:id/signatures -- list
// POST /api/app/mail/identities/:id/signatures -- create { name, bodyHtml, useForNew, useForReply }
// Anyone who can send from the identity (or an owner/admin) can manage its signatures.

import { isMailAdmin, loadSignatures, serializeSignature, asString, errorResponse, jsonResponse, normalizeParam, nowIso, readJsonBody, sanitizeOutboundHtml, htmlToText } from "@altasme/webmail-kit";
import { mailHandler } from "../../../../../_lib/mailHandler";

export const onRequestGet = mailHandler<"id">(async ({ ctx, db, user, access }) => {
  const id = normalizeParam(ctx.params.id);
  if (!access.has(id) && !isMailAdmin(user)) return errorResponse(404, "Mailbox not found.");
  return jsonResponse(200, { signatures: (await loadSignatures(db, [id])).map(serializeSignature) });
});

export const onRequestPost = mailHandler<"id">(async ({ ctx, db, user, access }) => {
  const id = normalizeParam(ctx.params.id);
  if (!(access.get(id)?.canSend || isMailAdmin(user))) return errorResponse(404, "Mailbox not found.");
  const account = await db.prepare(`SELECT id FROM mail_accounts WHERE id = ?`).bind(id).first();
  if (!account) return errorResponse(404, "Mailbox not found.");
  const body = await readJsonBody(ctx.request);
  if (!body) return errorResponse(400, "Invalid request body");
  const name = asString(body.name, 100).trim();
  if (!name) return errorResponse(400, "Signature name is required.");
  const html = await sanitizeOutboundHtml(asString(body.bodyHtml, 50_000));
  const useForNew = body.useForNew === true;
  const useForReply = body.useForReply === true;
  const sid = crypto.randomUUID();
  const now = nowIso();
  const stmts = [];
  if (useForNew) stmts.push(db.prepare(`UPDATE mail_signatures SET use_for_new = 0 WHERE account_id = ?`).bind(id));
  if (useForReply) stmts.push(db.prepare(`UPDATE mail_signatures SET use_for_reply = 0 WHERE account_id = ?`).bind(id));
  stmts.push(
    db
      .prepare(`INSERT INTO mail_signatures (id, account_id, name, body_html, body_text, use_for_new, use_for_reply, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(sid, id, name, html, htmlToText(html), useForNew ? 1 : 0, useForReply ? 1 : 0, now, now)
  );
  await db.batch(stmts);
  return jsonResponse(201, { id: sid });
});
