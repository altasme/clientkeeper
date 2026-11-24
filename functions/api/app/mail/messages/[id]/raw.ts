// GET /api/app/mail/messages/:id/raw -- download the original .eml (inbound
// messages whose raw copy was stored in R2). Authenticated + access-checked;
// always served as a download, never rendered.

import { errorResponse, normalizeParam, placeholders } from "@altasme/webmail-kit";
import { mailHandler } from "../../../../../_lib/mailHandler";

export const onRequestGet = mailHandler<"id">(async ({ ctx, db, access }) => {
  const ids = [...access.keys()];
  if (!ids.length) return errorResponse(404, "Message not found.");
  const row = await db
    .prepare(`SELECT raw_storage_key FROM mail_messages WHERE id = ? AND account_id IN (${placeholders(ids.length)})`)
    .bind(normalizeParam(ctx.params.id), ...ids)
    .first<{ raw_storage_key: string | null }>();
  if (!row) return errorResponse(404, "Message not found.");
  if (!row.raw_storage_key) return errorResponse(404, "No original copy is stored for this message.");
  const obj = ctx.env.MAIL_ATTACHMENTS ? await ctx.env.MAIL_ATTACHMENTS.get(row.raw_storage_key) : null;
  if (!obj) return errorResponse(410, "The original copy is no longer available.");
  return new Response(obj.body, {
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="message-${normalizeParam(ctx.params.id).slice(0, 8)}.eml"`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, no-store",
    },
  });
});
