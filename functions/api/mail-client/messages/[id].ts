// GET   /api/mail-client/messages/:id[?remoteImages=1] -- one message, sanitized body
// PATCH /api/mail-client/messages/:id -- { isRead?, isStarred? }
// See functions/_lib/mailClient/routes.ts.

import { getMessageRoute, patchMessageRoute } from "../../../_lib/mailClient/routes";

export const onRequestGet = getMessageRoute;
export const onRequestPatch = patchMessageRoute;
