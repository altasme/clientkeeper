// DELETE /api/app/mail/messages/:id/labels/:labelId -- remove a label from a message

import { applyMessageAction } from "../../../../../../_lib/mail/actions";
import { errorResponse, jsonResponse, normalizeParam } from "../../../../../../_lib/mail/http";
import { mailHandler } from "../../../../../../_lib/mail/route";
import { loadMessages } from "../../../../../../_lib/mail/store";

export const onRequestDelete = mailHandler<"id" | "labelId">(async ({ ctx, db, user, access }) => {
  const id = normalizeParam(ctx.params.id);
  const [row] = await loadMessages(db, [id], [...access.keys()]);
  if (!row) return errorResponse(404, "Message not found.");
  const result = await applyMessageAction(db, ctx.env.MAIL_ATTACHMENTS, {
    ids: [id],
    accountIds: [row.account_id],
    action: "removeLabel",
    labelId: normalizeParam(ctx.params.labelId),
    actorId: user.id,
  });
  if (!result.ok) return errorResponse(result.status, result.error);
  return jsonResponse(200, { ok: true });
});
