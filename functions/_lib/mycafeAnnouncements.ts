// Shared by the two /api/app/mycafe/announcements routes: request-body whitelist,
// the owner/admin gate, error mapping, and the audit row. A post goes to EVERY
// MyCafe cafe's Owner Panel, so creating/editing/publishing is owner/admin only
// (reading the list is open to any staff role, like the rest of the MyCafe views).
import { MyCafeApiError, type MyCafeEnv } from "./mycafe";
import { isMyCafeAdmin, type StaffUser } from "./roles";

export interface AnnouncementsEnv extends MyCafeEnv {
  DB?: D1Database;
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// Returns an error Response when the integration is not set up, or null if fine.
export function checkConfigured(env: AnnouncementsEnv): Response | null {
  if (!env.DB) return jsonResponse(500, { error: "Not configured" });
  if (!env.MYCAFE_ADMIN_API_TOKEN || !env.MYCAFE_CONTROL_PLANE_URL) {
    return jsonResponse(500, { error: "MyCafe integration is not configured (MYCAFE_ADMIN_API_TOKEN/MYCAFE_CONTROL_PLANE_URL)" });
  }
  return null;
}

export function requireAdmin(staffUser: StaffUser): Response | null {
  return isMyCafeAdmin(staffUser) ? null : jsonResponse(403, { error: "Only owner/admin can manage MyCafe announcements" });
}

const EDITABLE = ["title", "body", "category", "linkUrl", "linkLabel", "pinned", "status"] as const;

// Only these fields ever go to MyCafe. `author` is never taken from the request:
// it is the signed-in staff member, set on create.
export function pickAnnouncementFields(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const body = raw as Record<string, unknown>;
  for (const key of EDITABLE) if (Object.hasOwn(body, key)) out[key] = body[key];
  return out;
}

export function mapError(err: unknown): Response {
  if (err instanceof MyCafeApiError) {
    return jsonResponse(err.status >= 400 && err.status < 600 ? err.status : 502, { error: err.message });
  }
  return jsonResponse(502, { error: "Could not reach MyCafe" });
}

export async function audit(
  env: AnnouncementsEnv,
  staffUser: StaffUser,
  action: string,
  announcementId: number | string,
  after: unknown,
): Promise<void> {
  await env.DB!.prepare(
    `INSERT INTO audit_log (id, actor_id, action, entity_type, entity_id, before, after, reason, created_at)
     VALUES (?, ?, ?, 'mycafe_announcement', ?, NULL, ?, NULL, ?)`,
  )
    .bind(crypto.randomUUID(), staffUser.id, action, String(announcementId), JSON.stringify(after), new Date().toISOString())
    .run();
}

export async function readJsonBody(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
