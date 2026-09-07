// Cloudflare Pages Function: GET /api/app/clients/:id
//
// The full client record for the Client Detail view: identity, project +
// stage, discovery/presentation (including internal_notes — unlike
// clienthub's client-facing endpoint, this app is staff-only, so internal
// fields are exactly what this screen exists to show), all offers, all
// payments, and the activity timeline. One query per related table rather
// than a giant join, since the row counts here are all small (a client has
// one project, a handful of offers/payments/activity entries at most).

interface Env {
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
      `SELECT id, workos_user_id, email, full_name, business_name, mobile, facebook, current_website,
              invitation_status, created_at, updated_at
       FROM clients WHERE id = ?`
    )
    .bind(clientId)
    .first<{
      id: string;
      workos_user_id: string | null;
      email: string;
      full_name: string;
      business_name: string;
      mobile: string | null;
      facebook: string | null;
      current_website: string | null;
      invitation_status: string;
      created_at: string;
      updated_at: string;
    }>();

  if (!client) return jsonResponse(404, { error: "Client not found" });

  const project = await db
    .prepare(
      `SELECT id, stage, assigned_developer_id, website_url, created_at, updated_at
       FROM projects WHERE client_id = ? ORDER BY created_at DESC LIMIT 1`
    )
    .bind(clientId)
    .first<{
      id: string;
      stage: string;
      assigned_developer_id: string | null;
      website_url: string | null;
      created_at: string;
      updated_at: string;
    }>();

  let discovery = null;
  let presentation = null;
  let offers: unknown[] = [];
  let stageHistory: unknown[] = [];

  if (project) {
    discovery = await db
      .prepare(
        `SELECT id, external_status, internal_notes, preferred_times, scheduled_at, meeting_link, created_at, updated_at
         FROM discovery_sessions WHERE project_id = ? ORDER BY created_at DESC LIMIT 1`
      )
      .bind(project.id)
      .first();

    presentation = await db
      .prepare(
        `SELECT id, external_status, internal_notes, preferred_times, scheduled_at, meeting_link, client_decision, created_at, updated_at
         FROM presentations WHERE project_id = ? ORDER BY created_at DESC LIMIT 1`
      )
      .bind(project.id)
      .first();

    const offersResult = await db
      .prepare(
        `SELECT id, type, status, content, unlocked_by, unlocked_at, created_at, updated_at
         FROM offers WHERE project_id = ? ORDER BY created_at DESC`
      )
      .bind(project.id)
      .all<{ id: string; type: string; status: string; content: string; unlocked_by: string | null; unlocked_at: string | null; created_at: string; updated_at: string }>();
    offers = offersResult.results.map((o) => {
      let content: unknown = null;
      try {
        content = JSON.parse(o.content);
      } catch {
        content = null;
      }
      return { ...o, content };
    });

    const historyResult = await db
      .prepare(
        `SELECT id, from_stage, to_stage, actor_id, reason, created_at
         FROM stage_history WHERE project_id = ? ORDER BY created_at DESC`
      )
      .bind(project.id)
      .all();
    stageHistory = historyResult.results;
  }

  const paymentsResult = await db
    .prepare(
      `SELECT id, ganap_reference_number, external_reference, amount, currency, status, created_at
       FROM payments WHERE client_id = ? ORDER BY created_at DESC`
    )
    .bind(clientId)
    .all();

  const activityResult = await db
    .prepare(
      `SELECT id, type, description, actor_id, created_at
       FROM client_activity WHERE client_id = ? ORDER BY created_at DESC LIMIT 100`
    )
    .bind(clientId)
    .all();

  return jsonResponse(200, {
    client,
    project,
    discovery,
    presentation,
    offers,
    stageHistory,
    payments: paymentsResult.results,
    activity: activityResult.results,
  });
};
