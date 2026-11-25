// POST /api/app/email-services/:serviceId/entitlements
//   { kind: 'addon' | 'override', quantity: non-zero integer, reason? }
// Adds (positive) or removes (negative) mailbox allowance. Refused if it
// would drop below mailboxes already in use. Owner/admin. CLAUDE.md §34.

import type { StaffUser } from "../../../../_lib/roles";
import { adjustEntitlement } from "../../../../_lib/emailServices/engine";
import { engineResponse, json, param, readBody, requireEmailAdmin, staffActor, type EmailEnv } from "../../../../_lib/emailServices/http";
import { cleanText } from "../../../../_lib/emailServices/validation";

export const onRequestPost: PagesFunction<EmailEnv, "serviceId", { staffUser: StaffUser }> = async ({ request, env, params, data }) => {
  if (!env.DB) return json(500, { error: "Not configured" });
  const denied = requireEmailAdmin(data.staffUser);
  if (denied) return denied;
  const body = await readBody(request);
  if (!body) return json(400, { error: "Invalid request body" });
  if (body.kind !== "addon" && body.kind !== "override") return json(400, { error: "Kind must be addon or override." });
  if (typeof body.quantity !== "number") return json(400, { error: "Quantity must be a number." });
  return engineResponse(
    await adjustEntitlement(env.DB, { serviceId: param(params.serviceId), kind: body.kind, quantity: body.quantity, reason: cleanText(body.reason, 500), actor: staffActor(data.staffUser) })
  );
};
