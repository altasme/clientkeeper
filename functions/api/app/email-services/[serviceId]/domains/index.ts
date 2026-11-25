// POST /api/app/email-services/:serviceId/domains  { domain, isPrimary? }
// Owner/admin. A domain can be live on only one service. CLAUDE.md §34.

import type { StaffUser } from "../../../../../_lib/roles";
import { addDomain } from "../../../../../_lib/emailServices/engine";
import { engineResponse, json, param, readBody, requireEmailAdmin, staffActor, type EmailEnv } from "../../../../../_lib/emailServices/http";
import { normalizeDomain } from "../../../../../_lib/emailServices/validation";

export const onRequestPost: PagesFunction<EmailEnv, "serviceId", { staffUser: StaffUser }> = async ({ request, env, params, data }) => {
  if (!env.DB) return json(500, { error: "Not configured" });
  const denied = requireEmailAdmin(data.staffUser);
  if (denied) return denied;
  const body = await readBody(request);
  const domain = body ? normalizeDomain(body.domain) : null;
  if (!domain) return json(400, { error: "That domain doesn't look valid." });
  return engineResponse(await addDomain(env.DB, { serviceId: param(params.serviceId), domain, isPrimary: body?.isPrimary === true, actor: staffActor(data.staffUser) }), 201);
};
