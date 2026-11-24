// GET    /api/app/mail/messages/:id[?remoteImages=1] -- one message with sanitized body, recipients, attachments, labels
// PATCH  /api/app/mail/messages/:id -- { isRead?, isStarred? }
// DELETE /api/app/mail/messages/:id -- move to Trash; ?permanent=1 on a message already in Trash deletes it forever

import { applyMessageAction, errorResponse, jsonResponse, normalizeParam, readJsonBody, loadMessageDetails, loadMessages } from "@altasme/webmail-kit";
import { mailHandler } from "../../../../_lib/mailHandler";

export const onRequestGet = mailHandler<"id">(async ({ ctx, db, access }) => {
  const id = normalizeParam(ctx.params.id);
  const remote = new URL(ctx.request.url).searchParams.get("remoteImages") === "1";
  const [detail] = await loadMessageDetails(db, [...access.keys()], { messageIds: [id] }, remote);
  if (!detail) return errorResponse(404, "Message not found.");
  return jsonResponse(200, detail);
});

export const onRequestPatch = mailHandler<"id">(async ({ ctx, db, user, access }) => {
  const id = normalizeParam(ctx.params.id);
  const ids = [...access.keys()];
  const [row] = await loadMessages(db, [id], ids);
  if (!row) return errorResponse(404, "Message not found.");
  const body = await readJsonBody(ctx.request);
  if (!body) return errorResponse(400, "Invalid request body");
  if (typeof body.isRead === "boolean") {
    await applyMessageAction(db, ctx.env.MAIL_ATTACHMENTS, { ids: [id], accountIds: ids, action: body.isRead ? "markRead" : "markUnread", actorId: user.id });
  }
  if (typeof body.isStarred === "boolean") {
    await applyMessageAction(db, ctx.env.MAIL_ATTACHMENTS, { ids: [id], accountIds: ids, action: body.isStarred ? "star" : "unstar", actorId: user.id });
  }
  const [updated] = await loadMessages(db, [id], ids);
  return jsonResponse(200, { id, isRead: !!updated?.is_read, isStarred: !!updated?.is_starred, folder: updated?.folder });
});

export const onRequestDelete = mailHandler<"id">(async ({ ctx, db, user, access }) => {
  const id = normalizeParam(ctx.params.id);
  const ids = [...access.keys()];
  const [row] = await loadMessages(db, [id], ids);
  if (!row) return errorResponse(404, "Message not found.");
  const permanent = new URL(ctx.request.url).searchParams.get("permanent") === "1";
  if (permanent && row.folder !== "trash") return errorResponse(409, "Only messages already in Trash can be permanently deleted.");
  const result = await applyMessageAction(db, ctx.env.MAIL_ATTACHMENTS, { ids: [id], accountIds: ids, action: permanent ? "deleteForever" : "trash", actorId: user.id });
  if (!result.ok) return errorResponse(result.status, result.error);
  return jsonResponse(200, { ok: true, deleted: permanent });
});
