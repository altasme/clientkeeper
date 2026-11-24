// POST /api/app/mail/messages/:id/star -- { starred: boolean } (defaults to true)

import { applyMessageAction } from "../../../../../_lib/mail/actions";
import { errorResponse, jsonResponse, normalizeParam, readJsonBody } from "../../../../../_lib/mail/http";
import { mailHandler } from "../../../../../_lib/mail/route";
import { loadMessages } from "../../../../../_lib/mail/store";

export const onRequestPost = mailHandler<"id">(async ({ ctx, db, user, access }) => {
  const id = normalizeParam(ctx.params.id);
  const ids = [...access.keys()];
  const [row] = await loadMessages(db, [id], ids);
  if (!row) return errorResponse(404, "Message not found.");
  const body = (await readJsonBody(ctx.request)) ?? {};
  const starred = body.starred !== false;
  await applyMessageAction(db, ctx.env.MAIL_ATTACHMENTS, { ids: [id], accountIds: ids, action: starred ? "star" : "unstar", actorId: user.id });
  return jsonResponse(200, { ok: true, isStarred: starred });
});
