// POST /api/app/email-services/:serviceId/request-links/:linkId/revoke
// open -> revoked, so the link stops working. 409 if it was already used
// (decline the request it created instead) or already revoked.
// Owner/admin. CLAUDE.md §36.

import type { StaffUser } from "../../../../../../_lib/roles";
import { revokeRequestLink } from "../../../../../../_lib/emailServices/requestLinks";
import { engineResponse, json, param, requireEmailAdmin, staffActor, type EmailEnv } from "../../../../../../_lib/emailServices/http";

export const onRequestPost: PagesFunction<EmailEnv, "serviceId" | "linkId", { staffUser: StaffUser }> = async ({ env, params, data }) => {
  if (!env.DB) return json(500, { error: "Not configured" });
  const denied = requireEmailAdmin(data.staffUser);
  if (denied) return denied;
  return engineResponse(await revokeRequestLink(env.DB, { serviceId: param(params.serviceId), linkId: param(params.linkId), actor: staffActor(data.staffUser) }));
};
