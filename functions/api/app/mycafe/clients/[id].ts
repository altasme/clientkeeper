// Cloudflare Pages Function: GET /api/app/mycafe/clients/:id
//
// The MyCafe Client Detail view: the local client record, this app's own
// activity log for it, and — once provisioned (mycafe_cafe_id set) — the
// live plan/branch state fetched from MyCafe's control-plane. A client
// added but not yet provisioned simply has cafe: null; the page's job is to
// show "not provisioned yet" rather than error.
import { getMyCafeCafeDetail, MyCafeApiError, type MyCafeEnv } from "../../../../_lib/mycafe";

interface Env extends MyCafeEnv {
  DB?: D1Database;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export const onRequestGet: PagesFunction<Env, "id"> = async ({ env, params }) => {
  if (!env.DB) return jsonResponse(500, { error: "Not configured" });
  const db = env.DB;
  const clientId = params.id;

  const client = await db
    .prepare(
      `SELECT id, full_name, business_name, email, product, mycafe_slug, mycafe_store_name,
              mycafe_cafe_id, mycafe_status, created_at, updated_at
       FROM clients WHERE id = ?`,
    )
    .bind(clientId)
    .first<{
      id: string;
      full_name: string;
      business_name: string;
      email: string;
      product: string;
      mycafe_slug: string | null;
      mycafe_store_name: string | null;
      mycafe_cafe_id: string | null;
      mycafe_status: string | null;
      created_at: string;
      updated_at: string;
    }>();
  if (!client) return jsonResponse(404, { error: "Client not found" });
  if (client.product !== "mycafe_pos") return jsonResponse(400, { error: "This client isn't a MyCafe client" });

  const activityResult = await db
    .prepare(
      `SELECT id, type, description, actor_id, created_at FROM client_activity
       WHERE client_id = ? ORDER BY created_at DESC LIMIT 100`,
    )
    .bind(clientId)
    .all<{ id: string; type: string; description: string; actor_id: string | null; created_at: string }>();

  let cafe = null;
  let cafeError: string | null = null;
  if (client.mycafe_cafe_id && env.MYCAFE_ADMIN_API_TOKEN && env.MYCAFE_CONTROL_PLANE_URL) {
    try {
      cafe = await getMyCafeCafeDetail(env, client.mycafe_cafe_id);
    } catch (err) {
      // A provisioned client whose cafe detail can't be fetched right now
      // (MyCafe unreachable, or the id is somehow stale) shouldn't break
      // this whole page -- everything else here is this app's own data.
      cafeError = err instanceof MyCafeApiError ? err.message : "Could not reach MyCafe";
    }
  }

  return jsonResponse(200, {
    client: {
      id: client.id,
      fullName: client.full_name,
      businessName: client.business_name,
      email: client.email,
      mycafeSlug: client.mycafe_slug,
      mycafeStoreName: client.mycafe_store_name,
      mycafeCafeId: client.mycafe_cafe_id,
      mycafeStatus: client.mycafe_status,
      createdAt: client.created_at,
      updatedAt: client.updated_at,
    },
    cafe,
    cafeError,
    activity: activityResult.results,
  });
};
