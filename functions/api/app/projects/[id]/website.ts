// Cloudflare Pages Function: POST /api/app/projects/:id/website
//
// Sets a project's live website URL (clienthub's CLAUDE.md §12: "Post
// presentation stage moving forward - We should be able to input their
// website address and display the link to their Client hub"). Writes
// `projects.website_url`, the same column clienthub's own client-facing
// `/api/client/me` already reads and displays on the client's Dashboard
// and Website pages — this is the one place that value comes from. Body:
// { websiteUrl } (empty string clears it).
//
// No stage gating here: the UI only shows this field from post_presentation
// onward (a workflow convenience, not a security boundary — staff are
// already fully trusted, unlike clienthub's client-facing endpoints).

interface Env {
  DB?: D1Database;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export const onRequestPost: PagesFunction<Env, "id"> = async ({ request, env, params }) => {
  if (!env.DB) return jsonResponse(500, { error: "Not configured" });
  const db = env.DB;
  const projectId = params.id;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "Invalid request body" });
  }
  const websiteUrl = typeof (body as Record<string, unknown>)?.websiteUrl === "string" ? ((body as Record<string, unknown>).websiteUrl as string).trim() : "";

  const project = await db.prepare(`SELECT id FROM projects WHERE id = ?`).bind(projectId).first<{ id: string }>();
  if (!project) return jsonResponse(404, { error: "Project not found" });

  const now = new Date().toISOString();
  await db
    .prepare(`UPDATE projects SET website_url = ?, updated_at = ? WHERE id = ?`)
    .bind(websiteUrl || null, now, projectId)
    .run();

  return jsonResponse(200, { ok: true, websiteUrl: websiteUrl || null });
};
