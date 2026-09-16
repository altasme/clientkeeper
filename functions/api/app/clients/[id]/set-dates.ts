// Cloudflare Pages Function: POST /api/app/clients/:id/set-dates
//
// CLAUDE.md §19/§20: lets staff type in a client's domain registration
// date and plan renewal date directly. Deliberately separate from
// `subscriptions.next_renewal_date` (set only as a side effect of
// set-plan.ts's auto-computed addInterval() math, and only exists at all
// once a plan subscription row does) — these two fields live on `clients`
// instead so they can be tracked for any client regardless of subscription
// state (a comp, a legacy client, one of the new no-op "free"/"299"
// plans), and so staff can correct them to match the real-world domain
// registrar/renewal date without resetting the client's whole plan
// history through "Set Plan".
//
// Domain EXPIRATION is deliberately not a field here at all — it's always
// registration date + 1 year, computed wherever it's shown (this app's
// UI, the renewal reminder email in send-domain-reminder.ts), never
// stored. Storing both would let them drift if a registration date is
// ever corrected.
//
// Both fields are optional independently (either can be sent alone) and
// nullable (send "" or null to clear one). No format validation beyond
// "is a string" — this is a plain YYYY-MM-DD `<input type="date">` on the
// frontend, and a free-typed date here is corrective record-keeping, not
// a value anything else in the system computes against.

import type { StaffUser } from "../../../../_lib/roles";

interface Env {
  DB?: D1Database;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function normalizeDate(value: unknown): string | null | undefined {
  if (value === undefined) return undefined; // field not sent: leave unchanged
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
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
  const b = body as Record<string, unknown>;

  const domainRegisteredAt = normalizeDate(b.domainRegisteredAt);
  const planRenewalDate = normalizeDate(b.planRenewalDate);

  if (domainRegisteredAt === undefined && planRenewalDate === undefined) {
    return jsonResponse(400, { error: "Nothing to update." });
  }

  const client = await db
    .prepare(`SELECT id, domain_registered_at, plan_renewal_date FROM clients WHERE id = ?`)
    .bind(clientId)
    .first<{ id: string; domain_registered_at: string | null; plan_renewal_date: string | null }>();
  if (!client) return jsonResponse(404, { error: "Client not found" });

  const nextDomainRegisteredAt = domainRegisteredAt === undefined ? client.domain_registered_at : domainRegisteredAt;
  const nextPlanRenewalDate = planRenewalDate === undefined ? client.plan_renewal_date : planRenewalDate;
  const now = new Date().toISOString();

  await db
    .prepare(`UPDATE clients SET domain_registered_at = ?, plan_renewal_date = ?, updated_at = ? WHERE id = ?`)
    .bind(nextDomainRegisteredAt, nextPlanRenewalDate, now, clientId)
    .run();

  await db
    .prepare(
      `INSERT INTO audit_log (id, actor_id, action, entity_type, entity_id, before, after, reason, created_at)
       VALUES (?, ?, 'set_dates', 'client', ?, ?, ?, NULL, ?)`
    )
    .bind(
      crypto.randomUUID(),
      data.staffUser.id,
      clientId,
      JSON.stringify({ domainRegisteredAt: client.domain_registered_at, planRenewalDate: client.plan_renewal_date }),
      JSON.stringify({ domainRegisteredAt: nextDomainRegisteredAt, planRenewalDate: nextPlanRenewalDate }),
      now
    )
    .run();

  await db
    .prepare(
      `INSERT INTO client_activity (id, client_id, type, description, actor_id, created_at)
       VALUES (?, ?, 'set_dates', 'Domain/plan renewal dates updated by staff', ?, ?)`
    )
    .bind(crypto.randomUUID(), clientId, data.staffUser.id, now)
    .run();

  return jsonResponse(200, { ok: true, domainRegisteredAt: nextDomainRegisteredAt, planRenewalDate: nextPlanRenewalDate });
};
