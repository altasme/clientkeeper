// Cloudflare Pages Function: POST /api/app/projects/:id/override
//
// Admin override: a manual stage change that bypasses the forward-only
// transition map entirely (CLAUDE.md §2/§4) — the only sanctioned way to
// move a project backward, skip a step, or into on_hold/cancelled/
// completed from any active stage. Body: { toStage, reason }. `reason` is
// mandatory (not just recommended) and every override writes BOTH
// stage_history (so the project's timeline shows it) AND audit_log (so
// it's distinguishable from a normal forward advance in the security/audit
// trail) — this is the one stage-mutation path this repo's guardrail #3
// means when it says "every sensitive action... is audited."
//
// Deliberately does not call functions/_lib/stages.ts's advanceStage() or
// isValidForwardTransition() at all: those enforce the *forward* map,
// which is precisely what an override exists to bypass. The only
// remaining validation is that `toStage` is a real, known stage (checked
// against project_stages) rather than an arbitrary string.

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
  const projectId = params.id;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "Invalid request body" });
  }
  const b = body as Record<string, unknown>;
  const toStage = typeof b.toStage === "string" ? b.toStage : null;
  const reason = typeof b.reason === "string" ? b.reason.trim() : "";

  if (!toStage) return jsonResponse(400, { error: "toStage is required" });
  if (!reason) return jsonResponse(400, { error: "A reason is required for an admin override." });

  const stageExists = await db.prepare(`SELECT stage FROM project_stages WHERE stage = ?`).bind(toStage).first();
  if (!stageExists) return jsonResponse(400, { error: `Unknown stage: ${toStage}` });

  const project = await db.prepare(`SELECT id, stage FROM projects WHERE id = ?`).bind(projectId).first<{ id: string; stage: string }>();
  if (!project) return jsonResponse(404, { error: "Project not found" });

  const now = new Date().toISOString();

  await db.prepare(`UPDATE projects SET stage = ?, updated_at = ? WHERE id = ?`).bind(toStage, now, projectId).run();

  await db
    .prepare(
      `INSERT INTO stage_history (id, project_id, from_stage, to_stage, actor_id, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(crypto.randomUUID(), projectId, project.stage, toStage, data.staffUser.id, reason, now)
    .run();

  await db
    .prepare(
      `INSERT INTO audit_log (id, actor_id, action, entity_type, entity_id, before, after, reason, created_at)
       VALUES (?, ?, 'stage_override', 'project', ?, ?, ?, ?, ?)`
    )
    .bind(
      crypto.randomUUID(),
      data.staffUser.id,
      projectId,
      JSON.stringify({ stage: project.stage }),
      JSON.stringify({ stage: toStage }),
      reason,
      now
    )
    .run();

  return jsonResponse(200, { stage: toStage });
};
