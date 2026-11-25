// POST /api/app/email-services/:serviceId/mailboxes/:mailboxId/discard
// Hides a FAILED attempt (kept for history as 'discarded'). Owner/admin.

import type { StaffUser } from "../../../../../../_lib/roles";
import { discardMailbox } from "../../../../../../_lib/emailServices/engine";
import { engineResponse, json, param, requireEmailAdmin, staffActor, type EmailEnv } from "../../../../../../_lib/emailServices/http";

export const onRequestPost: PagesFunction<EmailEnv, "serviceId" | "mailboxId", { staffUser: StaffUser }> = async ({ env, params, data }) => {
  if (!env.DB) return json(500, { error: "Not configured" });
  const denied = requireEmailAdmin(data.staffUser);
  if (denied) return denied;
  return engineResponse(await discardMailbox(env.DB, { serviceId: param(params.serviceId), mailboxId: param(params.mailboxId), actor: staffActor(data.staffUser) }));
};
