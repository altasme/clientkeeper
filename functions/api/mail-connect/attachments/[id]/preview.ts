// GET /api/mail-connect/attachments/:id/preview -- inline view for safe
// types only (also cid: images in a message body). See
// functions/_lib/mailConnect/routes.ts.

import { previewAttachmentRoute } from "../../../../_lib/mailConnect/routes";

export const onRequestGet = previewAttachmentRoute;
