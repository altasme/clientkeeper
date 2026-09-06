// Cloudflare Pages Function: GET /api/app/dashboard
//
// Today's activity counts (source spec §20: "new clients, discovery,
// building, presentations, offers unlocked, conversions") plus an active
// clients table. "Today's counts" is read here as *today's activity* —
// how many records/transitions happened today in each category — since a
// running total-in-stage doesn't answer "what happened today" the way a
// daily ops dashboard needs to; the Projects/Clients nav pages already
// cover current totals-by-stage.

interface Env {
  DB?: D1Database;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function todayStart(): string {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD", compared via date() in SQLite
}

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  if (!env.DB) return jsonResponse(500, { error: "Not configured" });
  const db = env.DB;
  const today = todayStart();

  const [newClients, discoveryToday, buildingToday, presentationToday, offersUnlockedToday, conversionsToday] =
    await Promise.all([
      db.prepare(`SELECT COUNT(*) AS n FROM clients WHERE date(created_at) = ?`).bind(today).first<{ n: number }>(),
      db
        .prepare(`SELECT COUNT(*) AS n FROM stage_history WHERE to_stage = 'discovery' AND date(created_at) = ?`)
        .bind(today)
        .first<{ n: number }>(),
      db
        .prepare(`SELECT COUNT(*) AS n FROM stage_history WHERE to_stage = 'building' AND date(created_at) = ?`)
        .bind(today)
        .first<{ n: number }>(),
      db
        .prepare(`SELECT COUNT(*) AS n FROM stage_history WHERE to_stage = 'presentation' AND date(created_at) = ?`)
        .bind(today)
        .first<{ n: number }>(),
      db
        .prepare(`SELECT COUNT(*) AS n FROM offer_events WHERE event = 'unlocked' AND date(created_at) = ?`)
        .bind(today)
        .first<{ n: number }>(),
      db
        .prepare(`SELECT COUNT(*) AS n FROM stage_history WHERE to_stage = 'conversion' AND date(created_at) = ?`)
        .bind(today)
        .first<{ n: number }>(),
    ]);

  const activeClients = await db
    .prepare(
      `SELECT c.id, c.full_name, c.business_name, c.invitation_status, p.stage, p.updated_at
       FROM clients c
       LEFT JOIN projects p ON p.client_id = c.id
       ORDER BY COALESCE(p.updated_at, c.updated_at) DESC
       LIMIT 50`
    )
    .all<{
      id: string;
      full_name: string;
      business_name: string;
      invitation_status: string;
      stage: string | null;
      updated_at: string | null;
    }>();

  return jsonResponse(200, {
    counts: {
      newClientsToday: newClients?.n ?? 0,
      discoveryToday: discoveryToday?.n ?? 0,
      buildingToday: buildingToday?.n ?? 0,
      presentationToday: presentationToday?.n ?? 0,
      offersUnlockedToday: offersUnlockedToday?.n ?? 0,
      conversionsToday: conversionsToday?.n ?? 0,
    },
    activeClients: activeClients.results.map((row) => ({
      id: row.id,
      fullName: row.full_name,
      businessName: row.business_name,
      invitationStatus: row.invitation_status,
      stage: row.stage,
      updatedAt: row.updated_at,
    })),
  });
};
