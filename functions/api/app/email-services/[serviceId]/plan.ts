// POST /api/app/email-services/:serviceId/plan  { planId, reason? }
// Assigns or changes the plan (snapshotting its values). Owner/admin.
// A reason is required when replacing an existing plan. CLAUDE.md §34.

import type { StaffUser } from "../../../../_lib/roles";
import { assignPlan } from "../../../../_lib/emailServices/engine";
import { engineResponse, json, param, readBody, requireEmailAdmin, staffActor, type EmailEnv } from "../../../../_lib/emailServices/http";
import { cleanText } from "../../../../_lib/emailServices/validation";

export const onRequestPost: PagesFunction<EmailEnv, "serviceId", { staffUser: StaffUser }> = async ({ request, env, params, data }) => {
  if (!env.DB) return json(500, { error: "Not configured" });
  const denied = requireEmailAdmin(data.staffUser);
  if (denied) return denied;
  const body = await readBody(request);
  if (!body || typeof body.planId !== "string" || !body.planId) return json(400, { error: "Choose a plan." });
  return engineResponse(await assignPlan(env.DB, { serviceId: param(params.serviceId), planId: body.planId, reason: cleanText(body.reason, 500), actor: staffActor(data.staffUser) }));
};
