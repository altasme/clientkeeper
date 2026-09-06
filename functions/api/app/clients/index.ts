// Cloudflare Pages Function: GET /api/app/clients
//
// List/search clients for the Clients nav page. Query params (all
// optional): `q` (matches full_name/business_name/email), `stage`
// (filters by the client's current project stage), `paidNoAccount=1`
// (invitation_status != 'accepted' — CLAUDE.md §2's "paid, no account yet"
// list; surfaced as a filter on this same page rather than a separate nav
// item, since it's the same underlying client record set).

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
  const q = url.searchParams.get("q")?.trim();
  const stage = url.searchParams.get("stage")?.trim();
  const paidNoAccount = url.searchParams.get("paidNoAccount") === "1";

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (q) {
    conditions.push(`(c.full_name LIKE ? OR c.business_name LIKE ? OR c.email LIKE ?)`);
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  if (stage) {
    conditions.push(`p.stage = ?`);
    params.push(stage);
  }
  if (paidNoAccount) {
    conditions.push(`c.invitation_status != 'accepted'`);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const result = await db
    .prepare(
      `SELECT c.id, c.full_name, c.business_name, c.email, c.invitation_status, c.created_at,
              p.id AS project_id, p.stage, p.updated_at
       FROM clients c
       LEFT JOIN projects p ON p.client_id = c.id
       ${whereClause}
       ORDER BY COALESCE(p.updated_at, c.created_at) DESC
       LIMIT 200`
    )
    .bind(...params)
    .all<{
      id: string;
      full_name: string;
      business_name: string;
      email: string;
      invitation_status: string;
      created_at: string;
      project_id: string | null;
      stage: string | null;
      updated_at: string | null;
    }>();

  return jsonResponse(
    200,
    result.results.map((row) => ({
      id: row.id,
      fullName: row.full_name,
      businessName: row.business_name,
      email: row.email,
      invitationStatus: row.invitation_status,
      createdAt: row.created_at,
      projectId: row.project_id,
      stage: row.stage,
      updatedAt: row.updated_at,
    }))
  );
};
