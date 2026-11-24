// GET /api/app/mail/messages?accountId=<id|all>&folder=&labelId=&q=&unread=1&starred=1&hasAttachments=1&from=&to=&dateFrom=&dateTo=&sort=&limit=&offset=
// Conversation list for a folder/label/search. See @altasme/webmail-kit's query.ts.

import { scopeAccountIds, jsonResponse, listThreads, parseListParams } from "@altasme/webmail-kit";
import { mailHandler } from "../../../../_lib/mailHandler";

export const onRequestGet = mailHandler(async ({ ctx, db, access }) => {
  const url = new URL(ctx.request.url);
  const ids = scopeAccountIds(access, url.searchParams.get("accountId"));
  const params = parseListParams(url);
  const result = await listThreads(db, ids, params);
  return jsonResponse(200, { ...result, offset: params.offset, limit: params.limit });
});
