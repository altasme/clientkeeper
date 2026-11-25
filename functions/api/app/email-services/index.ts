// GET  /api/app/email-services          list (any staff role)
// POST /api/app/email-services          create for an existing client (owner/admin)
// CLAUDE.md §34.

import type { StaffUser } from "../../../_lib/roles";
import { createService, listServices } from "../../../_lib/emailServices/services";
import { engineResponse, json, readBody, requireEmailAdmin, staffActor, type EmailEnv } from "../../../_lib/emailServices/http";
import { SERVICE_STATUSES } from "../../../_lib/emailServices/policy";
import { cleanText, normalizeDomain } from "../../../_lib/emailServices/validation";

export const onRequestGet: PagesFunction<EmailEnv> = async ({ request, env }) => {
  if (!env.DB) return json(500, { error: "Not configured" });
  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  if (status && !(SERVICE_STATUSES as readonly string[]).includes(status)) return json(400, { error: "Unknown status filter." });
  const services = await listServices(env.DB, { status, q: cleanText(url.searchParams.get("q"), 100), clientId: url.searchParams.get("clientId") });
  return json(200, { services });
};

export const onRequestPost: PagesFunction<EmailEnv, string, { staffUser: StaffUser }> = async ({ request, env, data }) => {
  if (!env.DB) return json(500, { error: "Not configured" });
  const denied = requireEmailAdmin(data.staffUser);
  if (denied) return denied;
  const body = await readBody(request);
  if (!body) return json(400, { error: "Invalid request body" });

  const clientId = typeof body.clientId === "string" ? body.clientId : "";
  if (!clientId) return json(400, { error: "Choose a client." });
  let domain: string | null = null;
  if (body.domain !== undefined && body.domain !== null && body.domain !== "") {
    domain = normalizeDomain(body.domain);
    if (!domain) return json(400, { error: "That domain doesn't look valid." });
  }
  const planId = typeof body.planId === "string" && body.planId ? body.planId : null;

  return engineResponse(
    await createService(env.DB, {
      clientId,
      planId,
      domain,
      internalNotes: cleanText(body.internalNotes, 4000),
      providerServiceId: cleanText(body.providerServiceId, 200),
      actor: staffActor(data.staffUser),
    }),
    201
  );
};
