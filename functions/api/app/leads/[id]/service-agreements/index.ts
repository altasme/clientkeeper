// Cloudflare Pages Function: GET/POST /api/app/leads/:id/service-agreements
//
// The lead-scoped sibling of
// /clients/:id/service-agreements/index.ts, so a service agreement can
// be sent to a prospect who isn't a client yet -- cloned from the
// proposal generator's own identical lead-scoped endpoint
// (functions/api/app/leads/[id]/proposals/index.ts). Mirrors that
// file's shape closely -- same slug/token generation, same audit_log
// write -- but inserts with lead_id set and client_id NULL, and skips
// the client_activity write entirely: leads have no equivalent activity
// timeline in this schema, so there's nowhere to log it except the
// global audit_log, which this already writes.

import { generateUniqueSlugAndToken } from "../../../../../_lib/publicDocs";
import type { StaffUser } from "../../../../../_lib/roles";

interface Env {
  DB?: D1Database;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function normalizeParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0]! : value;
}

interface AgreementListRow {
  id: string;
  slug: string;
  access_token: string;
  title: string;
  status: string;
  current_version: number;
  created_at: string;
  updated_at: string;
}

export const onRequestGet: PagesFunction<Env, "id"> = async ({ env, params }) => {
  if (!env.DB) return jsonResponse(500, { error: "Not configured" });
  const leadId = normalizeParam(params.id);

  const result = await env.DB.prepare(
    `SELECT id, slug, access_token, title, status, current_version, created_at, updated_at
     FROM service_agreements WHERE lead_id = ? ORDER BY created_at DESC`
  )
    .bind(leadId)
    .all<AgreementListRow>();

  return jsonResponse(
    200,
    result.results.map((row) => ({
      id: row.id,
      slug: row.slug,
      publicUrl: `https://www.altasme.com/agreement/${row.slug}?t=${row.access_token}`,
      title: row.title,
      status: row.status,
      currentVersion: row.current_version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  );
};

export const onRequestPost: PagesFunction<Env, "id", { staffUser: StaffUser }> = async ({ request, env, params, data }) => {
  if (!env.DB) return jsonResponse(500, { error: "Not configured" });
  const db = env.DB;
  const leadId = normalizeParam(params.id);

  const lead = await db.prepare(`SELECT id, full_name, business_name FROM leads WHERE id = ?`).bind(leadId).first<{ id: string; full_name: string | null; business_name: string | null }>();
  if (!lead) return jsonResponse(404, { error: "Lead not found" });

  const displayName = lead.business_name || lead.full_name || "Prospect";

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "Invalid request body" });
  }
  const b = body as Record<string, unknown>;
  const title = typeof b.title === "string" && b.title.trim() ? b.title.trim() : `Service Agreement for ${displayName}`;

  const { slug, accessToken } = await generateUniqueSlugAndToken(db, "service_agreements", displayName);

  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  await db
    .prepare(
      `INSERT INTO service_agreements (id, lead_id, slug, access_token, title, content_html, status, current_version, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '', 'draft', 0, ?, ?, ?)`
    )
    .bind(id, leadId, slug, accessToken, title, data.staffUser.id, now, now)
    .run();

  await db
    .prepare(`INSERT INTO audit_log (id, actor_id, action, entity_type, entity_id, before, after, reason, created_at) VALUES (?, ?, 'service_agreement_created', 'service_agreement', ?, NULL, ?, NULL, ?)`)
    .bind(crypto.randomUUID(), data.staffUser.id, id, JSON.stringify({ title, leadId }), now)
    .run();

  return jsonResponse(201, { id, slug, title, status: "draft" });
};
