// Cloudflare Pages Function: GET/PATCH /api/app/clients/:id/questionnaires/:questionnaireId
//
// GET returns the draft buffer (title/description), the live draft
// question set (version_id IS NULL -- see d1/schema.sql), every
// published version's own frozen question set, and response count.
// PATCH updates only the draft title/description; editing is blocked
// once a response has been submitted and the questionnaire has no
// further open draft question changes pending -- in practice the
// questionnaire stays editable (a new publish just creates a fresh
// version for any FUTURE response, never touching a response already
// recorded against an earlier version), so there is no hard status gate
// here the way there is for signed proposals.

import type { StaffUser } from "../../../../../_lib/roles";

interface Env {
  DB?: D1Database;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function normalizeParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0]! : value;
}

interface QuestionnaireRow {
  id: string;
  client_id: string;
  slug: string;
  access_token: string;
  title: string;
  description: string | null;
  status: string;
  current_version: number;
  created_at: string;
  updated_at: string;
}

interface QuestionRow {
  id: string;
  version_id: string | null;
  section_heading: string | null;
  section_description: string | null;
  prompt: string;
  help_text: string | null;
  field_type: string;
  is_required: number;
  options_json: string | null;
  sort_order: number;
}

function mapQuestion(q: QuestionRow) {
  return {
    id: q.id,
    sectionHeading: q.section_heading,
    sectionDescription: q.section_description,
    prompt: q.prompt,
    helpText: q.help_text,
    fieldType: q.field_type,
    isRequired: !!q.is_required,
    options: q.options_json ? (JSON.parse(q.options_json) as string[]) : [],
    sortOrder: q.sort_order,
  };
}

async function loadQuestionnaire(db: D1Database, clientId: string, questionnaireId: string): Promise<QuestionnaireRow | null> {
  return db
    .prepare(
      `SELECT id, client_id, slug, access_token, title, description, status, current_version, created_at, updated_at
       FROM questionnaires WHERE id = ? AND client_id = ?`
    )
    .bind(questionnaireId, clientId)
    .first<QuestionnaireRow>();
}

export const onRequestGet: PagesFunction<Env, "id" | "questionnaireId"> = async ({ env, params }) => {
  if (!env.DB) return jsonResponse(500, { error: "Not configured" });
  const db = env.DB;
  const clientId = normalizeParam(params.id);
  const questionnaireId = normalizeParam(params.questionnaireId);

  const questionnaire = await loadQuestionnaire(db, clientId, questionnaireId);
  if (!questionnaire) return jsonResponse(404, { error: "Questionnaire not found" });

  const draftQuestions = await db
    .prepare(
      `SELECT id, version_id, section_heading, section_description, prompt, help_text, field_type, is_required, options_json, sort_order
       FROM questionnaire_questions WHERE questionnaire_id = ? AND version_id IS NULL ORDER BY sort_order ASC`
    )
    .bind(questionnaireId)
    .all<QuestionRow>();

  const versions = await db
    .prepare(`SELECT id, version_number, title, description, created_at FROM questionnaire_versions WHERE questionnaire_id = ? ORDER BY version_number DESC`)
    .bind(questionnaireId)
    .all<{ id: string; version_number: number; title: string; description: string | null; created_at: string }>();

  const responseCountRow = await db.prepare(`SELECT COUNT(*) AS count FROM questionnaire_responses WHERE questionnaire_id = ?`).bind(questionnaireId).first<{ count: number }>();

  return jsonResponse(200, {
    id: questionnaire.id,
    slug: questionnaire.slug,
    publicUrl: `https://www.altasme.com/questions/${questionnaire.slug}?t=${questionnaire.access_token}`,
    title: questionnaire.title,
    description: questionnaire.description,
    status: questionnaire.status,
    currentVersion: questionnaire.current_version,
    createdAt: questionnaire.created_at,
    updatedAt: questionnaire.updated_at,
    draftQuestions: draftQuestions.results.map(mapQuestion),
    versions: versions.results.map((v) => ({ id: v.id, versionNumber: v.version_number, title: v.title, description: v.description, createdAt: v.created_at })),
    responseCount: responseCountRow?.count ?? 0,
  });
};

export const onRequestPatch: PagesFunction<Env, "id" | "questionnaireId", { staffUser: StaffUser }> = async ({ request, env, params }) => {
  if (!env.DB) return jsonResponse(500, { error: "Not configured" });
  const db = env.DB;
  const clientId = normalizeParam(params.id);
  const questionnaireId = normalizeParam(params.questionnaireId);

  const questionnaire = await loadQuestionnaire(db, clientId, questionnaireId);
  if (!questionnaire) return jsonResponse(404, { error: "Questionnaire not found" });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "Invalid request body" });
  }
  const b = body as Record<string, unknown>;
  const title = typeof b.title === "string" ? b.title.trim() : questionnaire.title;
  const description = b.description === null ? null : typeof b.description === "string" ? b.description.trim() : questionnaire.description;

  if (!title) return jsonResponse(400, { error: "Title is required." });

  const now = new Date().toISOString();
  await db.prepare(`UPDATE questionnaires SET title = ?, description = ?, updated_at = ? WHERE id = ?`).bind(title, description, now, questionnaireId).run();

  return jsonResponse(200, { ok: true, updatedAt: now });
};
