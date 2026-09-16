// Cloudflare Pages Function: GET /api/app/clients/:id
//
// The full client record for the Client Detail view: identity, project +
// stage, discovery/presentation (including internal_notes — unlike
// clienthub's client-facing endpoint, this app is staff-only, so internal
// fields are exactly what this screen exists to show), all offers, all
// payments, and the activity timeline. One query per related table rather
// than a giant join, since the row counts here are all small (a client has
// one project, a handful of offers/payments/activity entries at most).
//
// DELETE /api/app/clients/:id
//
// CLAUDE.md §19's "Admin can delete client records": a genuinely
// destructive, irreversible action, so it cascades carefully rather than
// relying on database-level ON DELETE behavior (D1 enforces declared
// foreign keys, and several tables here declare one against `clients`).
// Two different fates for the client's related rows:
//   - Operational/workflow data (projects and everything under it,
//     subscriptions, client_activity, businesses) is deleted outright —
//     it has no meaning once the client record it describes is gone.
//   - Financial/audit records (payments, bills) are preserved. `payments`
//     has no FK to `clients` at all (see d1/schema.sql's own note on why
//     that constraint was dropped), so those rows are simply left as-is,
//     orphaned by id, same tolerance the schema already documents.
//     `bills.client_id` DOES have a declared FK, so it's set to NULL
//     first — the bill itself (its recipient_name/email, line items,
//     payment history) is real money that happened and must survive; only
//     the link back to a client record that no longer exists is severed.
// Every statement runs in a single `db.batch()` for atomicity: either the
// whole cascade lands, or none of it does. The audit_log row is written
// inside the same batch, WITH the client's full snapshot as `before`
// (audit_log.entity_id has no FK to clients, so it's the one place this
// deletion stays reconstructable afterward) — captured before the batch
// runs, since by the time it commits the client row is gone.

import type { StaffUser } from "../../../_lib/roles";

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
              invitation_status, domain_registered_at, plan_renewal_date, created_at, updated_at
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
      domain_registered_at: string | null;
      plan_renewal_date: string | null;
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

  const subscriptionsResult = await db
    .prepare(
      `SELECT id, item_type, item_id, item_name, billing_cycle, amount_php, renewal_amount_php, next_renewal_date, started_at
       FROM subscriptions WHERE client_id = ? AND status = 'active' ORDER BY item_type ASC, started_at DESC`
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
    subscriptions: subscriptionsResult.results,
  });
};

export const onRequestDelete: PagesFunction<Env, "id", { staffUser: StaffUser }> = async ({ env, params, data }) => {
  if (!env.DB) return jsonResponse(500, { error: "Not configured" });
  const db = env.DB;
  const clientId = params.id;

  const client = await db.prepare(`SELECT * FROM clients WHERE id = ?`).bind(clientId).first<Record<string, unknown>>();
  if (!client) return jsonResponse(404, { error: "Client not found" });

  const now = new Date().toISOString();

  await db.batch([
    // Offer-adjacent rows first (offer_events references offers.id).
    db.prepare(`DELETE FROM offer_events WHERE offer_id IN (SELECT id FROM offers WHERE client_id = ?)`).bind(clientId),
    db.prepare(`DELETE FROM offers WHERE client_id = ?`).bind(clientId),
    // Project-adjacent rows, while projects for this client still exist.
    db.prepare(`DELETE FROM stage_history WHERE project_id IN (SELECT id FROM projects WHERE client_id = ?)`).bind(clientId),
    db.prepare(`DELETE FROM discovery_sessions WHERE project_id IN (SELECT id FROM projects WHERE client_id = ?)`).bind(clientId),
    db.prepare(`DELETE FROM presentations WHERE project_id IN (SELECT id FROM projects WHERE client_id = ?)`).bind(clientId),
    db.prepare(`DELETE FROM projects WHERE client_id = ?`).bind(clientId),
    // Everything else keyed directly on client_id.
    db.prepare(`DELETE FROM subscriptions WHERE client_id = ?`).bind(clientId),
    db.prepare(`DELETE FROM client_activity WHERE client_id = ?`).bind(clientId),
    db.prepare(`DELETE FROM businesses WHERE client_id = ?`).bind(clientId),
    // Financial records are preserved, only unlinked (see this file's
    // header comment for why).
    db.prepare(`UPDATE bills SET client_id = NULL WHERE client_id = ?`).bind(clientId),
    // The audit trail for the deletion itself, captured before the row
    // that's about to disappear. entity_id intentionally still points at
    // the now-deleted client id — audit_log has no FK back to clients.
    db
      .prepare(
        `INSERT INTO audit_log (id, actor_id, action, entity_type, entity_id, before, after, reason, created_at)
         VALUES (?, ?, 'client_deleted', 'client', ?, ?, NULL, NULL, ?)`
      )
      .bind(crypto.randomUUID(), data.staffUser.id, clientId, JSON.stringify(client), now),
    db.prepare(`DELETE FROM clients WHERE id = ?`).bind(clientId),
  ]);

  return jsonResponse(200, { ok: true });
};
