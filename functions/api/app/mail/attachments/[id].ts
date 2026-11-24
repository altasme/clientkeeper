// GET    /api/app/mail/attachments/:id -- authenticated download (always Content-Disposition: attachment)
// DELETE /api/app/mail/attachments/:id -- remove an attachment from one of the caller's drafts
// No public or long-lived URL exists for any attachment.

import { errorResponse, jsonResponse, normalizeParam } from "../../../../_lib/mail/http";
import { mailHandler } from "../../../../_lib/mail/route";
import { authorizeAttachment, contentDisposition } from "../../../../_lib/mail/drafts";
import { deleteUnreferencedObjects } from "../../../../_lib/mail/storage";

export const onRequestGet = mailHandler<"id">(async ({ ctx, db, user, access }) => {
  const att = await authorizeAttachment(db, access, user.id, normalizeParam(ctx.params.id));
  if (!att) return errorResponse(404, "Attachment not found.");
  if (att.storage_status !== "stored") return errorResponse(410, "This attachment could not be stored when the email arrived.");
  const obj = ctx.env.MAIL_ATTACHMENTS ? await ctx.env.MAIL_ATTACHMENTS.get(att.storage_key) : null;
  if (!obj) return errorResponse(410, "This attachment is no longer available.");
  return new Response(obj.body, {
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": contentDisposition("attachment", att.filename),
      "content-length": String(obj.size),
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, no-store",
    },
  });
});

export const onRequestDelete = mailHandler<"id">(async ({ ctx, db, user, access }) => {
  const att = await authorizeAttachment(db, access, user.id, normalizeParam(ctx.params.id));
  if (!att || !att.draft_id) return errorResponse(404, "Attachment not found.");
  await db.prepare(`DELETE FROM mail_attachments WHERE id = ?`).bind(att.id).run();
  await deleteUnreferencedObjects(db, ctx.env.MAIL_ATTACHMENTS, [att.storage_key]);
  return jsonResponse(200, { ok: true });
});
