// Shared by the per-café routes under /api/app/mycafe/clients/:id/ (sales, activity,
// suspend, reactivate, extend-trial): resolve the ClientKeeper client to its MyCafe
// café id, gate by role, map errors, and write the audit + activity rows.
import { MyCafeApiError, type MyCafeEnv } from "./mycafe";
import { isMyCafeAdmin, type StaffUser } from "./roles";

export interface ClientRouteEnv extends MyCafeEnv {
  DB?: D1Database;
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function mapError(err: unknown): Response {
  if (err instanceof MyCafeApiError) {
    return jsonResponse(err.status >= 400 && err.status < 600 ? err.status : 502, { error: err.message });
  }
  return jsonResponse(502, { error: "Could not reach MyCafe" });
}

export function actorName(staffUser: StaffUser): string {
  return staffUser.full_name || staffUser.email;
}

// Returns the café id, or an error Response. `adminOnly` routes also require owner/admin.
export async function resolveCafe(
  env: ClientRouteEnv,
  clientId: string,
  staffUser: StaffUser,
  adminOnly: boolean,
): Promise<{ cafeId: string } | { error: Response }> {
  if (!env.DB) return { error: jsonResponse(500, { error: "Not configured" }) };
  if (adminOnly && !isMyCafeAdmin(staffUser)) {
    return { error: jsonResponse(403, { error: "Only owner/admin can do this" }) };
  }
  if (!env.MYCAFE_ADMIN_API_TOKEN || !env.MYCAFE_CONTROL_PLANE_URL) {
    return { error: jsonResponse(500, { error: "MyCafe integration is not configured (MYCAFE_ADMIN_API_TOKEN/MYCAFE_CONTROL_PLANE_URL)" }) };
  }
  const client = await env.DB.prepare(`SELECT id, product, mycafe_cafe_id FROM clients WHERE id = ?`)
    .bind(clientId)
    .first<{ id: string; product: string; mycafe_cafe_id: string | null }>();
  if (!client) return { error: jsonResponse(404, { error: "Client not found" }) };
  if (client.product !== "mycafe_pos") return { error: jsonResponse(400, { error: "This client isn't a MyCafe client" }) };
  if (!client.mycafe_cafe_id) return { error: jsonResponse(409, { error: "This client hasn't been provisioned yet" }) };
  return { cafeId: client.mycafe_cafe_id };
}

export async function recordAction(
  env: ClientRouteEnv,
  staffUser: StaffUser,
  clientId: string,
  action: string,
  description: string,
  details: unknown,
  reason: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB!.prepare(
    `INSERT INTO client_activity (id, client_id, type, description, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), clientId, action, description, staffUser.id, now)
    .run();
  await env.DB!.prepare(
    `INSERT INTO audit_log (id, actor_id, action, entity_type, entity_id, before, after, reason, created_at)
     VALUES (?, ?, ?, 'client', ?, NULL, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), staffUser.id, action, clientId, JSON.stringify(details), reason, now)
    .run();
}

export async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
