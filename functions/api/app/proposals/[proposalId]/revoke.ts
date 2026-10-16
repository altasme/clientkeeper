// Cloudflare Pages Function: POST /api/app/proposals/:proposalId/revoke
//
// [2026-10-15] Flattened out of /clients/:id/proposals/:proposalId/
// revoke, same reasoning as the sibling detail/publish endpoints (a
// proposal can now belong to a client or a lead, CLAUDE.md §25). The
// client_activity write is skipped when the proposal has no client_id.
//
// Revokes access to a proposal's public link without deleting any
// record (CLAUDEproposalquestionnaire.md's "support revoking or
// expiring access links without deleting the associated records"). The
// public page checks status directly and refuses to render a revoked
// proposal's content or accept a signature against it.

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

export const onRequestPost: PagesFunction<Env, "proposalId", { staffUser: StaffUser }> = async ({ env, params, data }) => {
  if (!env.DB) return jsonResponse(500, { error: "Not configured" });
  const db = env.DB;
  const proposalId = normalizeParam(params.proposalId);

  const proposal = await db.prepare(`SELECT id, client_id, title, status FROM proposals WHERE id = ?`).bind(proposalId).first<{ id: string; client_id: string | null; title: string; status: string }>();
  if (!proposal) return jsonResponse(404, { error: "Proposal not found" });
  if (proposal.status === "revoked") return jsonResponse(409, { error: "Already revoked." });

  const now = new Date().toISOString();
  await db.prepare(`UPDATE proposals SET status = 'revoked', updated_at = ? WHERE id = ?`).bind(now, proposalId).run();

  if (proposal.client_id) {
    await db
      .prepare(`INSERT INTO client_activity (id, client_id, type, description, actor_id, created_at) VALUES (?, ?, 'proposal_revoked', ?, ?, ?)`)
      .bind(crypto.randomUUID(), proposal.client_id, `Proposal "${proposal.title}" link revoked`, data.staffUser.id, now)
      .run();
  }

  await db
    .prepare(`INSERT INTO audit_log (id, actor_id, action, entity_type, entity_id, before, after, reason, created_at) VALUES (?, ?, 'proposal_revoked', 'proposal', ?, ?, ?, NULL, ?)`)
    .bind(crypto.randomUUID(), data.staffUser.id, proposalId, JSON.stringify({ status: proposal.status }), JSON.stringify({ status: "revoked" }), now)
    .run();

  return jsonResponse(200, { ok: true });
};
