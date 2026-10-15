// Shared slug + access-token helpers for proposals and questionnaires
// (CLAUDEproposalquestionnaire.md). Mirrors bills' own short-token
// pattern (functions/api/app/bills/index.ts) exactly -- same alphabet,
// same length, same bias-free byte-modulo mapping, same "unguessable
// token behind a readable path" security model, just carried as a query
// param (?t=...) alongside a readable slug instead of being the whole
// path, since this feature's spec explicitly asked for a client-name
// path segment rather than an opaque one.

const TOKEN_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
const TOKEN_LENGTH = 8;

export function generateAccessToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_LENGTH));
  return Array.from(bytes, (b) => TOKEN_ALPHABET[b % TOKEN_ALPHABET.length]).join("");
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip accents
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "client";
}

/**
 * Generates a unique slug + unique access token for a new proposal or
 * questionnaire. `baseText` is usually the client's business name.
 * Collisions (same base slug already taken, by this client or another)
 * get a numeric suffix (-2, -3, ...) rather than failing -- a client
 * with two proposals, or two differently-named clients that happen to
 * slugify the same, both get distinct, stable URLs, never overwriting
 * an existing record.
 */
export async function generateUniqueSlugAndToken(
  db: D1Database,
  table: "proposals" | "questionnaires",
  baseText: string
): Promise<{ slug: string; accessToken: string }> {
  const base = slugify(baseText);
  let slug = base;
  let suffix = 2;
  // A single-operator, low-concurrency admin tool -- same "good enough,
  // no transaction/retry needed" tolerance already accepted for bill
  // numbers and manual-client-add's duplicate-email check elsewhere in
  // this app.
  while (true) {
    const existing = await db.prepare(`SELECT id FROM ${table} WHERE slug = ?`).bind(slug).first<{ id: string }>();
    if (!existing) break;
    slug = `${base}-${suffix}`;
    suffix += 1;
  }

  let accessToken = generateAccessToken();
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await db.prepare(`SELECT id FROM ${table} WHERE access_token = ?`).bind(accessToken).first<{ id: string }>();
    if (!existing) break;
    accessToken = generateAccessToken();
  }

  return { slug, accessToken };
}
