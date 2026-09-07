// Cloudflare Pages Function: POST /api/app/clients/:id/set-plan
//
// Staff override of a client's current plan (clienthub's CLAUDE.md §12,
// "All clients start at starter plan 299, but we have to be able to
// override it"). Every new client already gets an active Starter Plan
// subscription automatically from clienthub's ganap webhook — this is the
// manual correction path: a client who should actually be on a different
// plan (a comp, a migrated legacy client, a data-entry fix), set here
// without a real ganap.net charge.
//
// This is NOT a purchase. No payment is created, no ganap.net call is
// made — `amount_php`/`renewal_amount_php` are recorded from the catalog
// purely for display consistency with a real purchase (so the Account
// page shows the same numbers either way), and `payment_id` stays NULL to
// mark this row as staff-set rather than client-paid. Same
// supersede-the-active-plan semantics as clienthub's internal-upsell
// webhook: the client's prior active plan row (if any) is cancelled, not
// deleted, so plan history stays intact.
//
// Audited like any other sensitive admin action (this repo's CLAUDE.md §3
// / guardrail #3) — writes both client_activity (visible in the Activity
// tab) and audit_log (before/after, actor, reason optional).

import { findPlan } from "../../../../_lib/pricing";
import type { StaffUser } from "../../../../_lib/roles";

interface Env {
  DB?: D1Database;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function addInterval(fromIso: string, cycle: "one_time" | "annual" | "monthly"): string {
  const d = new Date(fromIso);
  if (cycle === "monthly") {
    d.setUTCMonth(d.getUTCMonth() + 1);
  } else {
    d.setUTCFullYear(d.getUTCFullYear() + 1);
  }
  return d.toISOString();
}

export const onRequestPost: PagesFunction<Env, "id", { staffUser: StaffUser }> = async ({ request, env, params, data }) => {
  if (!env.DB) return jsonResponse(500, { error: "Not configured" });
  const db = env.DB;
  const clientId = params.id;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "Invalid request body" });
  }
  const planId = typeof (body as Record<string, unknown>)?.planId === "string" ? ((body as Record<string, unknown>).planId as string) : "";
  const plan = findPlan(planId);
  if (!plan) return jsonResponse(400, { error: "Unknown plan." });

  const client = await db.prepare(`SELECT id FROM clients WHERE id = ?`).bind(clientId).first<{ id: string }>();
  if (!client) return jsonResponse(404, { error: "Client not found" });

  const previousPlan = await db
    .prepare(`SELECT item_id FROM subscriptions WHERE client_id = ? AND item_type = 'plan' AND status = 'active'`)
    .bind(clientId)
    .first<{ item_id: string }>();

  const now = new Date().toISOString();

  await db
    .prepare(`UPDATE subscriptions SET status = 'cancelled', ended_at = ? WHERE client_id = ? AND item_type = 'plan' AND status = 'active'`)
    .bind(now, clientId)
    .run();

  const nextRenewalDate = plan.renewalPhp ? addInterval(now, plan.billing) : null;

  await db
    .prepare(
      `INSERT INTO subscriptions (id, client_id, plan, status, started_at, item_type, item_id, item_name, billing_cycle, amount_php, renewal_amount_php, next_renewal_date, payment_id)
       VALUES (?, ?, ?, 'active', ?, 'plan', ?, ?, ?, ?, ?, ?, NULL)`
    )
    .bind(crypto.randomUUID(), clientId, plan.name, now, plan.id, plan.name, plan.billing, plan.chargeNowPhp, plan.renewalPhp ?? null, nextRenewalDate)
    .run();

  await db
    .prepare(
      `INSERT INTO audit_log (id, actor_id, action, entity_type, entity_id, before, after, reason, created_at)
       VALUES (?, ?, 'plan_override', 'client', ?, ?, ?, NULL, ?)`
    )
    .bind(
      crypto.randomUUID(),
      data.staffUser.id,
      clientId,
      JSON.stringify({ plan: previousPlan?.item_id ?? null }),
      JSON.stringify({ plan: plan.id }),
      now
    )
    .run();

  await db
    .prepare(
      `INSERT INTO client_activity (id, client_id, type, description, actor_id, created_at)
       VALUES (?, ?, 'plan_override', ?, ?, ?)`
    )
    .bind(crypto.randomUUID(), clientId, `Plan set to ${plan.name} by staff`, data.staffUser.id, now)
    .run();

  return jsonResponse(200, { ok: true, plan: plan.id });
};
