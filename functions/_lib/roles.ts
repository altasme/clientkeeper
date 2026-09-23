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

// _middleware.ts's blanket check (a valid session + any role at all) is the
// only gate most of this app's routes need. A few MyCafe actions are more
// sensitive than the rest — they call out to a live third-party billing/
// provisioning system or mint a credential that grants POS access — so
// those routes call this on top of the middleware, restricted to owner/admin
// rather than every staff role (sales/developer). Read-only MyCafe views
// (the client list, dashboard, a single client's detail) are deliberately
// NOT gated by this — only actions that provision, mint a device token, or
// change licensing are.
const MYCAFE_ADMIN_ROLES: StaffRole[] = ["owner", "admin"];

export function isMyCafeAdmin(staffUser: StaffUser): boolean {
  return MYCAFE_ADMIN_ROLES.includes(staffUser.role);
}
