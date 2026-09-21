// Cloudflare Pages Function: POST /api/app/mycafe/clients/:id/new-device
//
// Mints an additional/replacement device activation token for a client
// whose cafe is already provisioned — for a lost token, a second device, or
// just because the client asked. Same one-time-return rule as provision.ts:
// the token is in the response body once and never stored here.
import { mintMyCafeDevice, MyCafeApiError, type MyCafeEnv } from "../../../../../_lib/mycafe";
import type { StaffUser } from "../../../../../_lib/roles";

interface Env extends MyCafeEnv {
  DB?: D1Database;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export const onRequestPost: PagesFunction<Env, "id", { staffUser: StaffUser }> = async ({ env, params, data }) => {
  if (!env.DB) return jsonResponse(500, { error: "Not configured" });
  if (!env.MYCAFE_ADMIN_API_TOKEN || !env.MYCAFE_CONTROL_PLANE_URL) {
    return jsonResponse(500, { error: "MyCafe integration is not configured (MYCAFE_ADMIN_API_TOKEN/MYCAFE_CONTROL_PLANE_URL)" });
  }
  const db = env.DB;
  const clientId = params.id;

  const client = await db
    .prepare(`SELECT id, product, mycafe_cafe_id FROM clients WHERE id = ?`)
    .bind(clientId)
    .first<{ id: string; product: string; mycafe_cafe_id: string | null }>();
  if (!client) return jsonResponse(404, { error: "Client not found" });
  if (client.product !== "mycafe_pos") return jsonResponse(400, { error: "This client isn't a MyCafe client" });
  if (!client.mycafe_cafe_id) return jsonResponse(409, { error: "This client hasn't been provisioned yet" });

  let deviceActivationToken: string;
  try {
    deviceActivationToken = await mintMyCafeDevice(env, client.mycafe_cafe_id);
  } catch (err) {
    if (err instanceof MyCafeApiError) return jsonResponse(err.status >= 400 && err.status < 600 ? err.status : 502, { error: err.message });
    return jsonResponse(502, { error: "Could not reach MyCafe" });
  }

  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO client_activity (id, client_id, type, description, actor_id, created_at)
       VALUES (?, ?, 'mycafe_new_device', 'A new MyCafe device token was issued', ?, ?)`,
    )
    .bind(crypto.randomUUID(), clientId, data.staffUser.id, now)
    .run();

  return jsonResponse(200, { deviceActivationToken });
};
