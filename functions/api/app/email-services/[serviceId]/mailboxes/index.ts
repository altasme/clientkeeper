// POST /api/app/email-services/:serviceId/mailboxes
//   { domainId, localPart, password, isPrimary?, idempotencyKey? }
// Reserves a slot atomically, then asks the provider to create the
// mailbox. Responses:
//   201 the provider confirmed the mailbox (status active)
//   200 a repeat of an earlier request with the same idempotencyKey
//   202 outcome unknown: the slot is held, status needs_review
//   503 the provider isn't configured (today, always): slot released
//   502 any other provider failure: slot released
//   409 no slot / service not provisionable / address already recorded
// The password goes only to the provider and is never stored or logged.
// Owner/admin. CLAUDE.md §34.

import type { StaffUser } from "../../../../../_lib/roles";
import { loadService, provisionMailbox } from "../../../../../_lib/emailServices/engine";
import { json, param, readBody, requireEmailAdmin, staffActor, type EmailEnv } from "../../../../../_lib/emailServices/http";
import { getEmailProvider } from "../../../../../_lib/emailServices/provider";
import { provisionResponse } from "../../../../../_lib/emailServices/responses";
import { normalizeLocalPart, validateMailboxPassword } from "../../../../../_lib/emailServices/validation";

export const onRequestPost: PagesFunction<EmailEnv, "serviceId", { staffUser: StaffUser }> = async ({ request, env, params, data }) => {
  if (!env.DB) return json(500, { error: "Not configured" });
  const denied = requireEmailAdmin(data.staffUser);
  if (denied) return denied;
  const body = await readBody(request);
  if (!body) return json(400, { error: "Invalid request body" });

  const localPart = normalizeLocalPart(body.localPart);
  if (!localPart) return json(400, { error: "The mailbox name may use letters, numbers, dots, dashes, underscores and plus signs." });
  if (typeof body.domainId !== "string" || !body.domainId) return json(400, { error: "Choose a domain." });
  const password = validateMailboxPassword(body.password);
  if (!password.ok) return json(400, { error: password.error });
  const idempotencyKey = typeof body.idempotencyKey === "string" && /^[A-Za-z0-9-]{8,100}$/.test(body.idempotencyKey) ? body.idempotencyKey : null;

  const service = await loadService(env.DB, param(params.serviceId));
  if (!service) return json(404, { error: "Email service not found." });

  const result = await provisionMailbox(env.DB, getEmailProvider(service.provider), {
    serviceId: service.id,
    domainId: body.domainId,
    localPart,
    password: password.password,
    isPrimary: body.isPrimary === true,
    idempotencyKey,
    actor: staffActor(data.staffUser),
  });
  return provisionResponse(result);
};
