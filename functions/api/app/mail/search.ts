// GET /api/app/mail/search -- same engine as /messages, but defaults to
// searching every folder except Trash/Junk (folder=all) unless a folder is
// given. Always scoped to the caller's accessible mailboxes.

import { scopeAccountIds, errorResponse, jsonResponse, listThreads, parseListParams } from "@altasme/webmail-kit";
import { mailHandler } from "../../../_lib/mailHandler";

export const onRequestGet = mailHandler(async ({ ctx, db, access }) => {
  const url = new URL(ctx.request.url);
  if (!url.searchParams.get("folder")) url.searchParams.set("folder", "all");
  const params = parseListParams(url);
  if (!params.q && !params.from && !params.to && !params.dateFrom && !params.dateTo && !params.unread && !params.read && !params.starred && !params.hasAttachments && !params.labelId) {
    return errorResponse(400, "Enter something to search for.");
  }
  const ids = scopeAccountIds(access, url.searchParams.get("accountId"));
  const result = await listThreads(db, ids, params);
  return jsonResponse(200, { ...result, offset: params.offset, limit: params.limit });
});
