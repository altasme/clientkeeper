// Cloudflare Pages Function: GET/POST /api/app/service-agreements
//
// Service Agreement Generator (CLAUDE.md §29), a direct clone of the
// standalone Proposal Generator's own root endpoint
// (functions/api/app/proposals/index.ts) -- same shape, same "a fully
// standalone agreement, no lead, no client" mechanics (CLAUDE.md §26's
// "create a proposal even outside of a lead or client" decision, now
// applied to service agreements too). The sibling creation endpoints
// (/clients/:id/service-agreements, /leads/:id/service-agreements) stay
// parent-scoped since "all of this client's/lead's agreements" is a
// meaningful list; this one has no parent at all, so it lives at the
// flat root instead.
//
// The prospect's contact info (full name, business name, email, phone)
// is collected HERE, from staff, at creation time -- not from the
// public signer later. It's stored on the agreement's own prospect_*
// columns and is read by altaventureswebsite's public sign endpoint
// (functions/api/public/agreement/[slug]/sign.ts) to auto-create a real
// `clients` row the moment this specific agreement is signed. Email is
// optional, same reasoning as the proposal generator's identical field:
// full name and business name are the only hard requirements, since
// there's no agreement without a "who is this for" -- a real client
// just won't be auto-created on signing without one.

import { generateUniqueSlugAndToken } from "../../../_lib/publicDocs";
import type { StaffUser } from "../../../_lib/roles";

interface Env {
  DB?: D1Database;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Lists standalone service agreements (client_id AND lead_id both NULL)
// only -- a client- or lead-backed agreement already has a real home
// (its parent's detail page lists it via GET
// /api/app/{clients,leads}/:id/service-agreements), so including those
// here too would just duplicate that listing under a second,
// inconsistent one. Same q/status filtering shape as GET
// /api/app/proposals.
export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return jsonResponse(500, { error: "Not configured" });
  const db = env.DB;

  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim();
  const status = url.searchParams.get("status")?.trim();

  const conditions: string[] = ["client_id IS NULL", "lead_id IS NULL"];
  const params: unknown[] = [];

  if (q) {
    conditions.push(`(prospect_full_name LIKE ? OR prospect_business_name LIKE ? OR prospect_email LIKE ?)`);
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  if (status) {
    conditions.push(`status = ?`);
    params.push(status);
  }

  const result = await db
    .prepare(
      `SELECT id, slug, access_token, title, status, prospect_full_name, prospect_business_name, prospect_email, prospect_phone, created_at, updated_at
       FROM service_agreements WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT 200`
    )
    .bind(...params)
    .all();

  return jsonResponse(200, result.results);
};

export const onRequestPost: PagesFunction<Env, never, { staffUser: StaffUser }> = async ({ request, env, data }) => {
  if (!env.DB) return jsonResponse(500, { error: "Not configured" });
  const db = env.DB;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "Invalid request body" });
  }
  const b = body as Record<string, unknown>;

  const prospectFullName = typeof b.prospectFullName === "string" ? b.prospectFullName.trim() : "";
  const prospectBusinessName = typeof b.prospectBusinessName === "string" ? b.prospectBusinessName.trim() : "";
  const prospectEmailRaw = typeof b.prospectEmail === "string" ? b.prospectEmail.trim() : "";
  const prospectPhone = typeof b.prospectPhone === "string" && b.prospectPhone.trim() ? b.prospectPhone.trim() : null;

  if (!prospectFullName) return jsonResponse(400, { error: "The prospect's name is required." });
  if (!prospectBusinessName) return jsonResponse(400, { error: "The prospect's business name is required." });
  if (prospectEmailRaw && !EMAIL_RE.test(prospectEmailRaw)) return jsonResponse(400, { error: "That doesn't look like a valid email -- leave it blank if you don't have one yet." });
  const prospectEmail = prospectEmailRaw || null;

  const title = typeof b.title === "string" && b.title.trim() ? b.title.trim() : `Service Agreement for ${prospectBusinessName}`;

  const { slug, accessToken } = await generateUniqueSlugAndToken(db, "service_agreements", prospectBusinessName);

  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  await db
    .prepare(
      `INSERT INTO service_agreements (id, client_id, lead_id, prospect_full_name, prospect_business_name, prospect_email, prospect_phone, slug, access_token, title, content_html, status, current_version, created_by, created_at, updated_at)
       VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, '', 'draft', 0, ?, ?, ?)`
    )
    .bind(id, prospectFullName, prospectBusinessName, prospectEmail, prospectPhone, slug, accessToken, title, data.staffUser.id, now, now)
    .run();

  await db
    .prepare(`INSERT INTO audit_log (id, actor_id, action, entity_type, entity_id, before, after, reason, created_at) VALUES (?, ?, 'service_agreement_created', 'service_agreement', ?, NULL, ?, NULL, ?)`)
    .bind(crypto.randomUUID(), data.staffUser.id, id, JSON.stringify({ title, prospectFullName, prospectBusinessName, prospectEmail }), now)
    .run();

  return jsonResponse(201, { id, slug, title, status: "draft" });
};
