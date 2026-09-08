// Cloudflare Pages Function: GET /api/app/bills/:id
//
// Full detail for one Bill of Service (the BillDetailPage's data source):
// header fields, line items, and the public link staff copy to send to
// the client.

interface Env {
  DB?: D1Database;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export const onRequestGet: PagesFunction<Env, "id"> = async ({ env, params }) => {
  if (!env.DB) return jsonResponse(500, { error: "Not configured" });
  const db = env.DB;

  const bill = await db
    .prepare(
      `SELECT b.id, b.bill_number, b.token, b.client_id, b.client_type, b.recipient_name, b.recipient_contact_person,
              b.recipient_tin, b.recipient_email, b.scope_description, b.currency, b.total_amount, b.validity_days,
              b.issue_date, b.expires_at, b.status, b.notes, b.paid_at, b.created_at,
              c.full_name AS client_full_name, c.business_name AS client_business_name
       FROM bills b
       LEFT JOIN clients c ON c.id = b.client_id
       WHERE b.id = ?`
    )
    .bind(params.id)
    .first<Record<string, unknown>>();

  if (!bill) return jsonResponse(404, { error: "Bill not found" });

  const lineItems = await db
    .prepare(`SELECT description, amount FROM bill_line_items WHERE bill_id = ? ORDER BY sort_order ASC`)
    .bind(params.id)
    .all<{ description: string; amount: number }>();

  return jsonResponse(200, {
    id: bill.id,
    billNumber: bill.bill_number,
    token: bill.token,
    publicUrl: `https://account.altasme.com/bill/${bill.token as string}`,
    clientId: bill.client_id,
    clientFullName: bill.client_full_name,
    clientBusinessName: bill.client_business_name,
    clientType: bill.client_type,
    recipientName: bill.recipient_name,
    recipientContactPerson: bill.recipient_contact_person,
    recipientTin: bill.recipient_tin,
    recipientEmail: bill.recipient_email,
    scopeDescription: bill.scope_description,
    currency: bill.currency,
    totalAmount: bill.total_amount,
    validityDays: bill.validity_days,
    issueDate: bill.issue_date,
    expiresAt: bill.expires_at,
    status: bill.status,
    notes: bill.notes,
    paidAt: bill.paid_at,
    createdAt: bill.created_at,
    lineItems: lineItems.results,
  });
};
