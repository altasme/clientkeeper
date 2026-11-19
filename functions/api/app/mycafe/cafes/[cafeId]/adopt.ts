// Cloudflare Pages Function: POST /api/app/mycafe/cafes/:cafeId/adopt
//
// A cafe that signed up on its own has no ClientKeeper client record, so it has no
// detail page here. This creates one from the cafe's own record (owner, business,
// store, slug) and links it, so staff can open it like any other. Owner/admin only,
// audited. If a client with the owner's email already exists it is NOT overwritten:
// the 409 carries that client's id so staff can look at it first.
import { getMyCafeCafeDetail } from "../../../../../_lib/mycafe";
import { isMyCafeAdmin, type StaffUser } from "../../../../../_lib/roles";
import { jsonResponse, mapError, type ClientRouteEnv } from "../../../../../_lib/mycafeClientRoute";

export const onRequestPost: PagesFunction<ClientRouteEnv, "cafeId", { staffUser: StaffUser }> = async ({ env, params, data }) => {
  if (!env.DB) return jsonResponse(500, { error: "Not configured" });
  if (!isMyCafeAdmin(data.staffUser)) return jsonResponse(403, { error: "Only owner/admin can add a cafe to ClientKeeper" });
  if (!env.MYCAFE_ADMIN_API_TOKEN || !env.MYCAFE_CONTROL_PLANE_URL) {
    return jsonResponse(500, { error: "MyCafe integration is not configured (MYCAFE_ADMIN_API_TOKEN/MYCAFE_CONTROL_PLANE_URL)" });
  }
  const cafeId = Array.isArray(params.cafeId) ? params.cafeId[0]! : params.cafeId;

  const already = await env.DB.prepare(`SELECT id FROM clients WHERE mycafe_cafe_id = ?`).bind(cafeId).first<{ id: string }>();
  if (already) return jsonResponse(200, { id: already.id, alreadyLinked: true });

  let cafe;
  try {
    cafe = await getMyCafeCafeDetail(env, cafeId);
  } catch (err) {
    return mapError(err);
  }

  const byEmail = await env.DB.prepare(`SELECT id FROM clients WHERE LOWER(email) = LOWER(?)`).bind(cafe.ownerEmail).first<{ id: string }>();
  if (byEmail) {
    return jsonResponse(409, { error: "A client with this owner's email already exists in ClientKeeper.", clientId: byEmail.id });
  }

  const now = new Date().toISOString();
  const clientId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO clients (id, email, full_name, business_name, invitation_status, product, mycafe_cafe_id, mycafe_status, mycafe_slug, mycafe_store_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', 'mycafe_pos', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(clientId, cafe.ownerEmail, cafe.ownerName, cafe.businessName, cafe.id, cafe.status, cafe.slug, cafe.storeName, now, now)
    .run();
  await env.DB.prepare(
    `INSERT INTO client_activity (id, client_id, type, description, actor_id, created_at)
     VALUES (?, ?, 'mycafe_client_adopted', 'Added to ClientKeeper from an existing MyCafe account', ?, ?)`,
  )
    .bind(crypto.randomUUID(), clientId, data.staffUser.id, now)
    .run();
  await env.DB.prepare(
    `INSERT INTO audit_log (id, actor_id, action, entity_type, entity_id, before, after, reason, created_at)
     VALUES (?, ?, 'mycafe_client_adopted', 'client', ?, NULL, ?, NULL, ?)`,
  )
    .bind(crypto.randomUUID(), data.staffUser.id, clientId, JSON.stringify({ cafeId: cafe.id, email: cafe.ownerEmail }), now)
    .run();

  return jsonResponse(201, { id: clientId });
};
