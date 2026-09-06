// Cloudflare Pages Function: POST /api/app/projects/:id/advance
//
// Generic single-step-forward stage move, covering the plain project
// controls from CLAUDE.md §2 that aren't tied to the commercial offer
// engine: Start Discovery, Mark Discovery Complete / Start Build, Mark
// Ready for Presentation, Mark Presentation Complete. Body: { toStage }.
// The frontend only ever offers the one legal next stage as a button
// (FORWARD_SEQUENCE allows exactly one forward step at a time, so there's
// no ambiguity in what "the next stage" means from wherever a project
// currently sits) — this endpoint still validates server-side via
// isValidForwardTransition rather than trusting the button the frontend
// happened to render.
//
// Deliberately rejects moving INTO offer_unlocked or essential_upsell:
// those two are commercial-unlock actions (source spec §3 / this repo's
// CLAUDE.md §3), and must go through functions/api/app/offers/unlock.ts
// instead, which creates the actual offers row and writes offer_events —
// a bare stage flip with no offer row behind it would leave downstream
// reads (clienthub's client dashboard) assuming an offer exists when it
// doesn't.

import { isValidForwardTransition, type Stage } from "../../../../_lib/stages";
import type { StaffUser } from "../../../../_lib/roles";

const OFFER_GATED_STAGES: readonly Stage[] = ["offer_unlocked", "essential_upsell"];

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
  const toStage = (body as Record<string, unknown>)?.toStage;
  if (typeof toStage !== "string") return jsonResponse(400, { error: "toStage is required" });

  if (OFFER_GATED_STAGES.includes(toStage as Stage)) {
    return jsonResponse(400, { error: "Use the offer unlock action for this transition, not a plain stage advance." });
  }

  const project = await db.prepare(`SELECT id, stage FROM projects WHERE id = ?`).bind(projectId).first<{ id: string; stage: Stage }>();
  if (!project) return jsonResponse(404, { error: "Project not found" });

  if (!isValidForwardTransition(project.stage, toStage as Stage)) {
    return jsonResponse(409, { error: `${project.stage} cannot move to ${toStage} as a plain advance.` });
  }

  const now = new Date().toISOString();

  await db.prepare(`UPDATE projects SET stage = ?, updated_at = ? WHERE id = ?`).bind(toStage, now, projectId).run();

  await db
    .prepare(
      `INSERT INTO stage_history (id, project_id, from_stage, to_stage, actor_id, reason, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`
    )
    .bind(crypto.randomUUID(), projectId, project.stage, toStage, data.staffUser.id, now)
    .run();

  return jsonResponse(200, { stage: toStage });
};
