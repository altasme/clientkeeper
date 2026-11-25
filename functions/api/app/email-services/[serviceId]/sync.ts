// POST /api/app/email-services/:serviceId/sync
// Asks the provider for its view of this service and compares it to local
// records. Returns discrepancies for a human to act on; it NEVER changes a
// mailbox. With the placeholder provider this honestly reports "provider
// not configured". Owner/admin. CLAUDE.md §34.

import type { StaffUser } from "../../../../_lib/roles";
import { loadService, syncService } from "../../../../_lib/emailServices/engine";
import { engineResponse, json, param, requireEmailAdmin, staffActor, type EmailEnv } from "../../../../_lib/emailServices/http";
import { getEmailProvider } from "../../../../_lib/emailServices/provider";

export const onRequestPost: PagesFunction<EmailEnv, "serviceId", { staffUser: StaffUser }> = async ({ env, params, data }) => {
  if (!env.DB) return json(500, { error: "Not configured" });
  const denied = requireEmailAdmin(data.staffUser);
  if (denied) return denied;
  const service = await loadService(env.DB, param(params.serviceId));
  if (!service) return json(404, { error: "Email service not found." });
  return engineResponse(await syncService(env.DB, getEmailProvider(service.provider), { serviceId: service.id, actor: staffActor(data.staffUser) }));
};
