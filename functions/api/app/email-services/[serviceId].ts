// GET   /api/app/email-services/:serviceId   full detail (any staff role)
// PATCH /api/app/email-services/:serviceId   notes, provider service id,
//       expiration date (reason required to change it). Owner/admin.
// CLAUDE.md §34.

import type { StaffUser } from "../../../_lib/roles";
import { getServiceDetail, updateServiceFields } from "../../../_lib/emailServices/services";
import { engineResponse, json, param, readBody, requireEmailAdmin, staffActor, type EmailEnv } from "../../../_lib/emailServices/http";
import { cleanText, normalizeDateInput } from "../../../_lib/emailServices/validation";

export const onRequestGet: PagesFunction<EmailEnv, "serviceId"> = async ({ env, params }) => {
  if (!env.DB) return json(500, { error: "Not configured" });
  const detail = await getServiceDetail(env.DB, param(params.serviceId));
  return detail ? json(200, detail) : json(404, { error: "Email service not found." });
};

export const onRequestPatch: PagesFunction<EmailEnv, "serviceId", { staffUser: StaffUser }> = async ({ request, env, params, data }) => {
  if (!env.DB) return json(500, { error: "Not configured" });
  const denied = requireEmailAdmin(data.staffUser);
  if (denied) return denied;
  const body = await readBody(request);
  if (!body) return json(400, { error: "Invalid request body" });

  let expiresAt: string | null | undefined;
  if (body.expiresAt !== undefined) {
    expiresAt = body.expiresAt === null || body.expiresAt === "" ? null : normalizeDateInput(body.expiresAt);
    if (expiresAt === null && body.expiresAt) return json(400, { error: "Invalid expiration date." });
  }
  return engineResponse(
    await updateServiceFields(env.DB, {
      serviceId: param(params.serviceId),
      internalNotes: body.internalNotes !== undefined ? cleanText(body.internalNotes, 4000) : undefined,
      providerServiceId: body.providerServiceId !== undefined ? cleanText(body.providerServiceId, 200) : undefined,
      expiresAt,
      reason: cleanText(body.reason, 500),
      actor: staffActor(data.staffUser),
    })
  );
};
