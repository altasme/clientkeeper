// Cloudflare Pages Function: POST /api/app/mycafe/clients/:id/extend-trial   { days, reason? }
//
// Adds 1-60 days to a running or lapsed trial (MyCafe refuses a cafe already on a paid
// plan). Owner/admin only, audited here and in MyCafe's own action ledger.
import { extendMyCafeTrial } from "../../../../../_lib/mycafe";
import { actorName, jsonResponse, mapError, readJsonBody, recordAction, resolveCafe, type ClientRouteEnv } from "../../../../../_lib/mycafeClientRoute";
import type { StaffUser } from "../../../../../_lib/roles";

export const onRequestPost: PagesFunction<ClientRouteEnv, "id", { staffUser: StaffUser }> = async ({ env, params, request, data }) => {
  const id = Array.isArray(params.id) ? params.id[0]! : params.id;
  const resolved = await resolveCafe(env, id, data.staffUser, true);
  if ("error" in resolved) return resolved.error;
  const body = await readJsonBody(request);
  const days = body?.days;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 60) {
    return jsonResponse(400, { error: "days must be a whole number from 1 to 60" });
  }
  const reason = typeof body?.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 300) : null;
  try {
    const result = await extendMyCafeTrial(env, resolved.cafeId, days, reason, actorName(data.staffUser));
    await recordAction(env, data.staffUser, id, "mycafe_trial_extended", `Trial extended by ${days} day${days === 1 ? "" : "s"}`, { days, trialEndsAt: result.trialEndsAt }, reason);
    return jsonResponse(200, result);
  } catch (err) {
    return mapError(err);
  }
};
