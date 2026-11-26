// Which mailboxes a mailbox owner may sign in to, and the one-entry access
// map a signed-in owner gets.
//
// Eligible = ALL of:
//   - a mail_accounts row, is_active = 1, with a non-empty smtp_profile
//     (the login check needs a real SMTP server to verify against);
//   - linked to a client-hosted mailbox: an email_mailboxes row with
//     mail_account_id = that account and status 'active', whose
//     email_services row is 'active' (CLAUDE.md §34/§35).
//
// The second condition is deliberate and stricter than "has an SMTP
// profile". Altaventures' own staff mailboxes (sales@, support@, ...) are
// shared, and staff access to them is granted and REVOKED per person via
// mail_account_access. A password login to one of those would bypass that
// revocation (a departed employee who still knows the shared password
// would get straight back in). So only mailboxes that exist as a client's
// hosted mailbox can be logged into this way. A suspended/expired/
// cancelled service, or a deleted mailbox, stops login AND ends existing
// sessions on their next request (the guard re-runs this every request).

import type { MailAccess } from "@altasme/webmail-kit/access";

export interface ClientMailAccount {
  id: string;
  emailAddress: string;
  displayName: string;
  smtpProfile: string;
  outboundEnabled: boolean;
}

interface Row {
  id: string;
  email_address: string;
  display_name: string;
  smtp_profile: string;
  outbound_enabled: number;
}

const ELIGIBLE_SQL = `SELECT a.id, a.email_address, a.display_name, a.smtp_profile, a.outbound_enabled
  FROM mail_accounts a
  WHERE a.is_active = 1 AND a.smtp_profile IS NOT NULL AND a.smtp_profile != ''
    AND EXISTS (
      SELECT 1 FROM email_mailboxes mb JOIN email_services s ON s.id = mb.service_id
      WHERE mb.mail_account_id = a.id AND mb.status = 'active' AND s.status = 'active'
    )`;

function toAccount(r: Row | null): ClientMailAccount | null {
  if (!r) return null;
  return { id: r.id, emailAddress: r.email_address, displayName: r.display_name, smtpProfile: r.smtp_profile, outboundEnabled: !!r.outbound_enabled };
}

export async function findEligibleAccountByEmail(db: D1Database, normalizedEmail: string): Promise<ClientMailAccount | null> {
  return toAccount(await db.prepare(`${ELIGIBLE_SQL} AND a.email_address = ?`).bind(normalizedEmail).first<Row>());
}

export async function findEligibleAccountById(db: D1Database, id: string): Promise<ClientMailAccount | null> {
  return toAccount(await db.prepare(`${ELIGIBLE_SQL} AND a.id = ?`).bind(id).first<Row>());
}

/**
 * The access map every @altasme/webmail-kit query/action function takes,
 * holding exactly ONE mailbox: the session's own. Package functions scope
 * every SQL statement by `account_id IN (<these ids>)`, so passing this map
 * is what confines them to the caller's mailbox.
 */
export function ownMailboxAccess(account: ClientMailAccount): MailAccess {
  return new Map([[account.id, { accountId: account.id, canSend: account.outboundEnabled, emailAddress: account.emailAddress, displayName: account.displayName }]]);
}
