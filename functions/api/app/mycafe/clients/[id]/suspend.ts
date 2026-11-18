// Cloudflare Pages Function: POST /api/app/mycafe/clients/:id/suspend   { reason }
//
// Puts this client's cafe on hold: its POS and Owner Panel stop at once and show an
// "account suspended" screen. Nothing is deleted and the devices stay paired, so
// reactivating restores service immediately. Owner/admin only, reason required,
// audited here and in MyCafe's own action ledger.
import { suspendMyCafeCafe } from "../../../../../_lib/mycafe";
import { actorName, jsonResponse, mapError, readJsonBody, recordAction, resolveCafe, type ClientRouteEnv } from "../../../../../_lib/mycafeClientRoute";
import type { StaffUser } from "../../../../../_lib/roles";

export const onRequestPost: PagesFunction<ClientRouteEnv, "id", { staffUser: StaffUser }> = async ({ env, params, request, data }) => {
  const id = Array.isArray(params.id) ? params.id[0]! : params.id;
  const resolved = await resolveCafe(env, id, data.staffUser, true);
  if ("error" in resolved) return resolved.error;
  const body = await readJsonBody(request);
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (!reason) return jsonResponse(400, { error: "A reason is required to suspend a cafe" });
  if (reason.length > 300) return jsonResponse(400, { error: "The reason must be 300 characters or fewer" });
  try {
    const result = await suspendMyCafeCafe(env, resolved.cafeId, reason, actorName(data.staffUser));
    await recordAction(env, data.staffUser, id, "mycafe_suspended", `Cafe suspended: ${reason}`, { reason }, reason);
    return jsonResponse(200, result);
  } catch (err) {
    return mapError(err);
  }
};
