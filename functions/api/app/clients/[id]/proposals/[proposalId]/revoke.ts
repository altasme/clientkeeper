// Cloudflare Pages Function: POST /api/app/clients/:id/proposals/:proposalId/revoke
//
// Revokes access to a proposal's public link without deleting any
// record (CLAUDEproposalquestionnaire.md's "support revoking or
// expiring access links without deleting the associated records"). The
// public page checks status directly and refuses to render a revoked
// proposal's content or accept a signature against it.

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

  const proposal = await db.prepare(`SELECT id, title, status FROM proposals WHERE id = ? AND client_id = ?`).bind(proposalId, clientId).first<{ id: string; title: string; status: string }>();
  if (!proposal) return jsonResponse(404, { error: "Proposal not found" });
  if (proposal.status === "revoked") return jsonResponse(409, { error: "Already revoked." });

  const now = new Date().toISOString();
  await db.prepare(`UPDATE proposals SET status = 'revoked', updated_at = ? WHERE id = ?`).bind(now, proposalId).run();

  await db
    .prepare(`INSERT INTO client_activity (id, client_id, type, description, actor_id, created_at) VALUES (?, ?, 'proposal_revoked', ?, ?, ?)`)
    .bind(crypto.randomUUID(), clientId, `Proposal "${proposal.title}" link revoked`, data.staffUser.id, now)
    .run();

  await db
    .prepare(`INSERT INTO audit_log (id, actor_id, action, entity_type, entity_id, before, after, reason, created_at) VALUES (?, ?, 'proposal_revoked', 'proposal', ?, ?, ?, NULL, ?)`)
    .bind(crypto.randomUUID(), data.staffUser.id, proposalId, JSON.stringify({ status: proposal.status }), JSON.stringify({ status: "revoked" }), now)
    .run();

  return jsonResponse(200, { ok: true });
};
