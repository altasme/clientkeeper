// Mailbox authorization. Every /api/app/mail/* route already sits behind
// functions/api/app/_middleware.ts (valid ck_session + a `users` role); on
// top of that, mailbox data is gated per account by mail_account_access --
// a staff role alone grants nothing here (operator decision, CLAUDE.md §32).
// Owner/admin can *manage* identities and grant access (including to
// themselves) but do not implicitly read every mailbox.
//
// IDOR posture: a message/thread/draft/label/attachment whose account the
// caller can't access is reported as 404, never 403, so ids can't be
// probed for existence.

import type { StaffUser } from "../roles";

export interface AccessEntry {
  accountId: string;
  canSend: boolean;
  emailAddress: string;
  displayName: string;
}

export type MailAccess = Map<string, AccessEntry>;

export function isMailAdmin(user: StaffUser): boolean {
  return user.role === "owner" || user.role === "admin";
}

export async function loadAccess(db: D1Database, userId: string): Promise<MailAccess> {
  const rows = await db
    .prepare(
      `SELECT a.account_id, a.can_send, m.email_address, m.display_name
       FROM mail_account_access a JOIN mail_accounts m ON m.id = a.account_id
       WHERE a.user_id = ? AND m.is_active = 1
       ORDER BY m.sort_order, m.email_address`
    )
    .bind(userId)
    .all<{ account_id: string; can_send: number; email_address: string; display_name: string }>();
  const map: MailAccess = new Map();
  for (const r of rows.results) {
    map.set(r.account_id, { accountId: r.account_id, canSend: !!r.can_send, emailAddress: r.email_address, displayName: r.display_name });
  }
  return map;
}

/**
 * Resolves the `accountId` query/body value to the set of account ids to
 * scope a query by. "all" (or empty) = every accessible account (unified
 * inbox). An id the caller can't access yields an empty list -- callers
 * return empty results / 404 rather than leaking anything.
 */
export function scopeAccountIds(access: MailAccess, requested: string | null | undefined): string[] {
  if (!requested || requested === "all") return [...access.keys()];
  return access.has(requested) ? [requested] : [];
}

export function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}
