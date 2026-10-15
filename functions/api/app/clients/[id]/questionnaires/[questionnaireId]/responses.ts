// Cloudflare Pages Function: GET /api/app/clients/:id/questionnaires/:questionnaireId/responses
//
// Submitted responses for staff review -- each is just the client's one
// free-text answer now (CLAUDE.md's 2026-10-15 redesign collapsed the
// old per-question answer list into questionnaire_responses.answer_text
// directly), so this no longer needs to resolve against a question set.

interface Env {
  DB?: D1Database;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function normalizeParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0]! : value;
}

export const onRequestGet: PagesFunction<Env, "id" | "questionnaireId"> = async ({ env, params }) => {
  if (!env.DB) return jsonResponse(500, { error: "Not configured" });
  const db = env.DB;
  const clientId = normalizeParam(params.id);
  const questionnaireId = normalizeParam(params.questionnaireId);

  const questionnaire = await db.prepare(`SELECT id FROM questionnaires WHERE id = ? AND client_id = ?`).bind(questionnaireId, clientId).first<{ id: string }>();
  if (!questionnaire) return jsonResponse(404, { error: "Questionnaire not found" });

  const responses = await db
    .prepare(`SELECT id, answer_text, ip_address, user_agent, submitted_at FROM questionnaire_responses WHERE questionnaire_id = ? ORDER BY submitted_at DESC`)
    .bind(questionnaireId)
    .all<{ id: string; answer_text: string; ip_address: string | null; user_agent: string | null; submitted_at: string }>();

  return jsonResponse(
    200,
    responses.results.map((r) => ({
      id: r.id,
      answerText: r.answer_text,
      submittedAt: r.submitted_at,
      ipAddress: r.ip_address,
      userAgent: r.user_agent,
    }))
  );
};
