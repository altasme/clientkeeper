// Cloudflare Pages Function: POST /api/app/clients/:id/proposals/:proposalId/publish
//
// Snapshots the current draft buffer (proposals.title/content_html) into
// a new, immutable proposal_versions row and flips status to
// 'published' -- the client-facing page always renders the LATEST
// version, never the live draft directly, so an admin can keep editing
// after publish without the client seeing half-finished changes until
// the next publish. Republishing a 'signed' proposal is the documented
// "material revision" path (CLAUDEproposalquestionnaire.md's "do not
// allow published or signed proposals to be silently modified...
// require a new acceptance"): it resets status to 'published', leaving
// the prior proposal_signatures row untouched as the historical record
// of what was actually accepted before, and the client must sign again
// against the new version.

import type { StaffUser } from "../../../../../../_lib/roles";

interface Env {
  DB?: D1Database;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function normalizeParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0]! : value;
}

export const onRequestPost: PagesFunction<Env, "id" | "proposalId", { staffUser: StaffUser }> = async ({ env, params, data }) => {
  if (!env.DB) return jsonResponse(500, { error: "Not configured" });
  const db = env.DB;
  const clientId = normalizeParam(params.id);
  const proposalId = normalizeParam(params.proposalId);

  const proposal = await db
    .prepare(`SELECT id, title, content_html, status, current_version FROM proposals WHERE id = ? AND client_id = ?`)
    .bind(proposalId, clientId)
    .first<{ id: string; title: string; content_html: string; status: string; current_version: number }>();
  if (!proposal) return jsonResponse(404, { error: "Proposal not found" });
  if (["expired", "revoked"].includes(proposal.status)) {
    return jsonResponse(409, { error: `Cannot publish a proposal that is ${proposal.status}.` });
  }
  if (!proposal.content_html.trim()) return jsonResponse(400, { error: "Write the proposal content before publishing." });

  const now = new Date().toISOString();
  const versionNumber = proposal.current_version + 1;
  const versionId = crypto.randomUUID();
  const wasSigned = proposal.status === "signed";
  const newStatus = "published";

  await db
    .prepare(`INSERT INTO proposal_versions (id, proposal_id, version_number, title, content_html, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(versionId, proposalId, versionNumber, proposal.title, proposal.content_html, data.staffUser.id, now)
    .run();

  await db
    .prepare(`UPDATE proposals SET status = ?, current_version = ?, updated_at = ? WHERE id = ?`)
    .bind(newStatus, versionNumber, now, proposalId)
    .run();

  await db
    .prepare(`INSERT INTO client_activity (id, client_id, type, description, actor_id, created_at) VALUES (?, ?, 'proposal_published', ?, ?, ?)`)
    .bind(
      crypto.randomUUID(),
      clientId,
      wasSigned ? `Proposal "${proposal.title}" revised (v${versionNumber}) -- client must re-sign` : `Proposal "${proposal.title}" published (v${versionNumber})`,
      data.staffUser.id,
      now
    )
    .run();

  await db
    .prepare(`INSERT INTO audit_log (id, actor_id, action, entity_type, entity_id, before, after, reason, created_at) VALUES (?, ?, 'proposal_published', 'proposal', ?, ?, ?, NULL, ?)`)
    .bind(crypto.randomUUID(), data.staffUser.id, proposalId, JSON.stringify({ status: proposal.status }), JSON.stringify({ status: newStatus, versionNumber }), now)
    .run();

  return jsonResponse(200, { status: newStatus, versionNumber });
};
