// Cloudflare Pages Function: GET /api/app/projects
//
// Project-centric list for the Projects nav page (as opposed to the
// Clients page's client-centric list) — every project across every
// client, optionally filtered by `stage`, with enough client context to
// be useful without a second lookup.

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
  const stage = url.searchParams.get("stage")?.trim();

  const conditions: string[] = [];
  const params: unknown[] = [];
  if (stage) {
    conditions.push(`p.stage = ?`);
    params.push(stage);
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const result = await db
    .prepare(
      `SELECT p.id, p.stage, p.website_url, p.updated_at, p.assigned_developer_id,
              c.id AS client_id, c.full_name, c.business_name
       FROM projects p
       JOIN clients c ON c.id = p.client_id
       ${whereClause}
       ORDER BY p.updated_at DESC
       LIMIT 200`
    )
    .bind(...params)
    .all<{
      id: string;
      stage: string;
      website_url: string | null;
      updated_at: string;
      assigned_developer_id: string | null;
      client_id: string;
      full_name: string;
      business_name: string;
    }>();

  return jsonResponse(
    200,
    result.results.map((row) => ({
      id: row.id,
      stage: row.stage,
      websiteUrl: row.website_url,
      updatedAt: row.updated_at,
      assignedDeveloperId: row.assigned_developer_id,
      clientId: row.client_id,
      clientFullName: row.full_name,
      businessName: row.business_name,
    }))
  );
};
