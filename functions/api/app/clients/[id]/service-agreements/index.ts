// Cloudflare Pages Function: GET/POST /api/app/clients/:id/service-agreements
//
// Service Agreement Generator (CLAUDE.md §29), cloned from the proposal
// generator's own client-nested endpoint
// (functions/api/app/clients/[id]/proposals/index.ts). Creating an
// agreement is a plain D1 write, no third-party credentials needed. The
// public, client-facing viewing/signing page is served by the marketing
// site (altasme/altaventureswebsite) at www.altasme.com/agreement/:slug,
// reading the same shared D1 database directly.

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
  const clientId = normalizeParam(params.id);

  const result = await env.DB.prepare(
    `SELECT id, slug, access_token, title, status, current_version, created_at, updated_at
     FROM service_agreements WHERE client_id = ? ORDER BY created_at DESC`
  )
    .bind(clientId)
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
  const clientId = normalizeParam(params.id);

  const client = await db.prepare(`SELECT id, business_name FROM clients WHERE id = ?`).bind(clientId).first<{ id: string; business_name: string }>();
  if (!client) return jsonResponse(404, { error: "Client not found" });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "Invalid request body" });
  }
  const b = body as Record<string, unknown>;
  const title = typeof b.title === "string" && b.title.trim() ? b.title.trim() : `Service Agreement for ${client.business_name}`;

  const { slug, accessToken } = await generateUniqueSlugAndToken(db, "service_agreements", client.business_name);

  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  await db
    .prepare(
      `INSERT INTO service_agreements (id, client_id, slug, access_token, title, content_html, status, current_version, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '', 'draft', 0, ?, ?, ?)`
    )
    .bind(id, clientId, slug, accessToken, title, data.staffUser.id, now, now)
    .run();

  await db
    .prepare(`INSERT INTO client_activity (id, client_id, type, description, actor_id, created_at) VALUES (?, ?, 'service_agreement_created', ?, ?, ?)`)
    .bind(crypto.randomUUID(), clientId, `Service agreement "${title}" created`, data.staffUser.id, now)
    .run();

  await db
    .prepare(`INSERT INTO audit_log (id, actor_id, action, entity_type, entity_id, before, after, reason, created_at) VALUES (?, ?, 'service_agreement_created', 'service_agreement', ?, NULL, ?, NULL, ?)`)
    .bind(crypto.randomUUID(), data.staffUser.id, id, JSON.stringify({ title, clientId }), now)
    .run();

  return jsonResponse(201, { id, slug, title, status: "draft" });
};
