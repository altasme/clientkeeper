// POST /api/app/mail/messages/:id/inbox -- Move an archived message back to Inbox (or Sent, for outbound).

import { applyMessageAction, errorResponse, jsonResponse, normalizeParam, loadMessages } from "@altasme/webmail-kit";
import { mailHandler } from "../../../../../_lib/mailHandler";

export const onRequestPost = mailHandler<"id">(async ({ ctx, db, user, access }) => {
  const id = normalizeParam(ctx.params.id);
  const ids = [...access.keys()];
  const [row] = await loadMessages(db, [id], ids);
  if (!row) return errorResponse(404, "Message not found.");
  const result = await applyMessageAction(db, ctx.env.MAIL_ATTACHMENTS, { ids: [id], accountIds: ids, action: "moveToInbox", actorId: user.id });
  if (!result.ok) return errorResponse(result.status, result.error);
  const [updated] = await loadMessages(db, [id], ids);
  return jsonResponse(200, { ok: true, changed: result.affected > 0, folder: updated?.folder });
});
