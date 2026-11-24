// POST /api/app/mail/messages/:id/restore -- Restore from Junk/Trash to where it was.

import { applyMessageAction } from "../../../../../_lib/mail/actions";
import { errorResponse, jsonResponse, normalizeParam } from "../../../../../_lib/mail/http";
import { mailHandler } from "../../../../../_lib/mail/route";
import { loadMessages } from "../../../../../_lib/mail/store";

export const onRequestPost = mailHandler<"id">(async ({ ctx, db, user, access }) => {
  const id = normalizeParam(ctx.params.id);
  const ids = [...access.keys()];
  const [row] = await loadMessages(db, [id], ids);
  if (!row) return errorResponse(404, "Message not found.");
  const result = await applyMessageAction(db, ctx.env.MAIL_ATTACHMENTS, { ids: [id], accountIds: ids, action: "restore", actorId: user.id });
  if (!result.ok) return errorResponse(result.status, result.error);
  const [updated] = await loadMessages(db, [id], ids);
  return jsonResponse(200, { ok: true, changed: result.affected > 0, folder: updated?.folder });
});
