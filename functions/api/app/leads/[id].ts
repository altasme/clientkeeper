// Cloudflare Pages Function: PATCH /api/app/leads/:id
//
// Updates a lead's status/notes (source spec's status set: new, contacted,
// qualified, converted, lost — matches the leads.status CHECK constraint).
// Leads have no D1 foreign key to clients (a lead converting to a real
// client happens via the ganap.net payment webhook in clienthub, which has
// no knowledge of this leads table at all) — marking a lead 'converted'
// here is a manual bookkeeping step for staff, not a structural link.

const ALLOWED_STATUSES = ["new", "contacted", "qualified", "converted", "lost"] as const;

interface Env {
  DB?: D1Database;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export const onRequestPatch: PagesFunction<Env, "id"> = async ({ request, env, params }) => {
  if (!env.DB) return jsonResponse(500, { error: "Not configured" });
  const db = env.DB;
  const leadId = params.id;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "Invalid request body" });
  }
  const b = body as Record<string, unknown>;

  const lead = await db.prepare(`SELECT id FROM leads WHERE id = ?`).bind(leadId).first();
  if (!lead) return jsonResponse(404, { error: "Lead not found" });

  const updates: string[] = [];
  const values: unknown[] = [];

  if (typeof b.status === "string") {
    if (!ALLOWED_STATUSES.includes(b.status as (typeof ALLOWED_STATUSES)[number])) {
      return jsonResponse(400, { error: `status must be one of ${ALLOWED_STATUSES.join(", ")}` });
    }
    updates.push("status = ?");
    values.push(b.status);
  }
  if (typeof b.notes === "string") {
    updates.push("notes = ?");
    values.push(b.notes);
  }

  if (!updates.length) return jsonResponse(400, { error: "Nothing to update" });

  const now = new Date().toISOString();
  updates.push("updated_at = ?");
  values.push(now, leadId);

  await db.prepare(`UPDATE leads SET ${updates.join(", ")} WHERE id = ?`).bind(...values).run();

  return jsonResponse(200, { ok: true });
};
