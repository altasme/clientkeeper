// POST /api/app/email-services/:serviceId/mailboxes/:mailboxId/fulfill
//   { providerMailboxId, providerServiceId?, smtpProfileKey?, createBridgeAccount? (default true), bridgeDisplayName? }
// Records a mailbox that staff created by hand in Z.com's own dashboard
// (there is no Z.com adapter yet): reserved | needs_review | failed ->
// active, with the Z.com ids staff typed in, and (by default) a webmail
// bridge account (mail_accounts row with smtp_profile = smtpProfileKey)
// so the mailbox shows up in /mail. No provider call is made.
// Responses: 200 active; 400 validation; 409 already active / wrong state /
// no slot (for a failed one). Owner/admin. CLAUDE.md §35.
//
// No password is accepted here, ever: the mailbox password is set in
// Z.com's dashboard and the SMTP login goes into the mail worker's
// MAIL_SMTP_PROFILES_JSON secret under smtpProfileKey, outside this app.
// A request that sends one is refused rather than silently ignored, so a
// client bug can't put one on the wire unnoticed.

import type { StaffUser } from "../../../../../../_lib/roles";
import { fulfillMailboxManually } from "../../../../../../_lib/emailServices/engine";
import { engineResponse, json, param, readBody, requireEmailAdmin, staffActor, type EmailEnv } from "../../../../../../_lib/emailServices/http";
import { cleanText } from "../../../../../../_lib/emailServices/validation";

export const onRequestPost: PagesFunction<EmailEnv, "serviceId" | "mailboxId", { staffUser: StaffUser }> = async ({ request, env, params, data }) => {
  if (!env.DB) return json(500, { error: "Not configured" });
  const denied = requireEmailAdmin(data.staffUser);
  if (denied) return denied;
  const body = await readBody(request);
  if (!body) return json(400, { error: "Invalid request body" });
  if ("password" in body) return json(400, { error: "Passwords are never sent to ClientKeeper. Set it in Z.com and in the mail worker's SMTP secret instead." });
  const providerMailboxId = cleanText(body.providerMailboxId, 200);
  if (!providerMailboxId) return json(400, { error: "Enter the Z.com mailbox id." });

  return engineResponse(
    await fulfillMailboxManually(env.DB, {
      serviceId: param(params.serviceId),
      mailboxId: param(params.mailboxId),
      providerMailboxId,
      providerServiceId: cleanText(body.providerServiceId, 200),
      smtpProfileKey: typeof body.smtpProfileKey === "string" ? body.smtpProfileKey : null,
      createBridgeAccount: body.createBridgeAccount !== false,
      bridgeDisplayName: cleanText(body.bridgeDisplayName, 200),
      actor: staffActor(data.staffUser),
    })
  );
};
