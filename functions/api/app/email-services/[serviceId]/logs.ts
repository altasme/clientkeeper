// GET /api/app/email-services/:serviceId/logs -- audit trail + provider
// operation log for one service (any staff role). CLAUDE.md §34.

import { loadService } from "../../../../_lib/emailServices/engine";
import { getServiceLogs } from "../../../../_lib/emailServices/services";
import { json, param, type EmailEnv } from "../../../../_lib/emailServices/http";

export const onRequestGet: PagesFunction<EmailEnv, "serviceId"> = async ({ env, params }) => {
  if (!env.DB) return json(500, { error: "Not configured" });
  const serviceId = param(params.serviceId);
  if (!(await loadService(env.DB, serviceId))) return json(404, { error: "Email service not found." });
  return json(200, await getServiceLogs(env.DB, serviceId));
};
