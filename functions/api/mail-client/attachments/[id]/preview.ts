// GET /api/mail-client/attachments/:id/preview -- inline view for safe
// types only (also cid: images in a message body). See
// functions/_lib/mailClient/routes.ts.

import { previewAttachmentRoute } from "../../../../_lib/mailClient/routes";

export const onRequestGet = previewAttachmentRoute;
