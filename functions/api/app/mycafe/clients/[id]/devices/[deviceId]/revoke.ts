// Cloudflare Pages Function: POST /api/app/mycafe/clients/:id/devices/:deviceId/revoke
//
// Deactivates one of this client's cafe's devices without minting a
// replacement (support action: lost/stolen device, or the client asked).
// Owner/admin only, same reasoning as provision.ts/new-device.ts — this
// turns off a live POS terminal, not something a junior role should do
// unattended.
import { revokeMyCafeDevice, MyCafeApiError, type MyCafeEnv } from "../../../../../../../_lib/mycafe";
import { isMyCafeAdmin, type StaffUser } from "../../../../../../../_lib/roles";

interface Env extends MyCafeEnv {
  DB?: D1Database;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export const onRequestPost: PagesFunction<Env, "id" | "deviceId", { staffUser: StaffUser }> = async ({
  env,
  params,
  data,
}) => {
  if (!env.DB) return jsonResponse(500, { error: "Not configured" });
  if (!isMyCafeAdmin(data.staffUser)) {
    return jsonResponse(403, { error: "Only owner/admin can revoke a MyCafe device" });
  }
  if (!env.MYCAFE_ADMIN_API_TOKEN || !env.MYCAFE_CONTROL_PLANE_URL) {
    return jsonResponse(500, { error: "MyCafe integration is not configured (MYCAFE_ADMIN_API_TOKEN/MYCAFE_CONTROL_PLANE_URL)" });
  }
  // Neither segment is a catch-all ([[param]]), so each only ever resolves
  // to one string in practice -- normalized because the workers-types
  // signature for multi-segment routes still declares string | string[].
  const clientId = Array.isArray(params.id) ? params.id[0]! : params.id;
  const deviceId = Array.isArray(params.deviceId) ? params.deviceId[0]! : params.deviceId;

  const client = await env.DB.prepare(`SELECT id, product, mycafe_cafe_id FROM clients WHERE id = ?`)
    .bind(clientId)
    .first<{ id: string; product: string; mycafe_cafe_id: string | null }>();
  if (!client) return jsonResponse(404, { error: "Client not found" });
  if (client.product !== "mycafe_pos") return jsonResponse(400, { error: "This client isn't a MyCafe client" });
  if (!client.mycafe_cafe_id) return jsonResponse(409, { error: "This client hasn't been provisioned yet" });

  try {
    await revokeMyCafeDevice(env, client.mycafe_cafe_id, deviceId);
  } catch (err) {
    if (err instanceof MyCafeApiError) return jsonResponse(err.status >= 400 && err.status < 600 ? err.status : 502, { error: err.message });
    return jsonResponse(502, { error: "Could not reach MyCafe" });
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO client_activity (id, client_id, type, description, actor_id, created_at)
     VALUES (?, ?, 'mycafe_device_revoked', 'A MyCafe device was revoked', ?, ?)`,
  )
    .bind(crypto.randomUUID(), clientId, data.staffUser.id, now)
    .run();

  await env.DB.prepare(
    `INSERT INTO audit_log (id, actor_id, action, entity_type, entity_id, before, after, reason, created_at)
     VALUES (?, ?, 'mycafe_device_revoked', 'client', ?, NULL, ?, NULL, ?)`,
  )
    .bind(crypto.randomUUID(), data.staffUser.id, clientId, JSON.stringify({ deviceId }), now)
    .run();

  return jsonResponse(200, { ok: true });
};
