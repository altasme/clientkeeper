// Cloudflare Pages Function: PUT /api/app/clients/:id/questionnaires/:questionnaireId/questions
//
// Replaces the entire live DRAFT question set (version_id IS NULL rows)
// in one atomic batch. The question-builder admin UI holds the full
// question list client-side (add/edit/delete/duplicate/reorder are all
// local array operations) and calls this once on "Save Draft" --
// simpler and less error-prone than five separate granular per-question
// endpoints, and mirrors Bill of Service's own line-item handling (the
// whole line-items array is sent together, not built up one call at a
// time). Never touches any already-published version's own frozen
// question rows (those carry a non-NULL version_id and are never
// selected by the DELETE below).

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

const FIELD_TYPES = ["short_text", "long_text", "single_choice", "multi_choice", "dropdown", "yes_no", "date", "url", "file"] as const;
type FieldType = (typeof FIELD_TYPES)[number];

interface QuestionInput {
  sectionHeading: string | null;
  sectionDescription: string | null;
  prompt: string;
  helpText: string | null;
  fieldType: FieldType;
  isRequired: boolean;
  options: string[];
}

export const onRequestPut: PagesFunction<Env, "id" | "questionnaireId", { staffUser: StaffUser }> = async ({ request, env, params }) => {
  if (!env.DB) return jsonResponse(500, { error: "Not configured" });
  const db = env.DB;
  const clientId = normalizeParam(params.id);
  const questionnaireId = normalizeParam(params.questionnaireId);

  const questionnaire = await db.prepare(`SELECT id FROM questionnaires WHERE id = ? AND client_id = ?`).bind(questionnaireId, clientId).first<{ id: string }>();
  if (!questionnaire) return jsonResponse(404, { error: "Questionnaire not found" });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "Invalid request body" });
  }
  const rawQuestions = Array.isArray((body as { questions?: unknown })?.questions) ? ((body as { questions: unknown[] }).questions) : null;
  if (!rawQuestions) return jsonResponse(400, { error: "questions must be an array." });

  const questions: QuestionInput[] = [];
  for (const raw of rawQuestions) {
    const q = raw as Record<string, unknown>;
    const prompt = typeof q.prompt === "string" ? q.prompt.trim() : "";
    const fieldType = typeof q.fieldType === "string" && (FIELD_TYPES as readonly string[]).includes(q.fieldType) ? (q.fieldType as FieldType) : null;
    if (!prompt) return jsonResponse(400, { error: "Every question needs a prompt." });
    if (!fieldType) return jsonResponse(400, { error: `Invalid field type${typeof q.fieldType === "string" ? `: ${q.fieldType}` : ""}.` });

    const options = Array.isArray(q.options) ? (q.options as unknown[]).filter((o): o is string => typeof o === "string" && o.trim().length > 0).map((o) => o.trim()) : [];
    if ((fieldType === "single_choice" || fieldType === "multi_choice" || fieldType === "dropdown") && options.length === 0) {
      return jsonResponse(400, { error: `"${prompt}" needs at least one option for its field type.` });
    }

    questions.push({
      sectionHeading: typeof q.sectionHeading === "string" && q.sectionHeading.trim() ? q.sectionHeading.trim() : null,
      sectionDescription: typeof q.sectionDescription === "string" && q.sectionDescription.trim() ? q.sectionDescription.trim() : null,
      prompt,
      helpText: typeof q.helpText === "string" && q.helpText.trim() ? q.helpText.trim() : null,
      fieldType,
      isRequired: q.isRequired === true,
      options,
    });
  }

  const now = new Date().toISOString();
  const statements = [
    db.prepare(`DELETE FROM questionnaire_questions WHERE questionnaire_id = ? AND version_id IS NULL`).bind(questionnaireId),
    ...questions.map((q, i) =>
      db
        .prepare(
          `INSERT INTO questionnaire_questions (id, questionnaire_id, version_id, section_heading, section_description, prompt, help_text, field_type, is_required, options_json, sort_order, created_at)
           VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(crypto.randomUUID(), questionnaireId, q.sectionHeading, q.sectionDescription, q.prompt, q.helpText, q.fieldType, q.isRequired ? 1 : 0, q.options.length ? JSON.stringify(q.options) : null, i, now)
    ),
  ];
  await db.batch(statements);

  return jsonResponse(200, { ok: true, count: questions.length });
};
