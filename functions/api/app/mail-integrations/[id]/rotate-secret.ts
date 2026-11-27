// POST /api/app/mail-integrations/:id/rotate-secret -> { secret }, shown
// ONCE. The previous secret stops working immediately. Owner/admin.

import type { StaffUser } from "../../../../_lib/roles";
import { json, param, requireEmailAdmin, type EmailEnv } from "../../../../_lib/emailServices/http";
import { rotateIntegrationSecret } from "../../../../_lib/mailConnect/integrations";

export const onRequestPost: PagesFunction<EmailEnv, "id", { staffUser: StaffUser }> = async ({ env, params, data }) => {
  if (!env.DB) return json(500, { error: "Not configured" });
  const denied = requireEmailAdmin(data.staffUser);
  if (denied) return denied;
  const r = await rotateIntegrationSecret(env.DB, { id: param(params.id), staffId: data.staffUser.id });
  return r.ok ? json(200, r.value) : json(r.status, { error: r.error });
};
