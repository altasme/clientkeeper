// Cloudflare Pages Function: GET /api/app/mycafe/clients/:id/usage
//
// Usage signals and billing history for this client's cafe, live from MyCafe: last
// order, orders in the last 7/30 days, last device use, billing events, and the
// account actions (suspend / reactivate / trial extensions) taken from here.
import { getMyCafeActivity } from "../../../../../_lib/mycafe";
import { jsonResponse, mapError, resolveCafe, type ClientRouteEnv } from "../../../../../_lib/mycafeClientRoute";
import type { StaffUser } from "../../../../../_lib/roles";

export const onRequestGet: PagesFunction<ClientRouteEnv, "id", { staffUser: StaffUser }> = async ({ env, params, data }) => {
  const id = Array.isArray(params.id) ? params.id[0]! : params.id;
  const resolved = await resolveCafe(env, id, data.staffUser, false);
  if ("error" in resolved) return resolved.error;
  try {
    return jsonResponse(200, await getMyCafeActivity(env, resolved.cafeId));
  } catch (err) {
    return mapError(err);
  }
};
