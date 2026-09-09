// Cloudflare Pages Function: GET/POST /api/app/bills
//
// The Bill of Service generator (CLAUDE.md's "Bill of Service" section).
// Creating a bill is purely a D1 write — no ganap.net credentials needed
// here at all, since staff aren't charging anyone directly; the resulting
// public link (https://account.altasme.com/bill/:token, in Client Hub,
// which DOES hold ganap credentials) is what actually starts a payment
// once the client opens it and clicks through.

import type { StaffUser } from "../../../_lib/roles";

interface Env {
  DB?: D1Database;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const MANILA_YEAR_FORMATTER = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric" });
const MANILA_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit" });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function generateBillNumber(db: D1Database): Promise<string> {
  const year = MANILA_YEAR_FORMATTER.format(new Date());
  const prefix = `ALTAV-BOS-${year}-`;
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM bills WHERE bill_number LIKE ?`).bind(`${prefix}%`).first<{ count: number }>();
  const seq = (row?.count ?? 0) + 1;
  return `${prefix}${String(seq).padStart(3, "0")}`;
}

// Short public-link token, replacing a bare crypto.randomUUID() (36
// characters — the operator's own complaint: too long to comfortably
// share in chat). 8 characters from a 32-symbol alphabet (32^8 ≈ 1.1
// trillion combinations) is short enough to read out loud but still far
// too large to guess or brute-force, matching the original "unique link
// so it doesn't look scammy" requirement this feature was built around —
// literally "the last 4 digits" (10,000 possibilities) would make other
// clients' bills practically guessable. Alphabet excludes 0/1/l/o/i to
// avoid visual confusion if anyone ever has to read or retype it, and is
// lowercase-only so copy/paste through a chat app can't be mangled by
// autocapitalization. 256 % 32 === 0, so mapping a random byte via modulo
// introduces no bias. Existing bills keep their long (UUID) tokens
// unchanged — token is just an opaque TEXT column, no format constraint.
const TOKEN_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
const TOKEN_LENGTH = 8;

function generateShortToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_LENGTH));
  return Array.from(bytes, (b) => TOKEN_ALPHABET[b % TOKEN_ALPHABET.length]).join("");
}

async function generateUniqueToken(db: D1Database): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = generateShortToken();
    const existing = await db.prepare(`SELECT id FROM bills WHERE token = ?`).bind(token).first<{ id: string }>();
    if (!existing) return token;
  }
  // Astronomically unlikely at 32^8 combinations — if every retry somehow
  // collided, fall back to a full UUID rather than looping forever.
  return crypto.randomUUID();
}

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  if (!env.DB) return jsonResponse(500, { error: "Not configured" });
  const db = env.DB;

  const result = await db
    .prepare(
      `SELECT b.id, b.bill_number, b.token, b.client_type, b.recipient_name, b.currency, b.total_amount,
              b.status, b.issue_date, b.expires_at, b.created_at,
              c.id AS client_id, c.full_name, c.business_name
       FROM bills b
       LEFT JOIN clients c ON c.id = b.client_id
       ORDER BY b.created_at DESC
       LIMIT 200`
    )
    .all<{
      id: string;
      bill_number: string;
      token: string;
      client_type: string;
      recipient_name: string;
      currency: string;
      total_amount: number;
      status: string;
      issue_date: string;
      expires_at: string;
      created_at: string;
      client_id: string | null;
      full_name: string | null;
      business_name: string | null;
    }>();

  return jsonResponse(
    200,
    result.results.map((row) => ({
      id: row.id,
      billNumber: row.bill_number,
      token: row.token,
      clientType: row.client_type,
      recipientName: row.recipient_name,
      currency: row.currency,
      totalAmount: row.total_amount,
      status: row.status,
      issueDate: row.issue_date,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      clientId: row.client_id,
      clientFullName: row.full_name,
      clientBusinessName: row.business_name,
    }))
  );
};

interface LineItemInput {
  description: string;
  amount: number;
}

export const onRequestPost: PagesFunction<Env, string, { staffUser: StaffUser }> = async ({ request, env, data }) => {
  if (!env.DB) return jsonResponse(500, { error: "Not configured" });
  const db = env.DB;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "Invalid request body" });
  }
  const b = body as Record<string, unknown>;

  const clientId = typeof b.clientId === "string" && b.clientId.trim() ? b.clientId.trim() : null;
  const clientType = b.clientType === "individual" || b.clientType === "corporate" ? b.clientType : null;
  const recipientName = typeof b.recipientName === "string" ? b.recipientName.trim() : "";
  const recipientContactPerson = typeof b.recipientContactPerson === "string" && b.recipientContactPerson.trim() ? b.recipientContactPerson.trim() : null;
  const recipientTin = typeof b.recipientTin === "string" && b.recipientTin.trim() ? b.recipientTin.trim() : null;
  const recipientEmail = typeof b.recipientEmail === "string" ? b.recipientEmail.trim() : "";
  const scopeDescription = typeof b.scopeDescription === "string" && b.scopeDescription.trim() ? b.scopeDescription.trim() : null;
  const notes = typeof b.notes === "string" && b.notes.trim() ? b.notes.trim() : null;
  const validityDays = typeof b.validityDays === "number" && Number.isInteger(b.validityDays) && b.validityDays > 0 && b.validityDays <= 365 ? b.validityDays : 7;
  const rawLineItems = Array.isArray(b.lineItems) ? (b.lineItems as unknown[]) : [];

  if (!clientType) return jsonResponse(400, { error: "Client type must be 'individual' or 'corporate'." });
  if (!recipientName) return jsonResponse(400, { error: "Recipient name is required." });

  const lineItems: LineItemInput[] = [];
  for (const raw of rawLineItems) {
    const item = raw as Record<string, unknown>;
    const description = typeof item?.description === "string" ? item.description.trim() : "";
    const amount = typeof item?.amount === "number" ? item.amount : NaN;
    if (!description || !Number.isInteger(amount) || amount <= 0) continue;
    lineItems.push({ description, amount });
  }
  if (lineItems.length === 0) return jsonResponse(400, { error: "At least one line item with a description and a positive whole-peso amount is required." });

  let client: { id: string; email: string } | null = null;
  if (clientId) {
    client = await db.prepare(`SELECT id, email FROM clients WHERE id = ?`).bind(clientId).first<{ id: string; email: string }>();
    if (!client) return jsonResponse(404, { error: "Client not found." });
  }

  // Not required (operator decision, 2026-09-09): a bill can be created
  // with no email at all — staff share the link manually via chat, and
  // Client Hub's checkout falls back to a generic address if neither the
  // linked client nor this field has one (functions/api/public/bill/
  // [token]/checkout.ts there). Still validated for shape if one IS given,
  // since a malformed email is worse than none.
  if (recipientEmail && !EMAIL_RE.test(recipientEmail)) {
    return jsonResponse(400, { error: "That doesn't look like a valid email address." });
  }

  const totalAmount = lineItems.reduce((sum, item) => sum + item.amount, 0);
  const now = new Date();
  const nowIso = now.toISOString();
  const issueDate = MANILA_DATE_FORMATTER.format(now);
  const expiresAt = new Date(now.getTime() + validityDays * 24 * 60 * 60 * 1000).toISOString();

  const billNumber = await generateBillNumber(db);
  const billId = crypto.randomUUID();
  const token = await generateUniqueToken(db);

  await db
    .prepare(
      `INSERT INTO bills (id, bill_number, token, client_id, client_type, recipient_name, recipient_contact_person, recipient_tin,
                           recipient_email, scope_description, currency, total_amount, validity_days, issue_date, expires_at,
                           status, notes, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PHP', ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
    )
    .bind(
      billId,
      billNumber,
      token,
      clientId,
      clientType,
      recipientName,
      recipientContactPerson,
      recipientTin,
      recipientEmail || null,
      scopeDescription,
      totalAmount,
      validityDays,
      issueDate,
      expiresAt,
      notes,
      data.staffUser.id,
      nowIso,
      nowIso
    )
    .run();

  for (let i = 0; i < lineItems.length; i++) {
    await db
      .prepare(`INSERT INTO bill_line_items (id, bill_id, description, amount, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), billId, lineItems[i].description, lineItems[i].amount, i, nowIso)
      .run();
  }

  await db
    .prepare(
      `INSERT INTO audit_log (id, actor_id, action, entity_type, entity_id, before, after, reason, created_at)
       VALUES (?, ?, 'bill_created', 'bill', ?, NULL, ?, NULL, ?)`
    )
    .bind(crypto.randomUUID(), data.staffUser.id, billId, JSON.stringify({ billNumber, recipientName, totalAmount, clientType }), nowIso)
    .run();

  if (clientId) {
    await db
      .prepare(`INSERT INTO client_activity (id, client_id, type, description, actor_id, created_at) VALUES (?, ?, 'bill_created', ?, ?, ?)`)
      .bind(crypto.randomUUID(), clientId, `Bill of Service ${billNumber} created for ₱${totalAmount}`, data.staffUser.id, nowIso)
      .run();
  }

  return jsonResponse(201, {
    id: billId,
    billNumber,
    token,
    publicUrl: `https://account.altasme.com/bill/${token}`,
    createdAt: nowIso,
  });
};
