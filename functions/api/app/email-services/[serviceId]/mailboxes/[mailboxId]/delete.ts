// POST /api/app/email-services/:serviceId/mailboxes/:mailboxId/delete
//   { reason }
// Asks the provider to delete the mailbox. The slot is released only once
// the provider confirms. Owner/admin, reason required. CLAUDE.md §34.

import type { StaffUser } from "../../../../../../_lib/roles";
import { deleteMailbox, loadService } from "../../../../../../_lib/emailServices/engine";
import { json, param, readBody, requireEmailAdmin, staffActor, type EmailEnv } from "../../../../../../_lib/emailServices/http";
import { getEmailProvider } from "../../../../../../_lib/emailServices/provider";
import { providerFailureStatus } from "../../../../../../_lib/emailServices/responses";
import { cleanText } from "../../../../../../_lib/emailServices/validation";

export const onRequestPost: PagesFunction<EmailEnv, "serviceId" | "mailboxId", { staffUser: StaffUser }> = async ({ request, env, params, data }) => {
  if (!env.DB) return json(500, { error: "Not configured" });
  const denied = requireEmailAdmin(data.staffUser);
  if (denied) return denied;
  const body = await readBody(request);
  const reason = cleanText(body?.reason, 500);
  if (!reason) return json(400, { error: "A reason is required to delete a mailbox." });
  const service = await loadService(env.DB, param(params.serviceId));
  if (!service) return json(404, { error: "Email service not found." });
  const result = await deleteMailbox(env.DB, getEmailProvider(service.provider), { serviceId: service.id, mailboxId: param(params.mailboxId), reason, actor: staffActor(data.staffUser) });
  if (!result.ok) return json(result.status, { error: result.error, code: result.code });
  const { mailbox, providerError } = result.value;
  if (!providerError) return json(200, { mailbox });
  return json(providerFailureStatus(providerError), { error: providerError.message, code: providerError.code, mailbox });
};
