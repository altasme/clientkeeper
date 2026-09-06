// Cloudflare Pages Function: GET /api/app/leads
//
// Pre-payment lead records for the Leads nav page (CLAUDE.md §2: "Leads:
// pre-payment records + statuses, source carried through"). Optional
// `status` and `q` (name/business/email) query params, same filtering
// shape as the Clients list.

interface Env {
  DB?: D1Database;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return jsonResponse(500, { error: "Not configured" });
  const db = env.DB;

  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim();
  const status = url.searchParams.get("status")?.trim();

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (q) {
    conditions.push(`(full_name LIKE ? OR business_name LIKE ? OR email LIKE ?)`);
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  if (status) {
    conditions.push(`status = ?`);
    params.push(status);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const result = await db
    .prepare(
      `SELECT id, full_name, business_name, email, phone, source, status, notes, created_at, updated_at
       FROM leads ${whereClause} ORDER BY created_at DESC LIMIT 200`
    )
    .bind(...params)
    .all();

  return jsonResponse(200, result.results);
};

// POST /api/app/leads — manual lead entry (e.g. a referral phoned in
// directly rather than arriving via a paid-social funnel).
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return jsonResponse(500, { error: "Not configured" });
  const db = env.DB;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "Invalid request body" });
  }
  const b = body as Record<string, unknown>;
  const fullName = typeof b.fullName === "string" ? b.fullName.trim() : "";
  const businessName = typeof b.businessName === "string" ? b.businessName.trim() : "";
  const email = typeof b.email === "string" ? b.email.trim() : "";
  const phone = typeof b.phone === "string" ? b.phone.trim() : "";
  const source = typeof b.source === "string" ? b.source.trim() : "manual";
  const notes = typeof b.notes === "string" ? b.notes.trim() : null;

  if (!fullName && !businessName && !email) {
    return jsonResponse(400, { error: "At least a name, business name, or email is required." });
  }

  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  await db
    .prepare(
      `INSERT INTO leads (id, full_name, business_name, email, phone, source, status, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'new', ?, ?, ?)`
    )
    .bind(id, fullName || null, businessName || null, email || null, phone || null, source, notes, now, now)
    .run();

  return jsonResponse(201, { id, createdAt: now });
};
