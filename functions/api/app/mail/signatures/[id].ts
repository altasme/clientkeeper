// PATCH  /api/app/mail/signatures/:id -- { name?, bodyHtml?, useForNew?, useForReply? }
// DELETE /api/app/mail/signatures/:id

import { isMailAdmin } from "../../../../_lib/mail/access";
import { asString, errorResponse, jsonResponse, normalizeParam, nowIso, readJsonBody } from "../../../../_lib/mail/http";
import { mailHandler, type MailHandlerArgs } from "../../../../_lib/mail/route";
import { sanitizeOutboundHtml } from "../../../../_lib/mail/sanitize";
import { htmlToText } from "../../../../_lib/mail/text";

async function loadOwned({ ctx, db, user, access }: MailHandlerArgs<"id">) {
  const id = normalizeParam(ctx.params.id);
  const sig = await db.prepare(`SELECT id, account_id FROM mail_signatures WHERE id = ?`).bind(id).first<{ id: string; account_id: string }>();
  if (!sig) return null;
  if (!(access.get(sig.account_id)?.canSend || isMailAdmin(user))) return null;
  return sig;
}

export const onRequestPatch = mailHandler<"id">(async (args) => {
  const sig = await loadOwned(args);
  if (!sig) return errorResponse(404, "Signature not found.");
  const { db, ctx } = args;
  const body = await readJsonBody(ctx.request);
  if (!body) return errorResponse(400, "Invalid request body");
  const sets: string[] = [];
  const vals: (string | number)[] = [];
  if (body.name !== undefined) {
    const name = asString(body.name, 100).trim();
    if (!name) return errorResponse(400, "Signature name is required.");
    sets.push("name = ?");
    vals.push(name);
  }
  if (body.bodyHtml !== undefined) {
    const html = await sanitizeOutboundHtml(asString(body.bodyHtml, 50_000));
    sets.push("body_html = ?", "body_text = ?");
    vals.push(html, htmlToText(html));
  }
  const stmts = [];
  if (typeof body.useForNew === "boolean") {
    if (body.useForNew) stmts.push(db.prepare(`UPDATE mail_signatures SET use_for_new = 0 WHERE account_id = ?`).bind(sig.account_id));
    sets.push("use_for_new = ?");
    vals.push(body.useForNew ? 1 : 0);
  }
  if (typeof body.useForReply === "boolean") {
    if (body.useForReply) stmts.push(db.prepare(`UPDATE mail_signatures SET use_for_reply = 0 WHERE account_id = ?`).bind(sig.account_id));
    sets.push("use_for_reply = ?");
    vals.push(body.useForReply ? 1 : 0);
  }
  if (!sets.length) return errorResponse(400, "Nothing to update.");
  stmts.push(db.prepare(`UPDATE mail_signatures SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).bind(...vals, nowIso(), sig.id));
  await db.batch(stmts);
  return jsonResponse(200, { ok: true });
});

export const onRequestDelete = mailHandler<"id">(async (args) => {
  const sig = await loadOwned(args);
  if (!sig) return errorResponse(404, "Signature not found.");
  await args.db.prepare(`DELETE FROM mail_signatures WHERE id = ?`).bind(sig.id).run();
  return jsonResponse(200, { ok: true });
});
