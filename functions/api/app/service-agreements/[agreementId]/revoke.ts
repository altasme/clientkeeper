// Cloudflare Pages Function: POST /api/app/service-agreements/:agreementId/revoke
//
// Cloned from the proposal generator's own revoke endpoint
// (functions/api/app/proposals/[proposalId]/revoke.ts). Revokes access
// to an agreement's public link without deleting any record. The public
// page checks status directly and refuses to render a revoked
// agreement's content or accept a signature against it.

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

  const agreement = await db.prepare(`SELECT id, client_id, title, status FROM service_agreements WHERE id = ?`).bind(agreementId).first<{ id: string; client_id: string | null; title: string; status: string }>();
  if (!agreement) return jsonResponse(404, { error: "Service agreement not found" });
  if (agreement.status === "revoked") return jsonResponse(409, { error: "Already revoked." });

  const now = new Date().toISOString();
  await db.prepare(`UPDATE service_agreements SET status = 'revoked', updated_at = ? WHERE id = ?`).bind(now, agreementId).run();

  if (agreement.client_id) {
    await db
      .prepare(`INSERT INTO client_activity (id, client_id, type, description, actor_id, created_at) VALUES (?, ?, 'service_agreement_revoked', ?, ?, ?)`)
      .bind(crypto.randomUUID(), agreement.client_id, `Service agreement "${agreement.title}" link revoked`, data.staffUser.id, now)
      .run();
  }

  await db
    .prepare(`INSERT INTO audit_log (id, actor_id, action, entity_type, entity_id, before, after, reason, created_at) VALUES (?, ?, 'service_agreement_revoked', 'service_agreement', ?, ?, ?, NULL, ?)`)
    .bind(crypto.randomUUID(), data.staffUser.id, agreementId, JSON.stringify({ status: agreement.status }), JSON.stringify({ status: "revoked" }), now)
    .run();

  return jsonResponse(200, { ok: true });
};
