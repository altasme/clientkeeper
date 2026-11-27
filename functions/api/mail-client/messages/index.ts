// GET /api/mail-client/messages?folder=&q=&... -- the signed-in mailbox's
// conversation list or search. See functions/_lib/mailClient/routes.ts.

import { listMessagesRoute } from "../../../_lib/mailClient/routes";

export const onRequestGet = listMessagesRoute;
