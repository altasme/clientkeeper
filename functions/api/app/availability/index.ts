// Cloudflare Pages Function: GET/POST /api/app/availability
//
// CRUD for the shared weekly availability_rules template (clienthub's
// CLAUDE.md §10) — the source of truth for which discovery-call slots a
// client can pick in Client Hub. Any authenticated staff member can
// manage this, same as every other endpoint in this app (no per-role
// restriction exists anywhere in this codebase — see functions/_lib/
// roles.ts).

import { isValidHHMM } from "../../../_lib/scheduling";

interface Env {
  DB?: D1Database;
}

interface AvailabilityRuleRow {
  id: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
  created_at: string;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  if (!env.DB) return jsonResponse(500, { error: "Not configured" });

  const result = await env.DB
    .prepare(`SELECT id, day_of_week, start_time, end_time, created_at FROM availability_rules ORDER BY day_of_week, start_time`)
    .all<AvailabilityRuleRow>();

  return jsonResponse(200, result.results ?? []);
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return jsonResponse(500, { error: "Not configured" });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "Invalid request body." });
  }
  const b = body as Record<string, unknown>;

  const dayOfWeek = typeof b.dayOfWeek === "number" ? b.dayOfWeek : NaN;
  const startTime = typeof b.startTime === "string" ? b.startTime : "";
  const endTime = typeof b.endTime === "string" ? b.endTime : "";

  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
    return jsonResponse(400, { error: "dayOfWeek must be an integer 0 (Sunday) through 6 (Saturday)." });
  }
  if (!isValidHHMM(startTime) || !isValidHHMM(endTime)) {
    return jsonResponse(400, { error: "startTime/endTime must be \"HH:MM\" (24-hour)." });
  }
  if (startTime >= endTime) {
    return jsonResponse(400, { error: "endTime must be after startTime." });
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await env.DB
    .prepare(`INSERT INTO availability_rules (id, day_of_week, start_time, end_time, created_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(id, dayOfWeek, startTime, endTime, now)
    .run();

  return jsonResponse(200, { id });
};
