// Cloudflare Pages Function: POST /api/app/clients/:id/questionnaires/:questionnaireId/revoke

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

export const onRequestPost: PagesFunction<Env, "id" | "questionnaireId", { staffUser: StaffUser }> = async ({ env, params, data }) => {
  if (!env.DB) return jsonResponse(500, { error: "Not configured" });
  const db = env.DB;
  const clientId = normalizeParam(params.id);
  const questionnaireId = normalizeParam(params.questionnaireId);

  const questionnaire = await db.prepare(`SELECT id, title, status FROM questionnaires WHERE id = ? AND client_id = ?`).bind(questionnaireId, clientId).first<{ id: string; title: string; status: string }>();
  if (!questionnaire) return jsonResponse(404, { error: "Questionnaire not found" });
  if (questionnaire.status === "closed") return jsonResponse(409, { error: "Already closed." });

  const now = new Date().toISOString();
  await db.prepare(`UPDATE questionnaires SET status = 'closed', updated_at = ? WHERE id = ?`).bind(now, questionnaireId).run();

  await db
    .prepare(`INSERT INTO client_activity (id, client_id, type, description, actor_id, created_at) VALUES (?, ?, 'questionnaire_closed', ?, ?, ?)`)
    .bind(crypto.randomUUID(), clientId, `Questionnaire "${questionnaire.title}" link closed`, data.staffUser.id, now)
    .run();

  await db
    .prepare(`INSERT INTO audit_log (id, actor_id, action, entity_type, entity_id, before, after, reason, created_at) VALUES (?, ?, 'questionnaire_closed', 'questionnaire', ?, ?, ?, NULL, ?)`)
    .bind(crypto.randomUUID(), data.staffUser.id, questionnaireId, JSON.stringify({ status: questionnaire.status }), JSON.stringify({ status: "closed" }), now)
    .run();

  return jsonResponse(200, { ok: true });
};
