// DELETE /api/app/email-services/:serviceId/domains/:domainId  { reason? }
// Removes a domain from the service, only if no mailbox on it still counts
// against the allowance. Owner/admin. CLAUDE.md §34.

import type { StaffUser } from "../../../../../_lib/roles";
import { removeDomain } from "../../../../../_lib/emailServices/engine";
import { engineResponse, json, param, readBody, requireEmailAdmin, staffActor, type EmailEnv } from "../../../../../_lib/emailServices/http";
import { cleanText } from "../../../../../_lib/emailServices/validation";

export const onRequestDelete: PagesFunction<EmailEnv, "serviceId" | "domainId", { staffUser: StaffUser }> = async ({ request, env, params, data }) => {
  if (!env.DB) return json(500, { error: "Not configured" });
  const denied = requireEmailAdmin(data.staffUser);
  if (denied) return denied;
  const body = await readBody(request);
  return engineResponse(
    await removeDomain(env.DB, { serviceId: param(params.serviceId), domainId: param(params.domainId), reason: cleanText(body?.reason, 500), actor: staffActor(data.staffUser) })
  );
};
