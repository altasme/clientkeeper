// Cloudflare Pages Function: POST /api/app/offers/:id/decision
//
// Records a client's accept/decline decision on an unlocked offer. In V1
// this is a staff-entered record of a decision communicated off-platform
// (chat, a call) rather than something a client submits through a UI of
// their own — clienthub's dashboard shows the unlocked offer, but self-
// serve accept/decline there is not part of this build. Body:
// { decision: "accepted" | "declined" }. Accepting the ₱1,499 offer
// advances the project from offer_unlocked to conversion (the prerequisite
// functions/api/app/offers/unlock.ts checks before Essential can unlock);
// declining does not change the project stage — staff decide what happens
// next (a manual override, or leaving it as-is) rather than this endpoint
// guessing at a stage for a declined sale.

import type { StaffUser } from "../../../../_lib/roles";

const ALLOWED_DECISIONS = ["accepted", "declined"] as const;

interface Env {
  DB?: D1Database;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export const onRequestPost: PagesFunction<Env, "id", { staffUser: StaffUser }> = async ({ request, env, params, data }) => {
  if (!env.DB) return jsonResponse(500, { error: "Not configured" });
  const db = env.DB;
  const offerId = params.id;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "Invalid request body" });
  }
  const decision = (body as Record<string, unknown>)?.decision;
  if (typeof decision !== "string" || !ALLOWED_DECISIONS.includes(decision as (typeof ALLOWED_DECISIONS)[number])) {
    return jsonResponse(400, { error: `decision must be one of ${ALLOWED_DECISIONS.join(", ")}` });
  }

  const offer = await db
    .prepare(`SELECT id, type, status, project_id FROM offers WHERE id = ?`)
    .bind(offerId)
    .first<{ id: string; type: string; status: string; project_id: string }>();
  if (!offer) return jsonResponse(404, { error: "Offer not found" });
  if (offer.status === "accepted" || offer.status === "declined") {
    return jsonResponse(409, { error: `This offer already has a recorded decision: ${offer.status}.` });
  }

  const now = new Date().toISOString();

  await db.prepare(`UPDATE offers SET status = ?, updated_at = ? WHERE id = ?`).bind(decision, now, offerId).run();

  await db
    .prepare(`INSERT INTO offer_events (id, offer_id, event, actor_id, created_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), offerId, decision, data.staffUser.id, now)
    .run();

  // Accepting the ₱1,499 offer is the one decision that moves the project
  // forward on its own (offer_unlocked -> conversion) — this is a legal
  // step in FORWARD_SEQUENCE, so a plain update (not an override) is
  // correct here.
  if (decision === "accepted" && offer.type === "1499") {
    const project = await db.prepare(`SELECT stage FROM projects WHERE id = ?`).bind(offer.project_id).first<{ stage: string }>();
    if (project?.stage === "offer_unlocked") {
      await db.prepare(`UPDATE projects SET stage = 'conversion', updated_at = ? WHERE id = ?`).bind(now, offer.project_id).run();
      await db
        .prepare(
          `INSERT INTO stage_history (id, project_id, from_stage, to_stage, actor_id, reason, created_at)
           VALUES (?, ?, 'offer_unlocked', 'conversion', ?, NULL, ?)`
        )
        .bind(crypto.randomUUID(), offer.project_id, data.staffUser.id, now)
        .run();
    }
  }

  return jsonResponse(200, { ok: true });
};
