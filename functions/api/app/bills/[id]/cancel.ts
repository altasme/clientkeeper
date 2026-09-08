// Cloudflare Pages Function: POST /api/app/bills/:id/cancel
//
// Staff-only cancellation of a still-pending Bill of Service — once
// cancelled, the public link shows a "cancelled" state and the "Make a
// Payment Now" button never renders. Only a `pending` bill can be
// cancelled: a `paid` one is done, and `expired`/already-`cancelled` are
// no-ops the UI shouldn't be offering in the first place, but this is
// enforced here too, not just hidden in the UI.

import type { StaffUser } from "../../../../_lib/roles";

interface Env {
  DB?: D1Database;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export const onRequestPost: PagesFunction<Env, "id", { staffUser: StaffUser }> = async ({ env, params, data }) => {
  if (!env.DB) return jsonResponse(500, { error: "Not configured" });
  const db = env.DB;

  const bill = await db.prepare(`SELECT id, client_id, bill_number, status FROM bills WHERE id = ?`).bind(params.id).first<{ id: string; client_id: string | null; bill_number: string; status: string }>();
  if (!bill) return jsonResponse(404, { error: "Bill not found" });
  if (bill.status !== "pending") return jsonResponse(400, { error: `This bill is already ${bill.status} and can't be cancelled.` });

  const now = new Date().toISOString();

  await db.prepare(`UPDATE bills SET status = 'cancelled', updated_at = ? WHERE id = ?`).bind(now, bill.id).run();

  await db
    .prepare(
      `INSERT INTO audit_log (id, actor_id, action, entity_type, entity_id, before, after, reason, created_at)
       VALUES (?, ?, 'bill_cancelled', 'bill', ?, ?, ?, NULL, ?)`
    )
    .bind(crypto.randomUUID(), data.staffUser.id, bill.id, JSON.stringify({ status: "pending" }), JSON.stringify({ status: "cancelled" }), now)
    .run();

  if (bill.client_id) {
    await db
      .prepare(`INSERT INTO client_activity (id, client_id, type, description, actor_id, created_at) VALUES (?, ?, 'bill_cancelled', ?, ?, ?)`)
      .bind(crypto.randomUUID(), bill.client_id, `Bill of Service ${bill.bill_number} cancelled`, data.staffUser.id, now)
      .run();
  }

  return jsonResponse(200, { ok: true });
};
