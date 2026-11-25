// POST /api/app/email-services/:serviceId/mailboxes/:mailboxId/resolve
//   { resolution: 'exists' | 'absent', providerMailboxId?, reason }
// Explicit human resolution of a needs_review (outcome unknown) mailbox,
// after checking the provider. Never done automatically. Owner/admin.

import type { StaffUser } from "../../../../../../_lib/roles";
import { resolveMailbox } from "../../../../../../_lib/emailServices/engine";
import { engineResponse, json, param, readBody, requireEmailAdmin, staffActor, type EmailEnv } from "../../../../../../_lib/emailServices/http";
import { cleanText } from "../../../../../../_lib/emailServices/validation";

export const onRequestPost: PagesFunction<EmailEnv, "serviceId" | "mailboxId", { staffUser: StaffUser }> = async ({ request, env, params, data }) => {
  if (!env.DB) return json(500, { error: "Not configured" });
  const denied = requireEmailAdmin(data.staffUser);
  if (denied) return denied;
  const body = await readBody(request);
  if (!body || (body.resolution !== "exists" && body.resolution !== "absent")) return json(400, { error: "Resolution must be exists or absent." });
  const reason = cleanText(body.reason, 500);
  if (!reason) return json(400, { error: "A reason is required." });
  return engineResponse(
    await resolveMailbox(env.DB, {
      serviceId: param(params.serviceId),
      mailboxId: param(params.mailboxId),
      resolution: body.resolution,
      providerMailboxId: cleanText(body.providerMailboxId, 200),
      reason,
      actor: staffActor(data.staffUser),
    })
  );
};
