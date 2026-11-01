// Cloudflare Pages Function: POST /api/app/service-agreements/:agreementId/publish
//
// Cloned from the proposal generator's own publish endpoint
// (functions/api/app/proposals/[proposalId]/publish.ts), minus the
// payment_enabled/payment_amount_label check (service agreements have
// no payment-request feature). client_id is unconditionally present
// here (CLAUDE.md §30: a service agreement always belongs to a real
// client, unlike a proposal), so the client_activity write below is no
// longer guarded by an `if` -- there's no case where it would be
// missing. Snapshots the current draft buffer
// (title/content_html) into a new, immutable service_agreement_versions
// row and flips status to 'published' -- the client-facing page always
// renders the LATEST version, never the live draft directly, so staff
// can keep editing after publish without the client seeing
// half-finished changes until the next publish. Republishing a
// 'signed' agreement is the "material revision" path, same reasoning as
// the proposal generator: it resets status to 'published', leaving the
// prior service_agreement_signatures row untouched as the historical
// record of what was actually accepted before, and the client must
// sign again against the new version.

import type { StaffUser } from "../../../../_lib/roles";

interface Env {
  DB?: D1Database;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function normalizeParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0]! : value;
}

export const onRequestPost: PagesFunction<Env, "agreementId", { staffUser: StaffUser }> = async ({ env, params, data }) => {
  if (!env.DB) return jsonResponse(500, { error: "Not configured" });
  const db = env.DB;
  const agreementId = normalizeParam(params.agreementId);

  const agreement = await db
    .prepare(`SELECT id, client_id, title, content_html, status, current_version FROM service_agreements WHERE id = ?`)
    .bind(agreementId)
    .first<{ id: string; client_id: string; title: string; content_html: string; status: string; current_version: number }>();
  if (!agreement) return jsonResponse(404, { error: "Service agreement not found" });
  if (["expired", "revoked"].includes(agreement.status)) {
    return jsonResponse(409, { error: `Cannot publish a service agreement that is ${agreement.status}.` });
  }
  if (!agreement.content_html.trim()) return jsonResponse(400, { error: "Write the agreement content before publishing." });

  const now = new Date().toISOString();
  const versionNumber = agreement.current_version + 1;
  const versionId = crypto.randomUUID();
  const wasSigned = agreement.status === "signed";
  const newStatus = "published";

  await db
    .prepare(`INSERT INTO service_agreement_versions (id, service_agreement_id, version_number, title, content_html, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(versionId, agreementId, versionNumber, agreement.title, agreement.content_html, data.staffUser.id, now)
    .run();

  await db.prepare(`UPDATE service_agreements SET status = ?, current_version = ?, updated_at = ? WHERE id = ?`).bind(newStatus, versionNumber, now, agreementId).run();

  await db
    .prepare(`INSERT INTO client_activity (id, client_id, type, description, actor_id, created_at) VALUES (?, ?, 'service_agreement_published', ?, ?, ?)`)
    .bind(
      crypto.randomUUID(),
      agreement.client_id,
      wasSigned ? `Service agreement "${agreement.title}" revised (v${versionNumber}) -- client must re-sign` : `Service agreement "${agreement.title}" published (v${versionNumber})`,
      data.staffUser.id,
      now
    )
    .run();

  await db
    .prepare(`INSERT INTO audit_log (id, actor_id, action, entity_type, entity_id, before, after, reason, created_at) VALUES (?, ?, 'service_agreement_published', 'service_agreement', ?, ?, ?, NULL, ?)`)
    .bind(crypto.randomUUID(), data.staffUser.id, agreementId, JSON.stringify({ status: agreement.status }), JSON.stringify({ status: newStatus, versionNumber }), now)
    .run();

  return jsonResponse(200, { status: newStatus, versionNumber });
};
