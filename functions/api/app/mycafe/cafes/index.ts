// Cloudflare Pages Function: GET /api/app/mycafe/cafes?days=7|30|90
//
// EVERY café on MyCafe POS with its sales for the period, straight from MyCafe's
// control plane -- including cafés that signed up on their own and were never added
// here as a ClientKeeper client (the older /api/app/mycafe/clients list only knows
// the clients created here). Each row says which ClientKeeper client it is, if any.
// Live, nothing stored; sales are aggregates only. Any staff role may read.
import { getMyCafeSalesOverview, listMyCafeCafes } from "../../../../_lib/mycafe";
import { jsonResponse, mapError, type ClientRouteEnv } from "../../../../_lib/mycafeClientRoute";
import type { StaffUser } from "../../../../_lib/roles";

const DAY_MS = 86_400_000;

export const onRequestGet: PagesFunction<ClientRouteEnv, string, { staffUser: StaffUser }> = async ({ env, request }) => {
  if (!env.DB) return jsonResponse(500, { error: "Not configured" });
  if (!env.MYCAFE_ADMIN_API_TOKEN || !env.MYCAFE_CONTROL_PLANE_URL) {
    return jsonResponse(500, { error: "MyCafe integration is not configured (MYCAFE_ADMIN_API_TOKEN/MYCAFE_CONTROL_PLANE_URL)" });
  }
  const requested = Number(new URL(request.url).searchParams.get("days"));
  const days = [7, 30, 90].includes(requested) ? requested : 30;
  // Manila days, like the cafes' own reports.
  const to = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  const from = new Date(Date.parse(`${to}T00:00:00Z`) - (days - 1) * DAY_MS).toISOString().slice(0, 10);

  try {
    const [cafes, overview, linked] = await Promise.all([
      listMyCafeCafes(env),
      getMyCafeSalesOverview(env, from, to),
      env.DB.prepare(`SELECT id, mycafe_cafe_id FROM clients WHERE product = 'mycafe_pos' AND mycafe_cafe_id IS NOT NULL`).all<{
        id: string;
        mycafe_cafe_id: string;
      }>(),
    ]);
    const salesBy = new Map(overview.cafes.map((c) => [c.cafeId, c]));
    const clientBy = new Map(linked.results.map((r) => [r.mycafe_cafe_id, r.id]));
    return jsonResponse(200, {
      from,
      to,
      days,
      totalNetCentavos: overview.totalNetCentavos,
      totalOrders: overview.totalOrders,
      cafes: cafes.map((c) => {
        const sales = salesBy.get(c.id);
        return {
          cafeId: c.id,
          clientId: clientBy.get(c.id) ?? null,
          businessName: c.businessName,
          storeName: c.storeName,
          ownerName: c.ownerName,
          ownerEmail: c.ownerEmail,
          status: c.status,
          entitlementState: c.entitlement?.state ?? null,
          tier: c.entitlement?.tier ?? null,
          trialEndsAt: c.entitlement?.trialEndsAt ?? null,
          daysRemaining: c.entitlement?.daysRemaining ?? null,
          deviceCount: c.deviceCount,
          activeDeviceCount: c.activeDeviceCount,
          createdAt: c.createdAt,
          netCentavos: sales?.netCentavos ?? 0,
          orderCount: sales?.orderCount ?? 0,
          lastOrderAt: sales?.lastOrderAt ?? null,
        };
      }),
    });
  } catch (err) {
    return mapError(err);
  }
};
