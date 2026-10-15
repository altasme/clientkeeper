// Cloudflare Pages Function: GET/PATCH /api/app/clients/:id/questionnaires/:questionnaireId
//
// GET returns the draft buffer (title/content_html), every published
// version (read-only, newest first), and response count. PATCH updates
// the draft buffer only. Mirrors proposals/[proposalId].ts's shape
// exactly, since questionnaires are now the same free-text-content
// model (CLAUDE.md's 2026-10-15 redesign) -- no more structured
// question list to manage here.

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
  content_html: string;
  status: string;
  current_version: number;
  created_at: string;
  updated_at: string;
}

async function loadQuestionnaire(db: D1Database, clientId: string, questionnaireId: string): Promise<QuestionnaireRow | null> {
  return db
    .prepare(
      `SELECT id, client_id, slug, access_token, title, content_html, status, current_version, created_at, updated_at
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

  const versions = await db
    .prepare(`SELECT id, version_number, title, content_html, created_at FROM questionnaire_versions WHERE questionnaire_id = ? ORDER BY version_number DESC`)
    .bind(questionnaireId)
    .all<{ id: string; version_number: number; title: string; content_html: string; created_at: string }>();

  const responseCountRow = await db.prepare(`SELECT COUNT(*) AS count FROM questionnaire_responses WHERE questionnaire_id = ?`).bind(questionnaireId).first<{ count: number }>();

  return jsonResponse(200, {
    id: questionnaire.id,
    slug: questionnaire.slug,
    publicUrl: `https://www.altasme.com/questions/${questionnaire.slug}?t=${questionnaire.access_token}`,
    title: questionnaire.title,
    contentHtml: questionnaire.content_html,
    status: questionnaire.status,
    currentVersion: questionnaire.current_version,
    createdAt: questionnaire.created_at,
    updatedAt: questionnaire.updated_at,
    versions: versions.results.map((v) => ({ id: v.id, versionNumber: v.version_number, title: v.title, contentHtml: v.content_html, createdAt: v.created_at })),
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
  const contentHtml = typeof b.contentHtml === "string" ? b.contentHtml : questionnaire.content_html;

  if (!title) return jsonResponse(400, { error: "Title is required." });

  const now = new Date().toISOString();
  await db.prepare(`UPDATE questionnaires SET title = ?, content_html = ?, updated_at = ? WHERE id = ?`).bind(title, contentHtml, now, questionnaireId).run();

  return jsonResponse(200, { ok: true, updatedAt: now });
};
