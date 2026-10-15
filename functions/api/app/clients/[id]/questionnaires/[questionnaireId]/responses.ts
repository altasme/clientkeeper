// Cloudflare Pages Function: GET /api/app/clients/:id/questionnaires/:questionnaireId/responses
//
// Full submitted responses for staff review/download, each resolved
// against the exact question set (version) it was answered against --
// never the current draft, so an edited questionnaire never misaligns a
// past response's answers with the wrong questions.

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
    .prepare(`SELECT id, version_id, ip_address, user_agent, submitted_at FROM questionnaire_responses WHERE questionnaire_id = ? ORDER BY submitted_at DESC`)
    .bind(questionnaireId)
    .all<{ id: string; version_id: string; ip_address: string | null; user_agent: string | null; submitted_at: string }>();

  const out = [];
  for (const response of responses.results) {
    const questions = await db
      .prepare(`SELECT id, prompt, field_type, sort_order FROM questionnaire_questions WHERE version_id = ? ORDER BY sort_order ASC`)
      .bind(response.version_id)
      .all<{ id: string; prompt: string; field_type: string; sort_order: number }>();

    const answers = await db
      .prepare(`SELECT question_id, value_text, value_json, file_url, file_name FROM questionnaire_answers WHERE response_id = ?`)
      .bind(response.id)
      .all<{ question_id: string; value_text: string | null; value_json: string | null; file_url: string | null; file_name: string | null }>();

    const answersByQuestion = new Map(answers.results.map((a) => [a.question_id, a]));

    out.push({
      id: response.id,
      submittedAt: response.submitted_at,
      ipAddress: response.ip_address,
      userAgent: response.user_agent,
      answers: questions.results.map((q) => {
        const a = answersByQuestion.get(q.id);
        return {
          questionId: q.id,
          prompt: q.prompt,
          fieldType: q.field_type,
          valueText: a?.value_text ?? null,
          valueList: a?.value_json ? (JSON.parse(a.value_json) as string[]) : null,
          fileUrl: a?.file_url ?? null,
          fileName: a?.file_name ?? null,
        };
      }),
    });
  }

  return jsonResponse(200, out);
};
