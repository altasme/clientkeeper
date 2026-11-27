// GET /api/mail-connect/threads/:id?mailboxId=&context=<folder> -- a
// conversation in one granted mailbox. See functions/_lib/mailConnect/routes.ts.

import { getThreadRoute } from "../../../_lib/mailConnect/routes";

export const onRequestGet = getThreadRoute;
