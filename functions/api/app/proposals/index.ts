// Cloudflare Pages Function: POST /api/app/proposals
//
// [2026-10-16] Creates a fully "standalone" proposal -- no lead, no
// client, nothing to nest it under (CLAUDE.md §26: "create a proposal
// even outside of a lead or client"). The sibling creation endpoints
// (/clients/:id/proposals, /leads/:id/proposals) stay parent-scoped
// since "all of this client's/lead's proposals" is a meaningful list;
// this one has no parent at all, so it lives at the flat root instead.
//
// Per the operator's own confirmed decision, the prospect's contact info
// (full name, business name, email, phone) is collected HERE, from
// staff, at creation time -- not from the public signer later. It's
// stored on the proposal's own prospect_* columns and is read by
// altaventureswebsite's public sign endpoint
// (functions/api/public/proposal/[slug]/sign.ts) to auto-create a real
// `clients` row the moment this specific proposal is signed. Email/full
// name/business name are required here precisely because the `clients`
// table requires all three -- collecting them upfront is what makes that
// later auto-creation possible at all.

import { generateUniqueSlugAndToken } from "../../../_lib/publicDocs";
import type { StaffUser } from "../../../_lib/roles";

interface Env {
  DB?: D1Database;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  const prospectEmail = typeof b.prospectEmail === "string" ? b.prospectEmail.trim() : "";
  const prospectPhone = typeof b.prospectPhone === "string" && b.prospectPhone.trim() ? b.prospectPhone.trim() : null;

  if (!prospectFullName) return jsonResponse(400, { error: "The prospect's name is required." });
  if (!prospectBusinessName) return jsonResponse(400, { error: "The prospect's business name is required." });
  if (!prospectEmail || !EMAIL_RE.test(prospectEmail)) return jsonResponse(400, { error: "A valid email is required -- it's what lets us create a client record once this is signed." });

  const title = typeof b.title === "string" && b.title.trim() ? b.title.trim() : `Proposal for ${prospectBusinessName}`;

  const { slug, accessToken } = await generateUniqueSlugAndToken(db, "proposals", prospectBusinessName);

  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  await db
    .prepare(
      `INSERT INTO proposals (id, client_id, lead_id, prospect_full_name, prospect_business_name, prospect_email, prospect_phone, slug, access_token, title, content_html, status, current_version, created_by, created_at, updated_at)
       VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, '', 'draft', 0, ?, ?, ?)`
    )
    .bind(id, prospectFullName, prospectBusinessName, prospectEmail, prospectPhone, slug, accessToken, title, data.staffUser.id, now, now)
    .run();

  await db
    .prepare(`INSERT INTO audit_log (id, actor_id, action, entity_type, entity_id, before, after, reason, created_at) VALUES (?, ?, 'proposal_created', 'proposal', ?, NULL, ?, NULL, ?)`)
    .bind(crypto.randomUUID(), data.staffUser.id, id, JSON.stringify({ title, prospectFullName, prospectBusinessName, prospectEmail }), now)
    .run();

  return jsonResponse(201, { id, slug, title, status: "draft" });
};
