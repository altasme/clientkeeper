// Cloudflare Pages Function: GET /api/app/discovery
//
// List of discovery sessions across every project, for the Discovery nav
// page — includes internal_notes (staff-only view) and client context.
// Optional `status` filter against external_status.

interface Env {
  DB?: D1Database;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return jsonResponse(500, { error: "Not configured" });
  const db = env.DB;

  const url = new URL(request.url);
  const status = url.searchParams.get("status")?.trim();

  const conditions: string[] = [];
  const params: unknown[] = [];
  if (status) {
    conditions.push(`d.external_status = ?`);
    params.push(status);
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const result = await db
    .prepare(
      `SELECT d.id, d.external_status, d.internal_notes, d.preferred_times, d.scheduled_at, d.created_at, d.updated_at,
              p.id AS project_id, c.id AS client_id, c.full_name, c.business_name
       FROM discovery_sessions d
       JOIN projects p ON p.id = d.project_id
       JOIN clients c ON c.id = p.client_id
       ${whereClause}
       ORDER BY d.updated_at DESC
       LIMIT 200`
    )
    .bind(...params)
    .all();

  return jsonResponse(200, result.results);
};
