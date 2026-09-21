// Cloudflare Pages Function: GET/POST /api/app/mycafe/clients
//
// MyCafe POS is a second product line (CLAUDE.md's MyCafe section) —
// `clients.product` distinguishes these rows from the existing web_dev
// funnel clients. Deliberately NOT run through the web_dev stage machine
// (no `projects` row): MyCafe's own lifecycle (sign up -> pay -> provision
// -> active cafe) doesn't map onto discovery/building/presentation/offers
// at all, so forcing one would just be a fiction. A MyCafe client is
// "created" here, then separately "provisioned" (functions/api/app/mycafe/
// clients/[id]/provision.ts) once staff are ready to hand them a device
// token — the two are deliberately different actions, same "payment
// happened" vs "the thing was actually set up" split the web_dev side
// already has between manual client entry and stage progression.
import type { StaffUser } from "../../../../_lib/roles";

interface Env {
  DB?: D1Database;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  if (!env.DB) return jsonResponse(500, { error: "Not configured" });

  const result = await env.DB.prepare(
    `SELECT id, full_name, business_name, email, mycafe_cafe_id, mycafe_status, created_at
     FROM clients WHERE product = 'mycafe_pos' ORDER BY created_at DESC LIMIT 200`,
  ).all<{
    id: string;
    full_name: string;
    business_name: string;
    email: string;
    mycafe_cafe_id: string | null;
    mycafe_status: string | null;
    created_at: string;
  }>();

  return jsonResponse(
    200,
    result.results.map((row) => ({
      id: row.id,
      fullName: row.full_name,
      businessName: row.business_name,
      email: row.email,
      mycafeCafeId: row.mycafe_cafe_id,
      mycafeStatus: row.mycafe_status,
      createdAt: row.created_at,
    })),
  );
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

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

  const fullName = typeof b.fullName === "string" ? b.fullName.trim() : "";
  const businessName = typeof b.businessName === "string" ? b.businessName.trim() : "";
  const email = typeof b.email === "string" ? b.email.trim() : "";
  const storeName = typeof b.storeName === "string" ? b.storeName.trim() : "";
  const slug = typeof b.slug === "string" ? b.slug.trim().toLowerCase() : "";

  if (!fullName) return jsonResponse(400, { error: "Owner name is required." });
  if (!businessName) return jsonResponse(400, { error: "Business name is required." });
  if (!email || !EMAIL_RE.test(email)) return jsonResponse(400, { error: "A valid email is required." });
  if (!storeName) return jsonResponse(400, { error: "Store name is required." });
  if (!slug || !SLUG_RE.test(slug)) {
    return jsonResponse(400, { error: "Slug must be lowercase letters, numbers, and hyphens only." });
  }

  const existing = await db.prepare(`SELECT id FROM clients WHERE LOWER(email) = LOWER(?)`).bind(email).first<{ id: string }>();
  if (existing) {
    return jsonResponse(409, { error: "A client with this email already exists.", clientId: existing.id });
  }

  const now = new Date().toISOString();
  const clientId = crypto.randomUUID();

  await db
    .prepare(
      `INSERT INTO clients (id, email, full_name, business_name, invitation_status, product, mycafe_slug, mycafe_store_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', 'mycafe_pos', ?, ?, ?, ?)`,
    )
    .bind(clientId, email, fullName, businessName, slug, storeName, now, now)
    .run();

  await db
    .prepare(
      `INSERT INTO client_activity (id, client_id, type, description, actor_id, created_at)
       VALUES (?, ?, 'manual_add', 'MyCafe client record added', ?, ?)`,
    )
    .bind(crypto.randomUUID(), clientId, data.staffUser.id, now)
    .run();

  await db
    .prepare(
      `INSERT INTO audit_log (id, actor_id, action, entity_type, entity_id, before, after, reason, created_at)
       VALUES (?, ?, 'mycafe_client_add', 'client', ?, NULL, ?, NULL, ?)`,
    )
    .bind(crypto.randomUUID(), data.staffUser.id, clientId, JSON.stringify({ email, fullName, businessName, slug }), now)
    .run();

  return jsonResponse(201, { id: clientId, createdAt: now });
};
