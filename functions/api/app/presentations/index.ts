// Cloudflare Pages Function: GET/POST /api/app/presentations
//
// GET: list of presentations across every project, for the Presentations
// nav page. Same shape as functions/api/app/discovery/index.ts.
//
// POST: creates the first presentations row for a project — the one
// creation path for this table, since (unlike discovery, which the
// client books themselves) presentation scheduling is entirely staff-
// driven per the operator's explicit split. Conflict-checked against the
// same 45+15min grid discovery calls use, so a presentation can never
// land on top of an existing discovery call or another presentation.

import { slotsConflict } from "../../../_lib/scheduling";

interface Env {
  DB?: D1Database;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return jsonResponse(500, { error: "Not configured" });
  const db = env.DB;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "Invalid request body." });
  }
  const b = body as Record<string, unknown>;
  const projectId = typeof b.projectId === "string" ? b.projectId : null;
  const scheduledAt = typeof b.scheduledAt === "string" ? b.scheduledAt : null;
  const meetingLink = typeof b.meetingLink === "string" ? b.meetingLink : null;

  if (!projectId) return jsonResponse(400, { error: "projectId is required." });
  if (!scheduledAt) return jsonResponse(400, { error: "scheduledAt is required." });

  const project = await db.prepare(`SELECT id FROM projects WHERE id = ?`).bind(projectId).first();
  if (!project) return jsonResponse(404, { error: "Project not found." });

  const existing = await db
    .prepare(`SELECT id FROM presentations WHERE project_id = ? ORDER BY created_at DESC LIMIT 1`)
    .bind(projectId)
    .first();
  if (existing) {
    return jsonResponse(400, { error: "This project already has a presentation on record. Update it instead of creating a new one." });
  }

  const candidateMs = new Date(scheduledAt).getTime();
  if (Number.isNaN(candidateMs)) return jsonResponse(400, { error: "scheduledAt is not a valid date." });

  const bookedResult = await db
    .prepare(
      `SELECT scheduled_at FROM discovery_sessions WHERE external_status = 'scheduled' AND scheduled_at IS NOT NULL
       UNION ALL
       SELECT scheduled_at FROM presentations WHERE external_status = 'scheduled' AND scheduled_at IS NOT NULL`
    )
    .all<{ scheduled_at: string }>();
  const conflict = (bookedResult.results ?? []).some((r) => slotsConflict(candidateMs, new Date(r.scheduled_at).getTime()));
  if (conflict) return jsonResponse(409, { error: "That time conflicts with another scheduled session." });

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO presentations (id, project_id, external_status, scheduled_at, meeting_link, created_at, updated_at)
       VALUES (?, ?, 'scheduled', ?, ?, ?, ?)`
    )
    .bind(id, projectId, new Date(candidateMs).toISOString(), meetingLink, now, now)
    .run();

  return jsonResponse(200, { id });
};

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return jsonResponse(500, { error: "Not configured" });
  const db = env.DB;

  const url = new URL(request.url);
  const status = url.searchParams.get("status")?.trim();

  const conditions: string[] = [];
  const params: unknown[] = [];
  if (status) {
    conditions.push(`pr.external_status = ?`);
    params.push(status);
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const result = await db
    .prepare(
      `SELECT pr.id, pr.external_status, pr.internal_notes, pr.preferred_times, pr.scheduled_at, pr.client_decision,
              pr.created_at, pr.updated_at,
              p.id AS project_id, c.id AS client_id, c.full_name, c.business_name
       FROM presentations pr
       JOIN projects p ON p.id = pr.project_id
       JOIN clients c ON c.id = p.client_id
       ${whereClause}
       ORDER BY pr.updated_at DESC
       LIMIT 200`
    )
    .bind(...params)
    .all();

  return jsonResponse(200, result.results);
};
