// Cloudflare Pages Function: GET /api/app/presentations
//
// List of presentations across every project, for the Presentations nav
// page. Same shape as functions/api/app/discovery/index.ts.

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
    conditions.push(`pr.external_status = ?`);
    params.push(status);
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const result = await db
    .prepare(
      `SELECT pr.id, pr.external_status, pr.internal_notes, pr.preferred_times, pr.scheduled_at, pr.client_decision,
              pr.created_at, pr.updated_at,
              p.id AS project_id, c.id AS client_id, c.full_name, c.business_name
       FROM presentations pr
       JOIN projects p ON p.id = pr.project_id
       JOIN clients c ON c.id = p.client_id
       ${whereClause}
       ORDER BY pr.updated_at DESC
       LIMIT 200`
    )
    .bind(...params)
    .all();

  return jsonResponse(200, result.results);
};
