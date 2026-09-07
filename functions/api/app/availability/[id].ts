// Cloudflare Pages Function: DELETE /api/app/availability/:id
//
// Removes one weekly availability rule. Deliberately no "edit" endpoint —
// changing a rule's time is delete-and-recreate from the UI, since a rule
// is just three plain fields with nothing else referencing its id.

interface Env {
  DB?: D1Database;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export const onRequestDelete: PagesFunction<Env, "id"> = async ({ env, params }) => {
  if (!env.DB) return jsonResponse(500, { error: "Not configured" });

  const existing = await env.DB.prepare(`SELECT id FROM availability_rules WHERE id = ?`).bind(params.id).first();
  if (!existing) return jsonResponse(404, { error: "Rule not found" });

  await env.DB.prepare(`DELETE FROM availability_rules WHERE id = ?`).bind(params.id).run();

  return jsonResponse(200, { ok: true });
};
