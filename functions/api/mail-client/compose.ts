// GET /api/mail-client/compose?mode=new|reply|reply_all|forward&sourceMessageId=
// Composer prefill for the signed-in mailbox. Creates nothing (no drafts
// for mailbox owners). See functions/_lib/mailClient/routes.ts.

import { composePrefillRoute } from "../../_lib/mailClient/routes";

export const onRequestGet = composePrefillRoute;
