// POST   /api/app/mail-integrations/:id/mailboxes   { address }        attach a mailbox (owner/admin)
// DELETE /api/app/mail-integrations/:id/mailboxes   { mailAccountId }  detach it (owner/admin)
// Mailboxes staff explicitly let this integration grant, on top of its
// own client's hosted mailboxes. See functions/_lib/mailConnect/integrations.ts.

import type { StaffUser } from "../../../../_lib/roles";
import { json, param, readBody, requireEmailAdmin, type EmailEnv } from "../../../../_lib/emailServices/http";
import { attachMailbox, detachMailbox } from "../../../../_lib/mailConnect/integrations";

export const onRequestPost: PagesFunction<EmailEnv, "id", { staffUser: StaffUser }> = async ({ env, params, request, data }) => {
  if (!env.DB) return json(500, { error: "Not configured" });
  const denied = requireEmailAdmin(data.staffUser);
  if (denied) return denied;
  const body = (await readBody(request)) ?? {};
  const r = await attachMailbox(env.DB, { id: param(params.id), address: body.address, staffId: data.staffUser.id });
  return r.ok ? json(201, r.value) : json(r.status, { error: r.error });
};

export const onRequestDelete: PagesFunction<EmailEnv, "id", { staffUser: StaffUser }> = async ({ env, params, request, data }) => {
  if (!env.DB) return json(500, { error: "Not configured" });
  const denied = requireEmailAdmin(data.staffUser);
  if (denied) return denied;
  const body = (await readBody(request)) ?? {};
  const r = await detachMailbox(env.DB, { id: param(params.id), mailAccountId: body.mailAccountId, staffId: data.staffUser.id });
  return r.ok ? json(200, r.value) : json(r.status, { error: r.error });
};
