// POST /api/app/email-services/:serviceId/lifecycle
//   { action: activate | suspend | reactivate | renew | decommission,
//     reason?, expiresAt? }
// Transition rules live in _lib/emailServices/policy.ts. Suspend and
// decommission require a reason; decommission requires every mailbox to be
// deleted or resolved first (mailbox data is never deleted implicitly).
// Owner/admin. CLAUDE.md §34.

import type { StaffUser } from "../../../../_lib/roles";
import { transitionService } from "../../../../_lib/emailServices/engine";
import { engineResponse, json, param, readBody, requireEmailAdmin, staffActor, type EmailEnv } from "../../../../_lib/emailServices/http";
import type { LifecycleAction } from "../../../../_lib/emailServices/policy";
import { cleanText, normalizeDateInput } from "../../../../_lib/emailServices/validation";

const ACTIONS: LifecycleAction[] = ["activate", "suspend", "reactivate", "renew", "decommission"];

export const onRequestPost: PagesFunction<EmailEnv, "serviceId", { staffUser: StaffUser }> = async ({ request, env, params, data }) => {
  if (!env.DB) return json(500, { error: "Not configured" });
  const denied = requireEmailAdmin(data.staffUser);
  if (denied) return denied;
  const body = await readBody(request);
  if (!body || !ACTIONS.includes(body.action as LifecycleAction)) return json(400, { error: "Unknown action." });
  let expiresAt: string | null = null;
  if (body.expiresAt) {
    expiresAt = normalizeDateInput(body.expiresAt);
    if (!expiresAt) return json(400, { error: "Invalid expiration date." });
  }
  return engineResponse(
    await transitionService(env.DB, {
      serviceId: param(params.serviceId),
      action: body.action as LifecycleAction,
      reason: cleanText(body.reason, 500),
      expiresAt,
      actor: staffActor(data.staffUser),
    })
  );
};
