// GET /api/mail-client/threads/:id?context=<folder> -- a conversation in the
// signed-in mailbox. See functions/_lib/mailClient/routes.ts.

import { getThreadRoute } from "../../../_lib/mailClient/routes";

export const onRequestGet = getThreadRoute;
