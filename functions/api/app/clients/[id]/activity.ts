// Cloudflare Pages Function: POST /api/app/clients/:id/activity
//
// Adds a manual note to a client's activity timeline (CLAUDE.md §2's
// "communication (manual notes...)"). Logged call-request preferred times
// already land in discovery_sessions/presentations.preferred_times via
// clienthub's interim booking behavior — this endpoint is only for staff
// free-text notes, not for anything structured.

import type { StaffUser } from "../../../../_lib/roles";

interface Env {
  DB?: D1Database;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export const onRequestPost: PagesFunction<Env, "id", { staffUser: StaffUser }> = async ({ request, env, params, data }) => {
  if (!env.DB) return jsonResponse(500, { error: "Not configured" });
  const db = env.DB;
  const clientId = params.id;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "Invalid request body" });
  }

  const note = typeof (body as Record<string, unknown>)?.note === "string" ? (body as { note: string }).note.trim() : "";
  if (!note) return jsonResponse(400, { error: "note is required" });

  const client = await db.prepare(`SELECT id FROM clients WHERE id = ?`).bind(clientId).first();
  if (!client) return jsonResponse(404, { error: "Client not found" });

  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  await db
    .prepare(
      `INSERT INTO client_activity (id, client_id, type, description, actor_id, created_at)
       VALUES (?, ?, 'note', ?, ?, ?)`
    )
    .bind(id, clientId, note, data.staffUser.id, now)
    .run();

  return jsonResponse(200, { id, createdAt: now });
};
