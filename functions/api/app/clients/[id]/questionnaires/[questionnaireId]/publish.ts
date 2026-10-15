// Cloudflare Pages Function: POST /api/app/clients/:id/questionnaires/:questionnaireId/publish
//
// Snapshots the current draft buffer (title/content_html) into a new
// immutable questionnaire_versions row and flips status to 'published'
// (or leaves it 'submitted'/'closed' alone -- republishing just makes a
// newer version available for the NEXT response, it doesn't revive a
// closed link or un-submit an already-submitted one). Mirrors proposals'
// own publish.ts exactly, since questionnaires are now the same
// free-text-content model (CLAUDE.md's 2026-10-15 redesign).

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

  const questionnaire = await db
    .prepare(`SELECT id, title, content_html, status, current_version FROM questionnaires WHERE id = ? AND client_id = ?`)
    .bind(questionnaireId, clientId)
    .first<{ id: string; title: string; content_html: string; status: string; current_version: number }>();
  if (!questionnaire) return jsonResponse(404, { error: "Questionnaire not found" });
  if (questionnaire.status === "closed") return jsonResponse(409, { error: "This questionnaire's link has been closed/revoked." });
  if (!questionnaire.content_html.trim()) return jsonResponse(400, { error: "Write the questionnaire content before publishing." });

  const now = new Date().toISOString();
  const versionNumber = questionnaire.current_version + 1;
  const versionId = crypto.randomUUID();

  await db
    .prepare(`INSERT INTO questionnaire_versions (id, questionnaire_id, version_number, title, content_html, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(versionId, questionnaireId, versionNumber, questionnaire.title, questionnaire.content_html, data.staffUser.id, now)
    .run();

  await db
    .prepare(`UPDATE questionnaires SET status = CASE WHEN status = 'draft' THEN 'published' ELSE status END, current_version = ?, updated_at = ? WHERE id = ?`)
    .bind(versionNumber, now, questionnaireId)
    .run();

  await db
    .prepare(`INSERT INTO client_activity (id, client_id, type, description, actor_id, created_at) VALUES (?, ?, 'questionnaire_published', ?, ?, ?)`)
    .bind(crypto.randomUUID(), clientId, `Questionnaire "${questionnaire.title}" published (v${versionNumber})`, data.staffUser.id, now)
    .run();

  await db
    .prepare(`INSERT INTO audit_log (id, actor_id, action, entity_type, entity_id, before, after, reason, created_at) VALUES (?, ?, 'questionnaire_published', 'questionnaire', ?, ?, ?, NULL, ?)`)
    .bind(crypto.randomUUID(), data.staffUser.id, questionnaireId, JSON.stringify({ status: questionnaire.status }), JSON.stringify({ versionNumber }), now)
    .run();

  return jsonResponse(200, { status: questionnaire.status === "draft" ? "published" : questionnaire.status, versionNumber });
};
