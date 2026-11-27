// GET  /api/app/mail-integrations   every Webmail Connect integration (any staff role)
// POST /api/app/mail-integrations   { clientId, name } -> 201 { integration, secret }
//      The secret is returned ONCE and never again. Owner/admin.
// Altaventures' own registry ("master control"); a client's per-user
// mailbox grants are NOT managed here. See
// functions/_lib/mailConnect/integrations.ts.

import type { StaffUser } from "../../../_lib/roles";
import { json, readBody, requireEmailAdmin, type EmailEnv } from "../../../_lib/emailServices/http";
import { createIntegration, listIntegrations } from "../../../_lib/mailConnect/integrations";

export const onRequestGet: PagesFunction<EmailEnv> = async ({ env }) => {
  if (!env.DB) return json(500, { error: "Not configured" });
  return json(200, { integrations: await listIntegrations(env.DB) });
};

export const onRequestPost: PagesFunction<EmailEnv, string, { staffUser: StaffUser }> = async ({ env, request, data }) => {
  if (!env.DB) return json(500, { error: "Not configured" });
  const denied = requireEmailAdmin(data.staffUser);
  if (denied) return denied;
  const body = (await readBody(request)) ?? {};
  const r = await createIntegration(env.DB, { clientId: body.clientId, name: body.name, staffId: data.staffUser.id });
  return r.ok ? json(201, r.value) : json(r.status, { error: r.error });
};
