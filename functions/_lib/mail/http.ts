// Small request/response helpers shared by every functions/api/app/mail/*
// route. Every other route in this app defines its own local jsonResponse()
// (see functions/api/app/clients/index.ts); the mail module has ~30 routes,
// so these live in one place instead of being pasted thirty times.

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

export function errorResponse(status: number, error: string, extra: Record<string, unknown> = {}): Response {
  return jsonResponse(status, { error, ...extra });
}

export function normalizeParam(value: string | string[] | undefined): string {
  if (value === undefined) return "";
  return Array.isArray(value) ? (value[0] ?? "") : value;
}

export async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = (await request.json()) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function asString(value: unknown, max = 10_000): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

export function asBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function asStringArray(value: unknown, maxItems = 500): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string").slice(0, maxItems);
}

export const nowIso = (): string => new Date().toISOString();
