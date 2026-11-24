// GET /api/app/mail/attachments/:id/preview -- inline view for SAFE types
// only (png/jpeg/gif/webp images, PDF, plain text/CSV). Text is always
// served as text/plain (never HTML); images get a sandboxing CSP. Anything
// else -> 415, the UI offers download instead. Also used for cid: inline
// images inside the sanitized email body iframe (same-origin, cookie-auth).

import { errorResponse, normalizeParam, authorizeAttachment, contentDisposition, isPreviewable } from "@altasme/webmail-kit";
import { mailHandler } from "../../../../../_lib/mailHandler";

export const onRequestGet = mailHandler<"id">(async ({ ctx, db, user, access }) => {
  const att = await authorizeAttachment(db, access, user.id, normalizeParam(ctx.params.id));
  if (!att) return errorResponse(404, "Attachment not found.");
  if (att.storage_status !== "stored") return errorResponse(410, "This attachment could not be stored when the email arrived.");
  const type = att.mime_type.toLowerCase();
  if (!isPreviewable(type)) return errorResponse(415, "Preview isn't available for this file type. Download it instead.");
  const obj = ctx.env.MAIL_ATTACHMENTS ? await ctx.env.MAIL_ATTACHMENTS.get(att.storage_key) : null;
  if (!obj) return errorResponse(410, "This attachment is no longer available.");
  const isText = type.startsWith("text/");
  const headers: Record<string, string> = {
    "content-type": isText ? "text/plain; charset=utf-8" : type,
    "content-disposition": contentDisposition("inline", att.filename),
    "x-content-type-options": "nosniff",
    "cache-control": "private, max-age=300",
    "cross-origin-resource-policy": "same-origin",
  };
  // Chrome's PDF viewer refuses to render under a `sandbox` CSP, so PDFs get
  // a restrictive policy without it; images/text get the full sandbox.
  headers["content-security-policy"] = type === "application/pdf" ? "default-src 'none'; object-src 'self'; frame-ancestors 'self'" : "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox; frame-ancestors 'self'";
  return new Response(obj.body, { headers });
});
