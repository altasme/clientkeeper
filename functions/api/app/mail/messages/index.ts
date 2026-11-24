// GET /api/app/mail/messages?accountId=<id|all>&folder=&labelId=&q=&unread=1&starred=1&hasAttachments=1&from=&to=&dateFrom=&dateTo=&sort=&limit=&offset=
// Conversation list for a folder/label/search. See _lib/mail/query.ts.

import { scopeAccountIds } from "../../../../_lib/mail/access";
import { jsonResponse } from "../../../../_lib/mail/http";
import { listThreads, parseListParams } from "../../../../_lib/mail/query";
import { mailHandler } from "../../../../_lib/mail/route";

export const onRequestGet = mailHandler(async ({ ctx, db, access }) => {
  const url = new URL(ctx.request.url);
  const ids = scopeAccountIds(access, url.searchParams.get("accountId"));
  const params = parseListParams(url);
  const result = await listThreads(db, ids, params);
  return jsonResponse(200, { ...result, offset: params.offset, limit: params.limit });
});
