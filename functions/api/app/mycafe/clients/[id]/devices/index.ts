// Cloudflare Pages Function: GET /api/app/mycafe/clients/:id/devices
//
// Every device this client's cafe has ever registered, proxied straight
// from MyCafe's control-plane (shared/src's own devices table) — nothing
// about devices is stored in this app.
import { listMyCafeDevices, MyCafeApiError, type MyCafeEnv } from "../../../../../../_lib/mycafe";

interface Env extends MyCafeEnv {
  DB?: D1Database;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export const onRequestGet: PagesFunction<Env, "id"> = async ({ env, params }) => {
  if (!env.DB) return jsonResponse(500, { error: "Not configured" });
  if (!env.MYCAFE_ADMIN_API_TOKEN || !env.MYCAFE_CONTROL_PLANE_URL) {
    return jsonResponse(500, { error: "MyCafe integration is not configured (MYCAFE_ADMIN_API_TOKEN/MYCAFE_CONTROL_PLANE_URL)" });
  }
  const clientId = params.id;

  const client = await env.DB.prepare(`SELECT id, product, mycafe_cafe_id FROM clients WHERE id = ?`)
    .bind(clientId)
    .first<{ id: string; product: string; mycafe_cafe_id: string | null }>();
  if (!client) return jsonResponse(404, { error: "Client not found" });
  if (client.product !== "mycafe_pos") return jsonResponse(400, { error: "This client isn't a MyCafe client" });
  if (!client.mycafe_cafe_id) return jsonResponse(200, []);

  try {
    const devices = await listMyCafeDevices(env, client.mycafe_cafe_id);
    return jsonResponse(200, devices);
  } catch (err) {
    if (err instanceof MyCafeApiError) return jsonResponse(err.status >= 400 && err.status < 600 ? err.status : 502, { error: err.message });
    return jsonResponse(502, { error: "Could not reach MyCafe" });
  }
};
