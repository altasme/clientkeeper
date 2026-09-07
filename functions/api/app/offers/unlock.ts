// Cloudflare Pages Function: POST /api/app/offers/unlock
//
// The commercial unlock engine (CLAUDE.md §3): "Unlock ₱1,499 Offer" and
// "Unlock Next Offer" (Essential) from the project controls list, §2.
// Body: { projectId, type } where type is "1499" or "essential". Unlike a
// plain stage advance, this is a compound, admin-only action:
//   1. Validate the project is in the correct prerequisite stage.
//   2. Validate no offer of this type already exists for the project (no
//      duplicate unlock).
//   3. For "essential", validate the "1499" offer was already accepted —
//      "Essential unlocks only after ₱1,499 is completed" (§3).
//   4. Create the offers row (content is DB-configurable JSON, not
//      hardcoded — ships as a clearly-marked placeholder for the ₱1,499
//      offer since the real price/copy isn't provided yet, per the source
//      spec's own open item #5. Do not replace PLACEHOLDER_1499_CONTENT
//      with an invented real-sounding number; wait for the real content).
//   5. Write offer_events (event='unlocked').
//   6. Advance the project stage (post_presentation -> offer_unlocked, or
//      conversion -> essential_upsell) — this is the one place those two
//      stages are reachable from, per
//      functions/api/app/projects/[id]/advance.ts's explicit block on them.
//   7. Write audit_log — every unlock is a sensitive, audited mutation.

import type { StaffUser } from "../../../_lib/roles";

interface Env {
  DB?: D1Database;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const PLACEHOLDER_1499_CONTENT = {
  placeholder: true,
  headline: "[Placeholder] Domain + Launch Package",
  price: "[Placeholder: real ₱1,499 offer copy not yet provided]",
  body: "This offer's real price and copy have not been supplied yet (source spec open item #5). Do not present this to a client as final. Replace this placeholder deliberately once the real content is provided.",
};

const PLACEHOLDER_ESSENTIAL_CONTENT = {
  placeholder: true,
  headline: "[Placeholder] Essential Plan",
  price: "[Placeholder: real Essential upsell copy not yet provided]",
  body: "This offer's real price and copy have not been supplied yet. Do not present this to a client as final. Replace this placeholder deliberately once the real content is provided.",
};

const OFFER_RULES = {
  "1499": { prerequisiteStage: "post_presentation", nextStage: "offer_unlocked", content: PLACEHOLDER_1499_CONTENT },
  essential: { prerequisiteStage: "conversion", nextStage: "essential_upsell", content: PLACEHOLDER_ESSENTIAL_CONTENT },
} as const;

export const onRequestPost: PagesFunction<Env, string, { staffUser: StaffUser }> = async ({ request, env, data }) => {
  if (!env.DB) return jsonResponse(500, { error: "Not configured" });
  const db = env.DB;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "Invalid request body" });
  }
  const b = body as Record<string, unknown>;
  const projectId = typeof b.projectId === "string" ? b.projectId : null;
  const type = typeof b.type === "string" ? b.type : null;

  if (!projectId || !type || !(type in OFFER_RULES)) {
    return jsonResponse(400, { error: `projectId and a type of "1499" or "essential" are required.` });
  }
  const rule = OFFER_RULES[type as keyof typeof OFFER_RULES];

  const project = await db
    .prepare(`SELECT id, client_id, stage FROM projects WHERE id = ?`)
    .bind(projectId)
    .first<{ id: string; client_id: string; stage: string }>();
  if (!project) return jsonResponse(404, { error: "Project not found" });

  if (project.stage !== rule.prerequisiteStage) {
    return jsonResponse(409, {
      error: `Project must be in stage "${rule.prerequisiteStage}" to unlock the ${type} offer (currently "${project.stage}").`,
    });
  }

  const existingOffer = await db
    .prepare(`SELECT id, status FROM offers WHERE project_id = ? AND type = ?`)
    .bind(projectId, type)
    .first<{ id: string; status: string }>();
  if (existingOffer) {
    return jsonResponse(409, { error: `A "${type}" offer already exists for this project (status: ${existingOffer.status}).` });
  }

  if (type === "essential") {
    const priorOffer = await db
      .prepare(`SELECT status FROM offers WHERE project_id = ? AND type = '1499'`)
      .bind(projectId)
      .first<{ status: string }>();
    if (!priorOffer || priorOffer.status !== "accepted") {
      return jsonResponse(409, { error: "The ₱1,499 offer must be accepted before Essential can be unlocked." });
    }
  }

  const now = new Date().toISOString();
  const offerId = crypto.randomUUID();

  await db
    .prepare(
      `INSERT INTO offers (id, client_id, project_id, type, status, content, unlocked_by, unlocked_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'unlocked', ?, ?, ?, ?, ?)`
    )
    .bind(offerId, project.client_id, projectId, type, JSON.stringify(rule.content), data.staffUser.id, now, now, now)
    .run();

  await db
    .prepare(`INSERT INTO offer_events (id, offer_id, event, actor_id, created_at) VALUES (?, ?, 'unlocked', ?, ?)`)
    .bind(crypto.randomUUID(), offerId, data.staffUser.id, now)
    .run();

  await db.prepare(`UPDATE projects SET stage = ?, updated_at = ? WHERE id = ?`).bind(rule.nextStage, now, projectId).run();

  await db
    .prepare(
      `INSERT INTO stage_history (id, project_id, from_stage, to_stage, actor_id, reason, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`
    )
    .bind(crypto.randomUUID(), projectId, project.stage, rule.nextStage, data.staffUser.id, now)
    .run();

  await db
    .prepare(
      `INSERT INTO audit_log (id, actor_id, action, entity_type, entity_id, before, after, reason, created_at)
       VALUES (?, ?, 'offer_unlock', 'offer', ?, NULL, ?, NULL, ?)`
    )
    .bind(crypto.randomUUID(), data.staffUser.id, offerId, JSON.stringify({ type, projectId }), now)
    .run();

  return jsonResponse(200, { offerId, stage: rule.nextStage });
};
