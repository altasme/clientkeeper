// Altaventures' own registry of Webmail Connect integrations (spec §9,
// "master control"): which client each registered admin panel belongs to,
// whether it's active, its API secret (generate / rotate; disable =
// revoke), and which extra mailboxes staff allow it to grant. Called only
// from the staff routes under functions/api/app/mail-integrations/*, so
// the staff middleware has already authenticated the caller; mutations
// additionally need owner/admin (the routes check, same gate as Email
// Services).
//
// This is NOT where a client's users get mailbox access: that's the
// client's own Super Admin, from their own panel, through the
// integration's API (./admin.ts). Staff here only set the outer boundary.
//
// The raw secret is returned exactly once, from create/rotate. Only its
// SHA-256 is stored. List/detail never include it, or its hash.

import { isValidEmail, normalizeEmail } from "@altasme/webmail-kit/address";
import { logMailEvent } from "@altasme/webmail-kit/events";
import { generateIntegrationSecret } from "./admin";

export type Result<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

export interface IntegrationSummary {
  id: string;
  clientId: string;
  clientName: string;
  businessName: string;
  name: string;
  status: "active" | "disabled";
  attachedMailboxCount: number;
  grantCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface IntegrationMailbox {
  mailAccountId: string;
  emailAddress: string;
  displayName: string;
  source: "client_hosted" | "attached";
  grantCount: number;
}

interface SummaryRow {
  id: string;
  client_id: string;
  full_name: string;
  business_name: string;
  name: string;
  status: "active" | "disabled";
  attached: number;
  grants: number;
  created_at: string;
  updated_at: string;
}

const SUMMARY_SQL = `SELECT i.id, i.client_id, c.full_name, c.business_name, i.name, i.status, i.created_at, i.updated_at,
    (SELECT COUNT(*) FROM mail_client_integration_mailboxes im WHERE im.integration_id = i.id) AS attached,
    (SELECT COUNT(*) FROM mail_external_mailbox_access g WHERE g.integration_id = i.id) AS grants
  FROM mail_client_integrations i JOIN clients c ON c.id = i.client_id`;

function toSummary(r: SummaryRow): IntegrationSummary {
  return {
    id: r.id,
    clientId: r.client_id,
    clientName: r.full_name,
    businessName: r.business_name,
    name: r.name,
    status: r.status,
    attachedMailboxCount: r.attached,
    grantCount: r.grants,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const staffActor = (staffId: string) => `staff:${staffId}`;

export async function listIntegrations(db: D1Database): Promise<IntegrationSummary[]> {
  const rows = await db.prepare(`${SUMMARY_SQL} ORDER BY i.created_at DESC`).all<SummaryRow>();
  return rows.results.map(toSummary);
}

async function getSummary(db: D1Database, id: string): Promise<IntegrationSummary | null> {
  const r = await db.prepare(`${SUMMARY_SQL} WHERE i.id = ?`).bind(id).first<SummaryRow>();
  return r ? toSummary(r) : null;
}

/** Everything the staff detail view shows: the integration and the full set of mailboxes it may grant, by source. */
export async function getIntegrationDetail(db: D1Database, id: string): Promise<Result<{ integration: IntegrationSummary; mailboxes: IntegrationMailbox[] }>> {
  const integration = await getSummary(db, id);
  if (!integration) return { ok: false, status: 404, error: "Integration not found." };
  const rows = await db
    .prepare(
      `SELECT m.id, m.email_address, m.display_name,
              CASE WHEN EXISTS (SELECT 1 FROM mail_client_integration_mailboxes im WHERE im.integration_id = ? AND im.mail_account_id = m.id) THEN 'attached' ELSE 'client_hosted' END AS source,
              (SELECT COUNT(*) FROM mail_external_mailbox_access g WHERE g.integration_id = ? AND g.mail_account_id = m.id) AS grants
       FROM mail_accounts m
       WHERE m.is_active = 1 AND (
         EXISTS (SELECT 1 FROM email_mailboxes mb JOIN email_services s ON s.id = mb.service_id
                 WHERE mb.mail_account_id = m.id AND mb.status = 'active' AND s.status = 'active' AND s.client_id = ?)
         OR EXISTS (SELECT 1 FROM mail_client_integration_mailboxes im WHERE im.integration_id = ? AND im.mail_account_id = m.id)
       )
       ORDER BY m.email_address`
    )
    .bind(id, id, integration.clientId, id)
    .all<{ id: string; email_address: string; display_name: string; source: "client_hosted" | "attached"; grants: number }>();
  return {
    ok: true,
    value: {
      integration,
      mailboxes: rows.results.map((r) => ({ mailAccountId: r.id, emailAddress: r.email_address, displayName: r.display_name, source: r.source, grantCount: r.grants })),
    },
  };
}

export async function createIntegration(db: D1Database, input: { clientId: unknown; name: unknown; staffId: string }): Promise<Result<{ integration: IntegrationSummary; secret: string }>> {
  const clientId = typeof input.clientId === "string" ? input.clientId : "";
  const name = typeof input.name === "string" ? input.name.trim().slice(0, 120) : "";
  if (!name) return { ok: false, status: 400, error: "A name is required." };
  const client = clientId ? await db.prepare(`SELECT id FROM clients WHERE id = ?`).bind(clientId).first<{ id: string }>() : null;
  if (!client) return { ok: false, status: 400, error: "Choose an existing client." };
  const id = crypto.randomUUID();
  const { secret, hash } = await generateIntegrationSecret(id);
  const now = new Date().toISOString();
  await db
    .prepare(`INSERT INTO mail_client_integrations (id, client_id, name, secret_hash, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`)
    .bind(id, client.id, name, hash, input.staffId, now, now)
    .run();
  await logMailEvent(db, { type: "connect_integration_created", data: { integrationId: id, clientId: client.id, name }, actorId: staffActor(input.staffId) });
  return { ok: true, value: { integration: (await getSummary(db, id))!, secret } };
}

export async function updateIntegration(db: D1Database, input: { id: string; name: unknown; status: unknown; staffId: string }): Promise<Result<{ integration: IntegrationSummary }>> {
  const existing = await getSummary(db, input.id);
  if (!existing) return { ok: false, status: 404, error: "Integration not found." };
  const name = input.name === undefined ? existing.name : typeof input.name === "string" ? input.name.trim().slice(0, 120) : "";
  if (!name) return { ok: false, status: 400, error: "A name is required." };
  const status = input.status === undefined ? existing.status : input.status;
  if (status !== "active" && status !== "disabled") return { ok: false, status: 400, error: "status must be active or disabled." };
  await db.prepare(`UPDATE mail_client_integrations SET name = ?, status = ?, updated_at = ? WHERE id = ?`).bind(name, status, new Date().toISOString(), input.id).run();
  await logMailEvent(db, { type: "connect_integration_updated", data: { integrationId: input.id, before: { name: existing.name, status: existing.status }, after: { name, status } }, actorId: staffActor(input.staffId) });
  return { ok: true, value: { integration: (await getSummary(db, input.id))! } };
}

/** Replaces the secret. The old one stops working immediately. */
export async function rotateIntegrationSecret(db: D1Database, input: { id: string; staffId: string }): Promise<Result<{ secret: string }>> {
  if (!(await getSummary(db, input.id))) return { ok: false, status: 404, error: "Integration not found." };
  const { secret, hash } = await generateIntegrationSecret(input.id);
  await db.prepare(`UPDATE mail_client_integrations SET secret_hash = ?, updated_at = ? WHERE id = ?`).bind(hash, new Date().toISOString(), input.id).run();
  await logMailEvent(db, { type: "connect_integration_secret_rotated", data: { integrationId: input.id }, actorId: staffActor(input.staffId) });
  return { ok: true, value: { secret } };
}

/**
 * Lets this integration grant a mailbox that isn't one of its client's
 * hosted mailboxes (e.g. an Altaventures altasme.com mailbox). Refuses a
 * mailbox hosted for a DIFFERENT client: that would hand one client's
 * panel access into another client's mail, which is exactly what the
 * tenant boundary exists to prevent, so not even staff can do it by mistake.
 */
export async function attachMailbox(db: D1Database, input: { id: string; address: unknown; staffId: string }): Promise<Result<{ mailAccountId: string }>> {
  const integration = await getSummary(db, input.id);
  if (!integration) return { ok: false, status: 404, error: "Integration not found." };
  const address = typeof input.address === "string" ? normalizeEmail(input.address.slice(0, 320)) : "";
  if (!isValidEmail(address)) return { ok: false, status: 400, error: "Enter a mailbox address." };
  const account = await db.prepare(`SELECT id FROM mail_accounts WHERE email_address = ? AND is_active = 1`).bind(address).first<{ id: string }>();
  if (!account) return { ok: false, status: 404, error: "No active webmail mailbox has that address." };
  const foreign = await db
    .prepare(
      `SELECT 1 AS x FROM email_mailboxes mb JOIN email_services s ON s.id = mb.service_id
       WHERE mb.mail_account_id = ? AND mb.status NOT IN ('deleted', 'discarded') AND s.client_id != ?`
    )
    .bind(account.id, integration.clientId)
    .first<{ x: number }>();
  if (foreign) return { ok: false, status: 409, error: "That mailbox is hosted for a different client, so this client's panel can't be given access to it." };
  await db
    .prepare(`INSERT OR IGNORE INTO mail_client_integration_mailboxes (integration_id, mail_account_id, created_by, created_at) VALUES (?, ?, ?, ?)`)
    .bind(input.id, account.id, input.staffId, new Date().toISOString())
    .run();
  await logMailEvent(db, { accountId: account.id, type: "connect_mailbox_attached", data: { integrationId: input.id }, actorId: staffActor(input.staffId) });
  return { ok: true, value: { mailAccountId: account.id } };
}

/**
 * Removes a staff attachment. Existing grants to it stay in the table but
 * stop working on the next request (unless the mailbox is also one of the
 * client's hosted mailboxes).
 */
export async function detachMailbox(db: D1Database, input: { id: string; mailAccountId: unknown; staffId: string }): Promise<Result<{ detached: boolean }>> {
  if (!(await getSummary(db, input.id))) return { ok: false, status: 404, error: "Integration not found." };
  const mailAccountId = typeof input.mailAccountId === "string" ? input.mailAccountId : "";
  const r = await db.prepare(`DELETE FROM mail_client_integration_mailboxes WHERE integration_id = ? AND mail_account_id = ?`).bind(input.id, mailAccountId).run();
  const detached = (r.meta.changes ?? 0) > 0;
  if (detached) await logMailEvent(db, { accountId: mailAccountId, type: "connect_mailbox_detached", data: { integrationId: input.id }, actorId: staffActor(input.staffId) });
  return { ok: true, value: { detached } };
}
