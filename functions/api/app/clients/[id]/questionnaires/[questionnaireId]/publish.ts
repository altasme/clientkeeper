// Cloudflare Pages Function: POST /api/app/clients/:id/questionnaires/:questionnaireId/publish
//
// Snapshots the current draft (title/description + every draft question
// row) into a new immutable questionnaire_versions + frozen
// questionnaire_questions copies, and flips status to 'published' (or
// leaves it 'submitted'/'closed' alone if a response already exists --
// republishing just makes a newer version available for the NEXT
// response, it doesn't revive a closed link).

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
    .prepare(`SELECT id, title, description, status, current_version FROM questionnaires WHERE id = ? AND client_id = ?`)
    .bind(questionnaireId, clientId)
    .first<{ id: string; title: string; description: string | null; status: string; current_version: number }>();
  if (!questionnaire) return jsonResponse(404, { error: "Questionnaire not found" });
  if (questionnaire.status === "closed") return jsonResponse(409, { error: "This questionnaire's link has been closed/revoked." });

  const draftQuestions = await db
    .prepare(
      `SELECT id, section_heading, section_description, prompt, help_text, field_type, is_required, options_json, sort_order
       FROM questionnaire_questions WHERE questionnaire_id = ? AND version_id IS NULL ORDER BY sort_order ASC`
    )
    .bind(questionnaireId)
    .all<{
      id: string;
      section_heading: string | null;
      section_description: string | null;
      prompt: string;
      help_text: string | null;
      field_type: string;
      is_required: number;
      options_json: string | null;
      sort_order: number;
    }>();
  if (draftQuestions.results.length === 0) return jsonResponse(400, { error: "Add at least one question before publishing." });

  const now = new Date().toISOString();
  const versionNumber = questionnaire.current_version + 1;
  const versionId = crypto.randomUUID();

  const statements = [
    db
      .prepare(`INSERT INTO questionnaire_versions (id, questionnaire_id, version_number, title, description, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(versionId, questionnaireId, versionNumber, questionnaire.title, questionnaire.description, data.staffUser.id, now),
    ...draftQuestions.results.map((q) =>
      db
        .prepare(
          `INSERT INTO questionnaire_questions (id, questionnaire_id, version_id, section_heading, section_description, prompt, help_text, field_type, is_required, options_json, sort_order, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(crypto.randomUUID(), questionnaireId, versionId, q.section_heading, q.section_description, q.prompt, q.help_text, q.field_type, q.is_required, q.options_json, q.sort_order, now)
    ),
    db
      .prepare(`UPDATE questionnaires SET status = CASE WHEN status = 'draft' THEN 'published' ELSE status END, current_version = ?, updated_at = ? WHERE id = ?`)
      .bind(versionNumber, now, questionnaireId),
  ];
  await db.batch(statements);

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
