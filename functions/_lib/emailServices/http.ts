// Small shared HTTP helpers for functions/api/app/email-services/* and
// email-plans/*. Authentication is already done by _middleware.ts; these
// add the owner/admin gate for mutations and map engine results.

import type { StaffUser } from "../roles";
import type { Actor } from "./logs";
import type { EngineResult } from "./engine";
import { isEmailAdminRole } from "./policy";

export interface EmailEnv {
  DB?: D1Database;
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export function param(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

export async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// Viewing is open to every staff role (the middleware already enforced a
// valid session + role). Every change requires owner/admin.
export function requireEmailAdmin(staffUser: StaffUser): Response | null {
  return isEmailAdminRole(staffUser.role) ? null : json(403, { error: "Only owners and admins can change email services." });
}

export function staffActor(staffUser: StaffUser): Actor {
  return { type: "staff", id: staffUser.id };
}

export function engineResponse<T>(result: EngineResult<T>, okStatus = 200): Response {
  if (result.ok) return json(okStatus, result.value);
  return json(result.status, { error: result.error, code: result.code, ...result.details });
}
