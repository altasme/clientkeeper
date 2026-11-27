// GET /api/mail-connect/messages?mailboxId=&folder=&q=&... -- one granted
// mailbox's conversation list or search. See functions/_lib/mailConnect/routes.ts.

import { listMessagesRoute } from "../../../_lib/mailConnect/routes";

export const onRequestGet = listMessagesRoute;
