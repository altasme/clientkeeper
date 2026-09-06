// Cloudflare Pages Function: PATCH /api/app/discovery/:id
//
// Updates a discovery session's external_status/internal_notes/
// scheduled_at. external_status is what clienthub's client-facing endpoint
// echoes back to the client (never internal_notes) — see
// clienthub/CLAUDE.md §6's "internal data is never returned by a client
// endpoint" rule, which this endpoint's field set on the write side
// mirrors: staff can set both, the client only ever sees one of them.
//
// Creating the initial discovery_sessions row happens on the client side
// of the system (a project entering the 'discovery' stage is when
// clienthub's interim call-request flow creates one, per
// clienthub/CLAUDE.md §1.6) — this endpoint only updates an existing row,
// it never creates one.

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

  const existing = await db.prepare(`SELECT id FROM discovery_sessions WHERE id = ?`).bind(id).first();
  if (!existing) return jsonResponse(404, { error: "Discovery session not found" });

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
  if (typeof b.scheduledAt === "string" || b.scheduledAt === null) {
    updates.push("scheduled_at = ?");
    values.push(b.scheduledAt);
  }

  if (!updates.length) return jsonResponse(400, { error: "Nothing to update" });

  const now = new Date().toISOString();
  updates.push("updated_at = ?");
  values.push(now, id);

  await db.prepare(`UPDATE discovery_sessions SET ${updates.join(", ")} WHERE id = ?`).bind(...values).run();

  return jsonResponse(200, { ok: true });
};
