// POST /api/app/mail/messages/bulk -- { messageIds: string[], action, labelId? }
// action: markRead | markUnread | star | unstar | archive | moveToInbox | junk | notJunk | trash | restore | deleteForever | applyLabel | removeLabel

import { applyMessageAction, isMessageAction, asStringArray, errorResponse, jsonResponse, readJsonBody } from "@altasme/webmail-kit";
import { mailHandler } from "../../../../_lib/mailHandler";

export const onRequestPost = mailHandler(async ({ ctx, db, user, access }) => {
  const body = await readJsonBody(ctx.request);
  if (!body) return errorResponse(400, "Invalid request body");
  if (!isMessageAction(body.action)) return errorResponse(400, "Unknown action.");
  const result = await applyMessageAction(db, ctx.env.MAIL_ATTACHMENTS, {
    ids: asStringArray(body.messageIds),
    accountIds: [...access.keys()],
    action: body.action,
    labelId: typeof body.labelId === "string" ? body.labelId : null,
    actorId: user.id,
  });
  if (!result.ok) return errorResponse(result.status, result.error);
  return jsonResponse(200, result);
});
