// GET /api/mail-connect/compose?mailboxId=&mode=&sourceMessageId= -- prefill
// only; needs the send permission. See functions/_lib/mailConnect/routes.ts.

import { composePrefillRoute } from "../../_lib/mailConnect/routes";

export const onRequestGet = composePrefillRoute;
