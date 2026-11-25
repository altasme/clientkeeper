// POST /api/app/email-services/:serviceId/mailboxes/:mailboxId/retry
//   { password }
// Retries a FAILED mailbox in place (capacity re-checked atomically). The
// password must be supplied again: it was never stored. Only 'failed'
// mailboxes are retryable; an outcome-unknown ('needs_review') one is
// resolved explicitly instead, never blindly retried. Owner/admin.

import type { StaffUser } from "../../../../../../_lib/roles";
import { loadService, retryMailbox } from "../../../../../../_lib/emailServices/engine";
import { json, param, readBody, requireEmailAdmin, staffActor, type EmailEnv } from "../../../../../../_lib/emailServices/http";
import { getEmailProvider } from "../../../../../../_lib/emailServices/provider";
import { provisionResponse } from "../../../../../../_lib/emailServices/responses";
import { validateMailboxPassword } from "../../../../../../_lib/emailServices/validation";

export const onRequestPost: PagesFunction<EmailEnv, "serviceId" | "mailboxId", { staffUser: StaffUser }> = async ({ request, env, params, data }) => {
  if (!env.DB) return json(500, { error: "Not configured" });
  const denied = requireEmailAdmin(data.staffUser);
  if (denied) return denied;
  const body = await readBody(request);
  const password = validateMailboxPassword(body?.password);
  if (!password.ok) return json(400, { error: password.error });
  const service = await loadService(env.DB, param(params.serviceId));
  if (!service) return json(404, { error: "Email service not found." });
  return provisionResponse(
    await retryMailbox(env.DB, getEmailProvider(service.provider), { serviceId: service.id, mailboxId: param(params.mailboxId), password: password.password, actor: staffActor(data.staffUser) })
  );
};
