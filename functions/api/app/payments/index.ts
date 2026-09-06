// Cloudflare Pages Function: GET /api/app/payments
//
// Read-only list of all ganap.net payment confirmations across every
// client, for the Payments nav page. No mutation endpoints here —
// payments rows are written only by clienthub's ganap webhook
// (functions/api/webhooks/ganap.ts there), never by this app, since this
// app has no payment-provider credentials or webhook of its own
// (CLAUDE.md §0: "payment webhooks... live in clienthub, not here").

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
      `SELECT pay.id, pay.ganap_reference_number, pay.external_reference, pay.amount, pay.currency, pay.status, pay.created_at,
              c.id AS client_id, c.full_name, c.business_name
       FROM payments pay
       LEFT JOIN clients c ON c.id = pay.client_id
       ORDER BY pay.created_at DESC
       LIMIT 200`
    )
    .all();

  return jsonResponse(200, result.results);
};
