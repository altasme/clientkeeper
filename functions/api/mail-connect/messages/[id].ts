// GET   /api/mail-connect/messages/:id?mailboxId=[&remoteImages=1]
// PATCH /api/mail-connect/messages/:id -- { mailboxId, isRead?, isStarred? }
// See functions/_lib/mailConnect/routes.ts.

import { getMessageRoute, patchMessageRoute } from "../../../_lib/mailConnect/routes";

export const onRequestGet = getMessageRoute;
export const onRequestPatch = patchMessageRoute;
