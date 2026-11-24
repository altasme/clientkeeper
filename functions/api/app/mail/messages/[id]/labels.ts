// POST /api/app/mail/messages/:id/labels -- { labelId } apply a label (must belong to the message's mailbox)

import { applyMessageAction } from "../../../../../_lib/mail/actions";
import { errorResponse, jsonResponse, normalizeParam, readJsonBody } from "../../../../../_lib/mail/http";
import { mailHandler } from "../../../../../_lib/mail/route";
import { loadMessages } from "../../../../../_lib/mail/store";

export const onRequestPost = mailHandler<"id">(async ({ ctx, db, user, access }) => {
  const id = normalizeParam(ctx.params.id);
  const [row] = await loadMessages(db, [id], [...access.keys()]);
  if (!row) return errorResponse(404, "Message not found.");
  const body = await readJsonBody(ctx.request);
  if (!body || typeof body.labelId !== "string") return errorResponse(400, "labelId is required.");
  const result = await applyMessageAction(db, ctx.env.MAIL_ATTACHMENTS, { ids: [id], accountIds: [row.account_id], action: "applyLabel", labelId: body.labelId, actorId: user.id });
  if (!result.ok) return errorResponse(result.status, result.error);
  return jsonResponse(200, { ok: true });
});
