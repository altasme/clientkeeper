// GET  /api/app/email-plans[?all=1]  plan catalog (any staff role)
// POST /api/app/email-plans          create a plan (owner/admin)
// CLAUDE.md §34.

import type { StaffUser } from "../../../_lib/roles";
import { createPlan, listPlans, validatePlanBody } from "../../../_lib/emailServices/plans";
import { json, readBody, requireEmailAdmin, type EmailEnv } from "../../../_lib/emailServices/http";

export const onRequestGet: PagesFunction<EmailEnv> = async ({ request, env }) => {
  if (!env.DB) return json(500, { error: "Not configured" });
  const all = new URL(request.url).searchParams.get("all") === "1";
  return json(200, { plans: await listPlans(env.DB, all) });
};

export const onRequestPost: PagesFunction<EmailEnv, string, { staffUser: StaffUser }> = async ({ request, env, data }) => {
  if (!env.DB) return json(500, { error: "Not configured" });
  const denied = requireEmailAdmin(data.staffUser);
  if (denied) return denied;
  const body = await readBody(request);
  if (!body) return json(400, { error: "Invalid request body" });
  const v = validatePlanBody(body, null);
  if (!v.ok) return json(400, { error: v.error });
  return json(201, { id: await createPlan(env.DB, v.fields, data.staffUser) });
};
