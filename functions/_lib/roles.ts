// Staff role lookup against the shared D1 `users` table (see
// clienthub/d1/schema.sql). This is the second half of the two-step check
// this repo's CLAUDE.md §1 requires on every request: (1) a valid WorkOS
// session — handled by functions/_lib/session.ts — then (2) a matching
// `users` row with a role. A valid WorkOS login is necessary but never
// sufficient: no row here means no access, regardless of session validity.
//
// Deliberately re-queried on every request rather than cached in the
// session cookie, so a role change or revocation (an admin deleting a
// departed staff member's `users` row) takes effect on that person's very
// next request instead of waiting for their session to expire.

export type StaffRole = "owner" | "developer" | "admin" | "sales";

export interface StaffUser {
  id: string;
  email: string;
  full_name: string | null;
  role: StaffRole;
}

export async function getStaffUser(db: D1Database, workosUserId: string): Promise<StaffUser | null> {
  const row = await db
    .prepare(`SELECT id, email, full_name, role FROM users WHERE id = ?`)
    .bind(workosUserId)
    .first<StaffUser>();
  return row ?? null;
}
