// GET   /api/app/mail-integrations/:id   the integration + every mailbox it may grant (any staff role)
// PATCH /api/app/mail-integrations/:id   { name?, status?: "active" | "disabled" } (owner/admin)
// Disabling ends every session and refuses the secret and any pending
// launch code on their next use. See functions/_lib/mailConnect/integrations.ts.

import type { StaffUser } from "../../../_lib/roles";
import { json, param, readBody, requireEmailAdmin, type EmailEnv } from "../../../_lib/emailServices/http";
import { getIntegrationDetail, updateIntegration } from "../../../_lib/mailConnect/integrations";

export const onRequestGet: PagesFunction<EmailEnv, "id"> = async ({ env, params }) => {
  if (!env.DB) return json(500, { error: "Not configured" });
  const r = await getIntegrationDetail(env.DB, param(params.id));
  return r.ok ? json(200, r.value) : json(r.status, { error: r.error });
};

export const onRequestPatch: PagesFunction<EmailEnv, "id", { staffUser: StaffUser }> = async ({ env, params, request, data }) => {
  if (!env.DB) return json(500, { error: "Not configured" });
  const denied = requireEmailAdmin(data.staffUser);
  if (denied) return denied;
  const body = (await readBody(request)) ?? {};
  const r = await updateIntegration(env.DB, { id: param(params.id), name: body.name, status: body.status, staffId: data.staffUser.id });
  return r.ok ? json(200, r.value) : json(r.status, { error: r.error });
};
