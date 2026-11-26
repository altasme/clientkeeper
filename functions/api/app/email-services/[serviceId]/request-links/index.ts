// GET  /api/app/email-services/:serviceId/request-links   every link for
//      the service, newest first (any staff role).
// POST /api/app/email-services/:serviceId/request-links   {} -> 201
//      { link: { id, status, url, ... } }. The url is the full shareable
//      www.altasme.com/mailbox-request/:slug?t=... link for staff to send
//      by hand. 409 if the service has no plan, no domain, or isn't in a
//      state that accepts new mailboxes. Owner/admin. CLAUDE.md §36.

import type { StaffUser } from "../../../../../_lib/roles";
import { createRequestLink, listRequestLinks } from "../../../../../_lib/emailServices/requestLinks";
import { engineResponse, json, param, requireEmailAdmin, staffActor, type EmailEnv } from "../../../../../_lib/emailServices/http";

export const onRequestGet: PagesFunction<EmailEnv, "serviceId"> = async ({ env, params }) => {
  if (!env.DB) return json(500, { error: "Not configured" });
  return json(200, { links: await listRequestLinks(env.DB, param(params.serviceId)) });
};

export const onRequestPost: PagesFunction<EmailEnv, "serviceId", { staffUser: StaffUser }> = async ({ env, params, data }) => {
  if (!env.DB) return json(500, { error: "Not configured" });
  const denied = requireEmailAdmin(data.staffUser);
  if (denied) return denied;
  return engineResponse(await createRequestLink(env.DB, { serviceId: param(params.serviceId), actor: staffActor(data.staffUser) }), 201);
};
