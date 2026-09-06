// Cloudflare Pages Function: GET /api/app/offers
//
// List of all offers across every client, for the Offers nav page. The
// full pricing table is never exposed anywhere in this app beyond a given
// offer's own content (CLAUDE.md §3/§6 guardrail #2) — this endpoint
// simply returns whatever `content` each existing offers row already
// holds, it never constructs or reveals pricing for offers that don't
// exist yet.

interface Env {
  DB?: D1Database;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  if (!env.DB) return jsonResponse(500, { error: "Not configured" });
  const db = env.DB;

  const result = await db
    .prepare(
      `SELECT o.id, o.type, o.status, o.content, o.unlocked_by, o.unlocked_at, o.created_at, o.updated_at,
              c.id AS client_id, c.full_name, c.business_name
       FROM offers o
       JOIN clients c ON c.id = o.client_id
       ORDER BY o.created_at DESC
       LIMIT 200`
    )
    .all<{
      id: string;
      type: string;
      status: string;
      content: string;
      unlocked_by: string | null;
      unlocked_at: string | null;
      created_at: string;
      updated_at: string;
      client_id: string;
      full_name: string;
      business_name: string;
    }>();

  return jsonResponse(
    200,
    result.results.map((row) => {
      let content: unknown = null;
      try {
        content = JSON.parse(row.content);
      } catch {
        content = null;
      }
      return {
        id: row.id,
        type: row.type,
        status: row.status,
        content,
        unlockedBy: row.unlocked_by,
        unlockedAt: row.unlocked_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        clientId: row.client_id,
        clientFullName: row.full_name,
        businessName: row.business_name,
      };
    })
  );
};
