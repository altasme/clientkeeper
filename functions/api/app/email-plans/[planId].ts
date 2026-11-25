// PATCH /api/app/email-plans/:planId  partial update, incl. status
// 'archived'. Owner/admin. Existing services keep their snapshotted values.
// CLAUDE.md §34.

import type { StaffUser } from "../../../_lib/roles";
import { updatePlan, validatePlanBody, type PlanRow } from "../../../_lib/emailServices/plans";
import { json, param, readBody, requireEmailAdmin, type EmailEnv } from "../../../_lib/emailServices/http";

export const onRequestPatch: PagesFunction<EmailEnv, "planId", { staffUser: StaffUser }> = async ({ request, env, params, data }) => {
  if (!env.DB) return json(500, { error: "Not configured" });
  const denied = requireEmailAdmin(data.staffUser);
  if (denied) return denied;
  const existing = await env.DB.prepare(`SELECT * FROM email_plans WHERE id = ?`).bind(param(params.planId)).first<PlanRow>();
  if (!existing) return json(404, { error: "Plan not found." });
  const body = await readBody(request);
  if (!body) return json(400, { error: "Invalid request body" });
  const v = validatePlanBody(body, existing);
  if (!v.ok) return json(400, { error: v.error });
  await updatePlan(env.DB, existing, v.fields, data.staffUser);
  return json(200, { ok: true });
};
