// GET /api/mail-connect/attachments/:id -- download an attachment of a
// message in any mailbox the session can read. See
// functions/_lib/mailConnect/routes.ts.

import { downloadAttachmentRoute } from "../../../_lib/mailConnect/routes";

export const onRequestGet = downloadAttachmentRoute;
