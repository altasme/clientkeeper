// Cloudflare Pages Function: GET /api/app/mycafe/clients/:id/sales?from=&to=
//
// Aggregated sales for this client's cafe (totals, payment split, top products,
// one number per day). Any staff role may read it. Live from MyCafe, never stored
// here; nothing in it identifies a customer, a staff member or an order.
import { getMyCafeSalesSummary } from "../../../../../_lib/mycafe";
import { jsonResponse, mapError, resolveCafe, type ClientRouteEnv } from "../../../../../_lib/mycafeClientRoute";
import type { StaffUser } from "../../../../../_lib/roles";

export const onRequestGet: PagesFunction<ClientRouteEnv, "id", { staffUser: StaffUser }> = async ({ env, params, request, data }) => {
  const id = Array.isArray(params.id) ? params.id[0]! : params.id;
  const resolved = await resolveCafe(env, id, data.staffUser, false);
  if ("error" in resolved) return resolved.error;
  const url = new URL(request.url);
  try {
    return jsonResponse(200, await getMyCafeSalesSummary(env, resolved.cafeId, url.searchParams.get("from") ?? undefined, url.searchParams.get("to") ?? undefined));
  } catch (err) {
    return mapError(err);
  }
};
