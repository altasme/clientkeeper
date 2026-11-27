// Which mailboxes a Webmail Connect integration may hand out at all (the
// tenant boundary), and which of those one of its users can open right
// now (their live grants). Both are re-read from the database on every
// request; nothing here is cached in the session.
//
// GRANTABLE (layer 2 of clienthub/d1/schema.sql's Webmail Connect block):
// an active mail_accounts row that is EITHER
//   (a) one of this integration's own client's hosted mailboxes: an
//       email_mailboxes row with mail_account_id = that account and status
//       'active', whose email_services row is 'active' and has
//       client_id = the integration's client_id; OR
//   (b) explicitly attached to this integration by Altaventures staff in
//       mail_client_integration_mailboxes.
// So one client's panel can never grant access into another client's
// mailbox, and nothing the integration itself sends can widen this set:
// (a) is derived from Email Services records only staff write, (b) is a
// staff-only table.
//
// A considered difference from the mailbox-password login
// (../mailClient/account.ts), which only ever admits client-hosted
// mailboxes: that restriction exists because a SHARED mailbox's password
// is known to many people and a password login would bypass per-person
// revocation. Here no password exists at all. Every person is admitted
// individually by their own panel's Super Admin, and revoking that one
// grant ends that one person's access on their next request. That's why
// (b) can safely include a shared mailbox (e.g. Altaventures' own
// sales@altasme.com for the reference demo), where the password login
// must not.
//
// LIVE grants: the caller's mail_external_mailbox_access rows, joined to
// an ACTIVE integration and to the grantable set above, with can_read = 1
// (a grant that can't even read is no grant). A grant that drops out of
// the grantable set (service suspended, mailbox deleted, staff detached
// it) is counted as "unavailable" rather than silently vanishing, so the
// UI can say "service unavailable" instead of "no mailbox assigned".

import type { MailAccess } from "@altasme/webmail-kit/access";

export interface ConnectIntegration {
  id: string;
  clientId: string;
  name: string;
  status: "active" | "disabled";
}

export interface ConnectGrant {
  mailAccountId: string;
  emailAddress: string;
  displayName: string;
  outboundEnabled: boolean;
  canRead: boolean;
  canSend: boolean;
  canDelete: boolean;
  canManageSettings: boolean;
  isDefault: boolean;
}

export type ConnectPermission = "read" | "send" | "delete" | "settings";

// `m` = mail_accounts, `i` = mail_client_integrations. True when m is
// grantable by i (rules (a) and (b) above). Shared by the grant API and
// the live-grant query so the two can never disagree.
export const GRANTABLE_CONDITION = `m.is_active = 1 AND (
    EXISTS (
      SELECT 1 FROM email_mailboxes mb JOIN email_services s ON s.id = mb.service_id
      WHERE mb.mail_account_id = m.id AND mb.status = 'active' AND s.status = 'active' AND s.client_id = i.client_id
    )
    OR EXISTS (
      SELECT 1 FROM mail_client_integration_mailboxes im WHERE im.integration_id = i.id AND im.mail_account_id = m.id
    )
  )`;

interface IntegrationRow {
  id: string;
  client_id: string;
  name: string;
  status: "active" | "disabled";
}

export async function findIntegration(db: D1Database, id: string): Promise<ConnectIntegration | null> {
  const r = await db.prepare(`SELECT id, client_id, name, status FROM mail_client_integrations WHERE id = ?`).bind(id).first<IntegrationRow>();
  return r ? { id: r.id, clientId: r.client_id, name: r.name, status: r.status } : null;
}

export async function findActiveIntegration(db: D1Database, id: string): Promise<ConnectIntegration | null> {
  const i = await findIntegration(db, id);
  return i && i.status === "active" ? i : null;
}

interface GrantRow {
  mail_account_id: string;
  email_address: string;
  display_name: string;
  outbound_enabled: number;
  can_read: number;
  can_send: number;
  can_delete: number;
  can_manage_settings: number;
  is_default: number;
  usable: number;
}

/**
 * The caller's grants as they stand right now. `grants` holds only usable
 * ones (active integration, grantable mailbox, can_read = 1), ordered
 * default-first. `unavailableCount` = grants that exist but whose mailbox
 * is currently outside the grantable set (or inactive).
 */
export async function loadLiveGrants(db: D1Database, integrationId: string, externalUserId: string): Promise<{ grants: ConnectGrant[]; unavailableCount: number }> {
  const rows = await db
    .prepare(
      `SELECT g.mail_account_id, m.email_address, m.display_name, m.outbound_enabled,
              g.can_read, g.can_send, g.can_delete, g.can_manage_settings, g.is_default,
              CASE WHEN ${GRANTABLE_CONDITION} THEN 1 ELSE 0 END AS usable
       FROM mail_external_mailbox_access g
       JOIN mail_client_integrations i ON i.id = g.integration_id AND i.status = 'active'
       JOIN mail_accounts m ON m.id = g.mail_account_id
       WHERE g.integration_id = ? AND g.external_user_id = ? AND g.can_read = 1
       ORDER BY g.is_default DESC, m.sort_order, m.email_address`
    )
    .bind(integrationId, externalUserId)
    .all<GrantRow>();
  const grants: ConnectGrant[] = [];
  let unavailableCount = 0;
  for (const r of rows.results) {
    if (!r.usable) {
      unavailableCount += 1;
      continue;
    }
    grants.push({
      mailAccountId: r.mail_account_id,
      emailAddress: r.email_address,
      displayName: r.display_name,
      outboundEnabled: !!r.outbound_enabled,
      canRead: !!r.can_read,
      canSend: !!r.can_send,
      canDelete: !!r.can_delete,
      canManageSettings: !!r.can_manage_settings,
      isDefault: !!r.is_default,
    });
  }
  return { grants, unavailableCount };
}

/** Whether this grant allows `permission`. Reading is implied by every live grant. */
export function grantAllows(grant: ConnectGrant, permission: ConnectPermission): boolean {
  switch (permission) {
    case "read":
      return grant.canRead;
    case "send":
      return grant.canSend && grant.outboundEnabled;
    case "delete":
      return grant.canDelete;
    case "settings":
      return grant.canManageSettings;
  }
}

/**
 * The access map @altasme/webmail-kit's query/action functions take,
 * holding exactly the given grants. Package functions scope every SQL
 * statement by `account_id IN (<these ids>)`, so this is what confines
 * them. canSend reflects the grant's own can_send AND the mailbox's
 * outbound switch.
 */
export function accessFor(grants: ConnectGrant[]): MailAccess {
  return new Map(grants.map((g) => [g.mailAccountId, { accountId: g.mailAccountId, canSend: grantAllows(g, "send"), emailAddress: g.emailAddress, displayName: g.displayName }]));
}

/** Resolves an address to a mailbox this integration may grant, or null (not found and not-grantable look the same). */
export async function findGrantableMailbox(db: D1Database, integrationId: string, normalizedAddress: string): Promise<{ id: string; emailAddress: string } | null> {
  const r = await db
    .prepare(
      `SELECT m.id, m.email_address FROM mail_accounts m JOIN mail_client_integrations i ON i.id = ?
       WHERE m.email_address = ? AND ${GRANTABLE_CONDITION}`
    )
    .bind(integrationId, normalizedAddress)
    .first<{ id: string; email_address: string }>();
  return r ? { id: r.id, emailAddress: r.email_address } : null;
}
