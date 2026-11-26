// GET /api/mail-client/attachments/:id -- download an attachment of a
// message in the signed-in mailbox (always Content-Disposition: attachment).
// See functions/_lib/mailClient/routes.ts.

import { downloadAttachmentRoute } from "../../../_lib/mailClient/routes";

export const onRequestGet = downloadAttachmentRoute;
