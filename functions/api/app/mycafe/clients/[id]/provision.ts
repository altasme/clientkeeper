// Cloudflare Pages Function: POST /api/app/mycafe/clients/:id/provision
//
// Creates (or, if mycafe_cafe_id is already on file, resumes) this client's
// MyCafe cafe via control-plane's admin API (functions/_lib/mycafe.ts). On
// success, records the returned cafeId/status and returns the one-time
// deviceActivationToken in the response body — never stored here, same as
// MyCafe's own rule for it (the plaintext token only ever exists in transit,
// once). Staff must copy it from this response; there's no way to recover
// it afterward short of minting a fresh one (new-device.ts).
import { provisionMyCafeCafe, MyCafeApiError, type MyCafeEnv } from "../../../../../_lib/mycafe";
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
    .prepare(
      `SELECT id, full_name, business_name, email, product, mycafe_cafe_id, mycafe_slug, mycafe_store_name
       FROM clients WHERE id = ?`,
    )
    .bind(clientId)
    .first<{
      id: string;
      full_name: string;
      business_name: string;
      email: string;
      product: string;
      mycafe_cafe_id: string | null;
      mycafe_slug: string | null;
      mycafe_store_name: string | null;
    }>();
  if (!client) return jsonResponse(404, { error: "Client not found" });
  if (client.product !== "mycafe_pos") return jsonResponse(400, { error: "This client isn't a MyCafe client" });
  if (!client.mycafe_slug || !client.mycafe_store_name) {
    return jsonResponse(400, { error: "This client is missing a slug or store name" });
  }

  let result;
  try {
    result = await provisionMyCafeCafe(env, {
      mycafeCafeId: client.mycafe_cafe_id,
      slug: client.mycafe_slug,
      businessName: client.business_name,
      storeName: client.mycafe_store_name,
      ownerEmail: client.email,
      ownerName: client.full_name,
    });
  } catch (err) {
    if (err instanceof MyCafeApiError) return jsonResponse(err.status >= 400 && err.status < 600 ? err.status : 502, { error: err.message });
    return jsonResponse(502, { error: "Could not reach MyCafe" });
  }

  const now = new Date().toISOString();
  await db
    .prepare(`UPDATE clients SET mycafe_cafe_id = ?, mycafe_status = ?, updated_at = ? WHERE id = ?`)
    .bind(result.cafeId, result.status, now, clientId)
    .run();

  await db
    .prepare(
      `INSERT INTO client_activity (id, client_id, type, description, actor_id, created_at)
       VALUES (?, ?, 'mycafe_provision', ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      clientId,
      result.status === "active"
        ? "MyCafe cafe provisioned and active"
        : `MyCafe provisioning did not finish: ${result.error ?? "unknown error"}`,
      data.staffUser.id,
      now,
    )
    .run();

  await db
    .prepare(
      `INSERT INTO audit_log (id, actor_id, action, entity_type, entity_id, before, after, reason, created_at)
       VALUES (?, ?, 'mycafe_provision', 'client', ?, NULL, ?, NULL, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      data.staffUser.id,
      clientId,
      JSON.stringify({ cafeId: result.cafeId, status: result.status, error: result.error }),
      now,
    )
    .run();

  // A 202/"provisioning" response from MyCafe is not a success this route
  // should mask — result.error is MyCafe's own explanation of what step
  // failed, and it's the only place staff can see it, since this UI has no
  // other window into MyCafe's provisioning_steps ledger.
  return jsonResponse(200, {
    cafeId: result.cafeId,
    status: result.status,
    deviceActivationToken: result.deviceActivationToken,
    error: result.status === "active" ? undefined : (result.error ?? "MyCafe did not report a reason"),
  });
};
