// Cloudflare Pages Function: GET /api/app/mycafe/dashboard
//
// Every number here comes from a real source: business/device counts from
// MyCafe's control-plane (the actual source of truth — it also has cafes
// from the public self-serve signup flow that never touch this app's own
// `clients` table, so counting only local rows would undercount), and
// recent activity from this app's own client_activity table, scoped to
// MyCafe clients. No placeholder/mock figures.
import { listMyCafeCafes, MyCafeApiError, type MyCafeEnv } from "../../../_lib/mycafe";

interface Env extends MyCafeEnv {
  DB?: D1Database;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  if (!env.DB) return jsonResponse(500, { error: "Not configured" });
  if (!env.MYCAFE_ADMIN_API_TOKEN || !env.MYCAFE_CONTROL_PLANE_URL) {
    return jsonResponse(500, { error: "MyCafe integration is not configured (MYCAFE_ADMIN_API_TOKEN/MYCAFE_CONTROL_PLANE_URL)" });
  }

  let cafes;
  try {
    cafes = await listMyCafeCafes(env);
  } catch (err) {
    if (err instanceof MyCafeApiError) return jsonResponse(err.status >= 400 && err.status < 600 ? err.status : 502, { error: err.message });
    return jsonResponse(502, { error: "Could not reach MyCafe" });
  }

  let provisioning = 0;
  let trial = 0;
  let activePaid = 0;
  let expired = 0;
  let totalDevices = 0;
  let activeDevices = 0;

  for (const cafe of cafes) {
    totalDevices += cafe.deviceCount;
    activeDevices += cafe.activeDeviceCount;
    if (cafe.status !== "active") {
      provisioning += 1;
      continue;
    }
    switch (cafe.entitlement?.state) {
      case "trial":
        trial += 1;
        break;
      case "trial_expired":
        expired += 1;
        break;
      case undefined:
        break;
      default:
        activePaid += 1;
    }
  }

  const recentActivity = await env.DB.prepare(
    `SELECT ca.id, ca.client_id, ca.type, ca.description, ca.created_at, c.business_name
     FROM client_activity ca
     JOIN clients c ON c.id = ca.client_id
     WHERE c.product = 'mycafe_pos'
     ORDER BY ca.created_at DESC LIMIT 20`,
  ).all<{
    id: string;
    client_id: string;
    type: string;
    description: string;
    created_at: string;
    business_name: string;
  }>();

  return jsonResponse(200, {
    counts: {
      totalBusinesses: cafes.length,
      activeBusinesses: activePaid,
      trialBusinesses: trial,
      expiredBusinesses: expired,
      provisioningBusinesses: provisioning,
      registeredDevices: totalDevices,
      activeDevices,
    },
    recentActivity: recentActivity.results.map((row) => ({
      id: row.id,
      clientId: row.client_id,
      businessName: row.business_name,
      type: row.type,
      description: row.description,
      createdAt: row.created_at,
    })),
  });
};
