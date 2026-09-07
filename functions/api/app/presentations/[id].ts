// Cloudflare Pages Function: PATCH /api/app/presentations/:id
//
// Updates a presentation's external_status/internal_notes/scheduled_at/
// meeting_link. client_decision (accepted/declined) is deliberately NOT
// writable here — that field reflects what the client themselves chose
// via clienthub's own endpoint, not something staff should be able to
// overwrite on their behalf; staff can only see it, same as everything
// else on this record. meeting_link is staff-set, client-visible.
//
// Rescheduling here (changing scheduledAt) is re-validated against the
// same 45+15min conflict rule the booking engine uses (CLAUDE.md §10),
// per the operator's explicit requirement that presentation scheduling
// share the discovery-call grid so the two can never double-book.

import { slotsConflict } from "../../../_lib/scheduling";

const ALLOWED_STATUSES = ["requested", "scheduled", "completed"] as const;

interface Env {
  DB?: D1Database;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export const onRequestPatch: PagesFunction<Env, "id"> = async ({ request, env, params }) => {
  if (!env.DB) return jsonResponse(500, { error: "Not configured" });
  const db = env.DB;
  const id = params.id;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "Invalid request body" });
  }
  const b = body as Record<string, unknown>;

  const existing = await db.prepare(`SELECT id FROM presentations WHERE id = ?`).bind(id).first();
  if (!existing) return jsonResponse(404, { error: "Presentation not found" });

  const updates: string[] = [];
  const values: unknown[] = [];

  if (typeof b.externalStatus === "string") {
    if (!ALLOWED_STATUSES.includes(b.externalStatus as (typeof ALLOWED_STATUSES)[number])) {
      return jsonResponse(400, { error: `externalStatus must be one of ${ALLOWED_STATUSES.join(", ")}` });
    }
    updates.push("external_status = ?");
    values.push(b.externalStatus);
  }
  if (typeof b.internalNotes === "string") {
    updates.push("internal_notes = ?");
    values.push(b.internalNotes);
  }
  if (typeof b.meetingLink === "string" || b.meetingLink === null) {
    updates.push("meeting_link = ?");
    values.push(b.meetingLink);
  }
  if (typeof b.scheduledAt === "string" || b.scheduledAt === null) {
    if (typeof b.scheduledAt === "string") {
      const candidateMs = new Date(b.scheduledAt).getTime();
      if (Number.isNaN(candidateMs)) return jsonResponse(400, { error: "scheduledAt is not a valid date." });
      const bookedResult = await db
        .prepare(
          `SELECT scheduled_at FROM discovery_sessions WHERE external_status = 'scheduled' AND scheduled_at IS NOT NULL
           UNION ALL
           SELECT scheduled_at FROM presentations WHERE external_status = 'scheduled' AND scheduled_at IS NOT NULL AND id != ?`
        )
        .bind(id)
        .all<{ scheduled_at: string }>();
      const conflict = (bookedResult.results ?? []).some((r) => slotsConflict(candidateMs, new Date(r.scheduled_at).getTime()));
      if (conflict) return jsonResponse(409, { error: "That time conflicts with another scheduled session." });
    }
    updates.push("scheduled_at = ?");
    values.push(b.scheduledAt);
  }

  if (!updates.length) return jsonResponse(400, { error: "Nothing to update" });

  const now = new Date().toISOString();
  updates.push("updated_at = ?");
  values.push(now, id);

  await db.prepare(`UPDATE presentations SET ${updates.join(", ")} WHERE id = ?`).bind(...values).run();

  return jsonResponse(200, { ok: true });
};
