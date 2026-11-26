// POST /api/app/email-services/:serviceId/mailboxes/:mailboxId/decline
//   { reason }
// Turns down a client's pending mailbox request (status 'reserved',
// created by the client) -> discarded, freeing its slot and its address.
// Owner/admin, reason required. CLAUDE.md §35.

import type { StaffUser } from "../../../../../../_lib/roles";
import { declineMailboxRequest } from "../../../../../../_lib/emailServices/engine";
import { engineResponse, json, param, readBody, requireEmailAdmin, staffActor, type EmailEnv } from "../../../../../../_lib/emailServices/http";
import { cleanText } from "../../../../../../_lib/emailServices/validation";

export const onRequestPost: PagesFunction<EmailEnv, "serviceId" | "mailboxId", { staffUser: StaffUser }> = async ({ request, env, params, data }) => {
  if (!env.DB) return json(500, { error: "Not configured" });
  const denied = requireEmailAdmin(data.staffUser);
  if (denied) return denied;
  const body = await readBody(request);
  const reason = cleanText(body?.reason, 500);
  if (!reason) return json(400, { error: "A reason is required to decline a request." });
  return engineResponse(
    await declineMailboxRequest(env.DB, { serviceId: param(params.serviceId), mailboxId: param(params.mailboxId), reason, actor: staffActor(data.staffUser) })
  );
};
