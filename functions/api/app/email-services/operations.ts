// GET /api/app/email-services/operations -- failed / outcome-unknown
// provider operations across all services (any staff role). CLAUDE.md §34.

import { listFailedOperations } from "../../../_lib/emailServices/services";
import { json, type EmailEnv } from "../../../_lib/emailServices/http";

export const onRequestGet: PagesFunction<EmailEnv> = async ({ request, env }) => {
  if (!env.DB) return json(500, { error: "Not configured" });
  const limit = Number(new URL(request.url).searchParams.get("limit") ?? 100);
  return json(200, { operations: await listFailedOperations(env.DB, Number.isFinite(limit) ? limit : 100) });
};
