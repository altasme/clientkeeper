// Cloudflare Pages Function: GET /api/app/clients
//
// List/search clients for the Clients nav page. Query params (all
// optional): `q` (matches full_name/business_name/email), `stage`
// (filters by the client's current project stage), `paidNoAccount=1`
// (invitation_status != 'accepted' — CLAUDE.md §2's "paid, no account yet"
// list; surfaced as a filter on this same page rather than a separate nav
// item, since it's the same underlying client record set).
//
// POST /api/app/clients — manual client entry (CLAUDE.md §11): staff can
// add a client record directly instead of only ever getting one from
// clienthub's ganap.net webhook. For an existing client who paid outside
// ganap (bank transfer, cash, a comp) or a legacy client being backfilled
// into the system at whatever stage they're actually already at.

import { FORWARD_SEQUENCE, TERMINAL_STAGES } from "../../../_lib/stages";
import type { StaffUser } from "../../../_lib/roles";

const VALID_STAGES: readonly string[] = [...FORWARD_SEQUENCE, ...TERMINAL_STAGES];

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
  const stage = url.searchParams.get("stage")?.trim();
  const paidNoAccount = url.searchParams.get("paidNoAccount") === "1";

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (q) {
    conditions.push(`(c.full_name LIKE ? OR c.business_name LIKE ? OR c.email LIKE ?)`);
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  if (stage) {
    conditions.push(`p.stage = ?`);
    params.push(stage);
  }
  if (paidNoAccount) {
    conditions.push(`c.invitation_status != 'accepted'`);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const result = await db
    .prepare(
      `SELECT c.id, c.full_name, c.business_name, c.email, c.invitation_status, c.created_at,
              p.id AS project_id, p.stage, p.updated_at
       FROM clients c
       LEFT JOIN projects p ON p.client_id = c.id
       ${whereClause}
       ORDER BY COALESCE(p.updated_at, c.created_at) DESC
       LIMIT 200`
    )
    .bind(...params)
    .all<{
      id: string;
      full_name: string;
      business_name: string;
      email: string;
      invitation_status: string;
      created_at: string;
      project_id: string | null;
      stage: string | null;
      updated_at: string | null;
    }>();

  return jsonResponse(
    200,
    result.results.map((row) => ({
      id: row.id,
      fullName: row.full_name,
      businessName: row.business_name,
      email: row.email,
      invitationStatus: row.invitation_status,
      createdAt: row.created_at,
      projectId: row.project_id,
      stage: row.stage,
      updatedAt: row.updated_at,
    }))
  );
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  const mobile = typeof b.mobile === "string" ? b.mobile.trim() : "";
  const facebook = typeof b.facebook === "string" ? b.facebook.trim() : "";
  const currentWebsite = typeof b.currentWebsite === "string" ? b.currentWebsite.trim() : "";
  const initialStage = typeof b.initialStage === "string" && b.initialStage.trim() ? b.initialStage.trim() : "payment_received";

  if (!fullName) return jsonResponse(400, { error: "Client name is required." });
  if (!businessName) return jsonResponse(400, { error: "Business name is required." });
  if (!email || !EMAIL_RE.test(email)) return jsonResponse(400, { error: "A valid email is required." });
  if (!VALID_STAGES.includes(initialStage)) return jsonResponse(400, { error: "Unknown stage." });

  const existing = await db.prepare(`SELECT id FROM clients WHERE LOWER(email) = LOWER(?)`).bind(email).first<{ id: string }>();
  if (existing) {
    return jsonResponse(409, { error: "A client with this email already exists.", clientId: existing.id });
  }

  const now = new Date().toISOString();
  const clientId = crypto.randomUUID();
  const projectId = crypto.randomUUID();

  await db
    .prepare(
      `INSERT INTO clients (id, email, full_name, business_name, mobile, facebook, current_website, invitation_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
    )
    .bind(clientId, email, fullName, businessName, mobile || null, facebook || null, currentWebsite || null, now, now)
    .run();

  await db
    .prepare(`INSERT INTO projects (id, client_id, stage, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(projectId, clientId, initialStage, now, now)
    .run();

  await db
    .prepare(
      `INSERT INTO stage_history (id, project_id, from_stage, to_stage, actor_id, reason, created_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?)`
    )
    .bind(crypto.randomUUID(), projectId, initialStage, data.staffUser.id, "Client added manually", now)
    .run();

  await db
    .prepare(
      `INSERT INTO client_activity (id, client_id, type, description, actor_id, created_at)
       VALUES (?, ?, 'manual_add', 'Client record added manually by staff', ?, ?)`
    )
    .bind(crypto.randomUUID(), clientId, data.staffUser.id, now)
    .run();

  await db
    .prepare(
      `INSERT INTO audit_log (id, actor_id, action, entity_type, entity_id, before, after, reason, created_at)
       VALUES (?, ?, 'manual_client_add', 'client', ?, NULL, ?, NULL, ?)`
    )
    .bind(crypto.randomUUID(), data.staffUser.id, clientId, JSON.stringify({ email, fullName, businessName, initialStage }), now)
    .run();

  return jsonResponse(201, { id: clientId, projectId, createdAt: now });
};
