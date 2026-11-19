// Cloudflare Pages Function: POST /api/app/mycafe/clients/:id/reactivate
//
// Lifts a suspension. The devices were never unpaired, so the POS and Owner Panel
// work again straight away. Owner/admin only, audited.
import { reactivateMyCafeCafe } from "../../../../../_lib/mycafe";
import { actorName, jsonResponse, mapError, recordAction, resolveCafe, type ClientRouteEnv } from "../../../../../_lib/mycafeClientRoute";
import type { StaffUser } from "../../../../../_lib/roles";

export const onRequestPost: PagesFunction<ClientRouteEnv, "id", { staffUser: StaffUser }> = async ({ env, params, data }) => {
  const id = Array.isArray(params.id) ? params.id[0]! : params.id;
  const resolved = await resolveCafe(env, id, data.staffUser, true);
  if ("error" in resolved) return resolved.error;
  try {
    const result = await reactivateMyCafeCafe(env, resolved.cafeId, actorName(data.staffUser));
    await recordAction(env, data.staffUser, id, "mycafe_reactivated", "Cafe reactivated", {}, null);
    return jsonResponse(200, result);
  } catch (err) {
    return mapError(err);
  }
};
