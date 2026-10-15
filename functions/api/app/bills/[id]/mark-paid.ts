// Cloudflare Pages Function: POST /api/app/bills/:id/mark-paid
//
// Manual payment confirmation for a Bill of Service, added once the public
// bill page stopped offering an automated ganap.net "Make a Payment Now"
// checkout in favor of static GCash payment details (operator decision,
// 2026-10-15) -- a client now pays by GCash transfer directly and messages
// staff to confirm, so staff need a way to mark that confirmed payment on
// the bill themselves instead of relying on a ganap.net webhook/reconcile
// that will never fire for a manually-settled bill.
//
// Reuses the existing `payments` table rather than inventing a parallel
// "manual payment" record -- same CHECK-allowed `source = 'bill_of_service'`
// value the ganap.net webhook already uses for an automated bill payment
// (clienthub's functions/api/webhooks/ganap.ts), so a bill's payment
// history reads the same regardless of how it was actually settled.
// `ganap_reference_number` is NOT NULL on that table with no real ganap
// transaction behind a manual payment, so a clearly-labeled synthetic
// value ("MANUAL-GCASH-<timestamp>") is stored instead of leaving a
// schema migration on a column this feature doesn't otherwise need to
// touch. The real payment detail (who confirmed it, staff's own
// reference/note) lives in raw_payload as JSON -- this table's existing,
// generic "whatever was received" slot, same role it plays for a real
// ganap.net webhook body.
//
// Pending or expired bills can both be marked paid (a late GCash transfer
// after the bill's validity window is a real, expected scenario, unlike
// cancel.ts's own narrower "only pending" rule) -- paid/cancelled bills
// are rejected outright since there's nothing to confirm.

import type { StaffUser } from "../../../../_lib/roles";

interface Env {
  DB?: D1Database;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export const onRequestPost: PagesFunction<Env, "id", { staffUser: StaffUser }> = async ({ request, env, params, data }) => {
  if (!env.DB) return jsonResponse(500, { error: "Not configured" });
  const db = env.DB;

  const bill = await db
    .prepare(`SELECT id, client_id, bill_number, total_amount, currency, status FROM bills WHERE id = ?`)
    .bind(params.id)
    .first<{ id: string; client_id: string | null; bill_number: string; total_amount: number; currency: string; status: string }>();
  if (!bill) return jsonResponse(404, { error: "Bill not found" });
  if (bill.status !== "pending" && bill.status !== "expired") {
    return jsonResponse(400, { error: `This bill is already ${bill.status} and can't be marked paid.` });
  }

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    // no body sent -- reference/note are both optional, so this is fine
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const reference = typeof b.reference === "string" && b.reference.trim() ? b.reference.trim() : null;
  const note = typeof b.note === "string" && b.note.trim() ? b.note.trim() : null;

  const now = new Date().toISOString();
  const paymentId = crypto.randomUUID();
  const syntheticReference = `MANUAL-GCASH-${Date.now()}`;
  const rawPayload = JSON.stringify({
    source: "manual_gcash",
    confirmedBy: data.staffUser.id,
    confirmedByEmail: data.staffUser.email,
    reference,
    note,
    confirmedAt: now,
  });

  await db
    .prepare(
      `INSERT INTO payments (id, client_id, ganap_reference_number, external_reference, amount, currency, status, source, raw_payload, created_at)
       VALUES (?, ?, ?, NULL, ?, ?, 'paid', 'bill_of_service', ?, ?)`
    )
    .bind(paymentId, bill.client_id, syntheticReference, bill.total_amount, bill.currency, rawPayload, now)
    .run();

  await db.prepare(`UPDATE bills SET status = 'paid', paid_at = ?, payment_id = ?, updated_at = ? WHERE id = ?`).bind(now, paymentId, now, bill.id).run();

  await db
    .prepare(
      `INSERT INTO audit_log (id, actor_id, action, entity_type, entity_id, before, after, reason, created_at)
       VALUES (?, ?, 'bill_marked_paid', 'bill', ?, ?, ?, ?, ?)`
    )
    .bind(
      crypto.randomUUID(),
      data.staffUser.id,
      bill.id,
      JSON.stringify({ status: bill.status }),
      JSON.stringify({ status: "paid", paymentId, reference }),
      note,
      now
    )
    .run();

  if (bill.client_id) {
    await db
      .prepare(`INSERT INTO client_activity (id, client_id, type, description, actor_id, created_at) VALUES (?, ?, 'bill_paid', ?, ?, ?)`)
      .bind(
        crypto.randomUUID(),
        bill.client_id,
        `Bill of Service ${bill.bill_number} marked paid manually (GCash${reference ? `, ref: ${reference}` : ""})`,
        data.staffUser.id,
        now
      )
      .run();
  }

  return jsonResponse(200, { ok: true, paidAt: now });
};
