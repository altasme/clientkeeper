// Server-to-server, called by a client admin panel's backend with
// `Authorization: Bearer <integration secret>`:
//   GET    /api/mail-connect/admin/grants?externalUserId=   list one user's grants
//   POST   /api/mail-connect/admin/grants                   create/replace one grant
//   DELETE /api/mail-connect/admin/grants                   revoke one grant
// No session cookie is involved. Tenant boundary and auth:
// functions/_lib/mailConnect/admin.ts.

import { integrationHandler, listGrantsRoute, revokeGrantRoute, upsertGrantRoute } from "../../../_lib/mailConnect/admin";

export const onRequestGet = integrationHandler(listGrantsRoute);
export const onRequestPost = integrationHandler(upsertGrantRoute);
export const onRequestDelete = integrationHandler(revokeGrantRoute);
