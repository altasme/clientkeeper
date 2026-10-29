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
// `clients` row the moment this specific proposal is signed.
//
// [2026-10-29] Email is optional, per the operator's direct request --
// full name and business name stay required (there's no proposal
// without a "who is this for"), but not every prospect has a verified
// email on hand yet. The real, documented consequence: the `clients`
// table requires email NOT NULL (clienthub's d1/schema.sql), and
// sign.ts's auto-create-client logic already only fires when email is
// present (it was already written defensively this way before this
// change). So a proposal created without an email still signs fine --
// it just never auto-creates a client record. Staff can add the email
// later by discarding this proposal and creating a fresh one with it
// filled in (there's no PATCH for prospect_* fields -- see sign.ts's own
// comment on why), or by creating the client manually once the real
// email is known.

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
  const prospectEmailRaw = typeof b.prospectEmail === "string" ? b.prospectEmail.trim() : "";
  const prospectPhone = typeof b.prospectPhone === "string" && b.prospectPhone.trim() ? b.prospectPhone.trim() : null;

  if (!prospectFullName) return jsonResponse(400, { error: "The prospect's name is required." });
  if (!prospectBusinessName) return jsonResponse(400, { error: "The prospect's business name is required." });
  // Email is optional (see the header comment above), but if one IS
  // given it still has to be a real address -- a garbled value stored
  // now would otherwise silently become a garbled `clients.email` later.
  if (prospectEmailRaw && !EMAIL_RE.test(prospectEmailRaw)) return jsonResponse(400, { error: "That doesn't look like a valid email -- leave it blank if you don't have one yet." });
  const prospectEmail = prospectEmailRaw || null;

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
