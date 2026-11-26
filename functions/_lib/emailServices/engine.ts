// Email services entitlement + provisioning engine (CLAUDE.md §34).
//
// The one module that changes mailbox, entitlement, plan and domain state.
// Routes (and later clienthub's client-facing module) call these functions;
// they never write those tables themselves.
//
// Race safety. Every check that guards a limited resource is done INSIDE
// the same single SQL statement that consumes it (INSERT ... SELECT ...
// WHERE <capacity holds>, UPDATE ... WHERE <state and capacity hold>).
// D1 runs each statement atomically and serializes writes, so two
// simultaneous requests can never both pass a "one slot left" check: the
// second statement sees the first one's row and matches nothing. Never
// split such a check into a SELECT followed by a separate write. Follow-up
// SELECTs after a zero-row write are only used to explain WHY it failed.
//
// Provider calls happen between two such statements (reserve -> call ->
// record outcome), never inside a transaction, and their outcome decides
// whether the slot is released:
//   success                     -> active
//   failure, not performed      -> failed (released)
//   failure, outcome unknown    -> needs_review (held until resolved)

import {
  COUNTED_MAILBOX_SQL,
  LIFECYCLE_FROM,
  LIFECYCLE_REQUIRES_REASON,
  MANUALLY_FULFILLABLE_STATUSES,
  PROVISIONABLE_SERVICE_STATUSES,
  RESERVATION_LEASE_MS,
  addInterval,
  computeAllowance,
  effectiveServiceStatus,
  staffCanManageMailboxes,
  type Allowance,
  type LifecycleAction,
  type MailboxStatus,
  type ServiceStatus,
} from "./policy";
import { auditStatement, clientActivityStatement, provisioningLogStatement, type Actor } from "./logs";
import { PROVIDER_INBOUND_SOURCE, callProvider, type EmailHostingProvider, type ProviderError, type ProviderMailbox } from "./provider";
import { reconcileMailboxes, type Discrepancy } from "./reconcile";
import { normalizeLocalPart, normalizeSmtpProfileKey } from "./validation";

export type EngineResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string; code: string; details?: Record<string, unknown> };

function fail(status: number, code: string, error: string, details?: Record<string, unknown>): { ok: false; status: number; error: string; code: string; details?: Record<string, unknown> } {
  return { ok: false, status, code, error, details };
}

const PROVISIONABLE_SQL_LIST = PROVISIONABLE_SERVICE_STATUSES.map((s) => `'${s}'`).join(", ");

export interface ServiceRow {
  id: string;
  client_id: string;
  provider: "zcom";
  provider_service_id: string | null;
  plan_id: string | null;
  plan_name_snapshot: string | null;
  included_mailboxes: number;
  storage_quota_mb: number | null;
  price_php: number | null;
  additional_mailbox_price_php: number | null;
  status: ServiceStatus;
  status_reason: string | null;
  starts_at: string | null;
  expires_at: string | null;
  provider_status: string | null;
  storage_used_mb: number | null;
  sync_status: string;
  last_sync_at: string | null;
  last_sync_error: string | null;
  internal_notes: string | null;
  created_by: string | null;
  decommissioned_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MailboxRow {
  id: string;
  service_id: string;
  domain_id: string;
  local_part: string;
  address: string;
  is_primary: number;
  status: MailboxStatus;
  inbound_source: "cloudflare_email_routing" | "zcom_poll_sync";
  provider_service_id: string | null;
  provider_mailbox_id: string | null;
  mail_account_id: string | null;
  failure_code: string | null;
  last_error: string | null;
  idempotency_key: string | null;
  reserved_until: string | null;
  created_by: string | null;
  created_by_type: string;
  provisioned_at: string | null;
  deleted_at: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DomainRow {
  id: string;
  service_id: string;
  domain: string;
  provider_domain_id: string | null;
  is_primary: number;
  status: "active" | "removed";
  created_at: string;
}

const nowIso = () => new Date().toISOString();
const plusMs = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

function isUniqueViolation(err: unknown, column: string): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("UNIQUE constraint failed") && msg.includes(column);
}

export async function loadService(db: D1Database, serviceId: string): Promise<ServiceRow | null> {
  return db.prepare(`SELECT * FROM email_services WHERE id = ?`).bind(serviceId).first<ServiceRow>();
}

export async function loadMailbox(db: D1Database, serviceId: string, mailboxId: string): Promise<MailboxRow | null> {
  return db.prepare(`SELECT * FROM email_mailboxes WHERE id = ? AND service_id = ?`).bind(mailboxId, serviceId).first<MailboxRow>();
}

// ---------------------------------------------------------------------------
// Allowance

export async function getAllowance(db: D1Database, serviceId: string, now = nowIso()): Promise<Allowance | null> {
  const row = await db
    .prepare(
      `SELECT s.included_mailboxes AS included,
              COALESCE((SELECT SUM(quantity) FROM email_service_entitlements e WHERE e.service_id = s.id AND e.kind = 'addon'), 0) AS additional,
              COALESCE((SELECT SUM(quantity) FROM email_service_entitlements e WHERE e.service_id = s.id AND e.kind = 'override'), 0) AS overrides,
              (SELECT COUNT(*) FROM email_mailboxes m WHERE m.service_id = s.id AND m.status = 'active') AS active,
              (SELECT COUNT(*) FROM email_mailboxes m WHERE m.service_id = s.id AND m.status <> 'active' AND ${COUNTED_MAILBOX_SQL}) AS pending
       FROM email_services s WHERE s.id = ?`
    )
    .bind(now, serviceId)
    .first<{ included: number; additional: number; overrides: number; active: number; pending: number }>();
  if (!row) return null;
  return computeAllowance({
    included: Number(row.included),
    additional: Number(row.additional),
    overrides: Number(row.overrides),
    active: Number(row.active),
    pending: Number(row.pending),
  });
}

// SQL: the service's total allowance (alias s).
const TOTAL_ALLOWANCE_SQL = `(s.included_mailboxes + COALESCE((SELECT SUM(e.quantity) FROM email_service_entitlements e WHERE e.service_id = s.id), 0))`;
// SQL: mailboxes counted against the allowance (alias s). One `?` (now).
const COUNTED_SQL = `(SELECT COUNT(*) FROM email_mailboxes m WHERE m.service_id = s.id AND ${COUNTED_MAILBOX_SQL})`;

// ---------------------------------------------------------------------------
// Sweeps (centralized time-based rules, applied lazily on read and before
// any provisioning decision; there is no cron in Pages Functions).

// reserved past its lease  -> failed (the provider was never called)
// provisioning/deleting past its lease -> needs_review (outcome unknown)
export async function sweepStaleMailboxes(db: D1Database, serviceId: string | null, now = nowIso()): Promise<number> {
  const scope = serviceId ? `AND service_id = ?` : ``;
  const bindScope = (stmt: D1PreparedStatement, ...args: unknown[]) => (serviceId ? stmt.bind(...args, serviceId) : stmt.bind(...args));

  const expired = await bindScope(
    db.prepare(
      `UPDATE email_mailboxes SET status = 'failed', failure_code = 'reservation_expired', last_error = 'Reservation expired before the provider was called.', reserved_until = NULL, updated_at = ?
       WHERE status = 'reserved' AND reserved_until <= ? ${scope} RETURNING id, service_id`
    ),
    now,
    now
  ).all<{ id: string; service_id: string }>();

  const stuck = await bindScope(
    db.prepare(
      `UPDATE email_mailboxes SET status = 'needs_review', failure_code = 'unknown_outcome',
         last_error = CASE status WHEN 'deleting' THEN 'Delete request did not complete; the mailbox may or may not still exist at the provider.' ELSE 'Provisioning did not complete; the mailbox may or may not exist at the provider.' END,
         reserved_until = NULL, updated_at = ?
       WHERE status IN ('provisioning', 'deleting') AND reserved_until <= ? ${scope} RETURNING id, service_id`
    ),
    now,
    now
  ).all<{ id: string; service_id: string }>();

  const system: Actor = { type: "system", id: null };
  const audits = [
    ...expired.results.map((r) => auditStatement(db, { serviceId: r.service_id, mailboxId: r.id, actor: system, action: "mailbox_reservation_expired", after: { status: "failed" }, now })),
    ...stuck.results.map((r) => auditStatement(db, { serviceId: r.service_id, mailboxId: r.id, actor: system, action: "mailbox_outcome_unknown", after: { status: "needs_review" }, now })),
  ];
  if (audits.length) await db.batch(audits);
  return audits.length;
}

// active services past expires_at -> expired. Mailboxes are never touched.
export async function sweepExpiredServices(db: D1Database, serviceId: string | null, now = nowIso()): Promise<number> {
  const scope = serviceId ? `AND id = ?` : ``;
  const stmt = db.prepare(
    `UPDATE email_services SET status = 'expired', status_reason = 'Expiration date passed.', updated_at = ?
     WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ? ${scope} RETURNING id`
  );
  const res = await (serviceId ? stmt.bind(now, now, serviceId) : stmt.bind(now, now)).all<{ id: string }>();
  if (res.results.length) {
    await db.batch(
      res.results.map((r) =>
        auditStatement(db, { serviceId: r.id, actor: { type: "system", id: null }, action: "service_expired", before: { status: "active" }, after: { status: "expired" }, now })
      )
    );
  }
  return res.results.length;
}

// ---------------------------------------------------------------------------
// Mailbox provisioning

export interface ProvisionInput {
  serviceId: string;
  domainId: string;
  localPart: string;
  password: string;
  isPrimary: boolean;
  idempotencyKey: string | null;
  actor: Actor;
  now?: string;
}

export interface ProvisionOutcome {
  mailbox: MailboxRow;
  duplicateRequest: boolean;
  providerError: ProviderError | null;
}

export async function provisionMailbox(db: D1Database, provider: EmailHostingProvider, input: ProvisionInput): Promise<EngineResult<ProvisionOutcome>> {
  const now = input.now ?? nowIso();

  if (input.idempotencyKey) {
    const existing = await db.prepare(`SELECT * FROM email_mailboxes WHERE idempotency_key = ?`).bind(input.idempotencyKey).first<MailboxRow>();
    if (existing) {
      if (existing.service_id !== input.serviceId) return fail(409, "idempotency_conflict", "This request key was already used for a different service.");
      return { ok: true, value: { mailbox: existing, duplicateRequest: true, providerError: null } };
    }
  }

  await sweepStaleMailboxes(db, input.serviceId, now);

  const domain = await db
    .prepare(`SELECT * FROM email_domains WHERE id = ? AND service_id = ? AND status = 'active'`)
    .bind(input.domainId, input.serviceId)
    .first<DomainRow>();
  if (!domain) return fail(404, "domain_not_found", "That domain is not assigned to this service.");

  const id = crypto.randomUUID();
  const address = `${input.localPart}@${domain.domain}`;
  let changes: number;
  try {
    // THE reservation. Service state, expiry, plan presence, domain
    // ownership and remaining capacity are all checked in this one
    // statement; see the header comment before changing it.
    const res = await db
      .prepare(
        `INSERT INTO email_mailboxes (id, service_id, domain_id, local_part, address, is_primary, status, inbound_source, provider_service_id, idempotency_key, reserved_until, created_by, created_by_type, created_at, updated_at)
         SELECT ?, s.id, d.id, ?, ?, ?, 'reserved', ?, s.provider_service_id, ?, ?, ?, ?, ?, ?
         FROM email_services s
         JOIN email_domains d ON d.id = ? AND d.service_id = s.id AND d.status = 'active'
         WHERE s.id = ?
           AND s.status IN (${PROVISIONABLE_SQL_LIST})
           AND s.plan_id IS NOT NULL
           AND (s.expires_at IS NULL OR s.expires_at > ?)
           AND ${TOTAL_ALLOWANCE_SQL} > ${COUNTED_SQL}`
      )
      .bind(
        id,
        input.localPart,
        address,
        input.isPrimary ? 1 : 0,
        PROVIDER_INBOUND_SOURCE[provider.name],
        input.idempotencyKey,
        plusMs(now, RESERVATION_LEASE_MS),
        input.actor.id,
        input.actor.type,
        now,
        now,
        input.domainId,
        input.serviceId,
        now,
        now
      )
      .run();
    changes = res.meta.changes ?? 0;
  } catch (err) {
    // A repeat of the same request can collide on idempotency_key OR on
    // address/primary first (SQLite reports whichever index it checks
    // first), so look the key up on any unique violation.
    if (input.idempotencyKey && String(err instanceof Error ? err.message : err).includes("UNIQUE constraint failed")) {
      const existing = await db.prepare(`SELECT * FROM email_mailboxes WHERE idempotency_key = ?`).bind(input.idempotencyKey).first<MailboxRow>();
      if (existing && existing.service_id === input.serviceId) return { ok: true, value: { mailbox: existing, duplicateRequest: true, providerError: null } };
    }
    if (isUniqueViolation(err, "address")) {
      return fail(409, "address_taken", `${address} already has a mailbox record. Retry or discard the existing one instead.`);
    }
    if (isUniqueViolation(err, "service_id")) return fail(409, "primary_exists", "This service already has a primary mailbox.");
    throw err;
  }

  if (changes === 0) return explainReservationFailure(db, input.serviceId, now);

  const mailbox = (await db.prepare(`SELECT * FROM email_mailboxes WHERE id = ?`).bind(id).first<MailboxRow>())!;
  await db.batch([auditStatement(db, { serviceId: input.serviceId, mailboxId: id, actor: input.actor, action: "mailbox_reserved", after: { address, isPrimary: input.isPrimary }, now })]);

  return runProvisioning(db, provider, mailbox, input.password, input.actor, now);
}

async function explainReservationFailure(db: D1Database, serviceId: string, now: string): Promise<{ ok: false; status: number; error: string; code: string; details?: Record<string, unknown> }> {
  const service = await loadService(db, serviceId);
  if (!service) return fail(404, "service_not_found", "Email service not found.");
  const effective = effectiveServiceStatus(service.status, service.expires_at, now);
  if (!PROVISIONABLE_SERVICE_STATUSES.includes(effective)) {
    return fail(409, "service_not_provisionable", `New mailboxes can't be created while the service is ${effective.replace("_", " ")}.`);
  }
  if (!service.plan_id) return fail(409, "no_plan", "Assign a plan before creating mailboxes.");
  const allowance = await getAllowance(db, serviceId, now);
  return fail(409, "allowance_exhausted", "No mailbox slots are available on this service.", { allowance });
}

// reserved -> provisioning -> provider call -> active | failed | needs_review
async function runProvisioning(db: D1Database, provider: EmailHostingProvider, mailbox: MailboxRow, password: string, actor: Actor, now: string): Promise<EngineResult<ProvisionOutcome>> {
  const service = (await loadService(db, mailbox.service_id))!;
  const domain = (await db.prepare(`SELECT * FROM email_domains WHERE id = ?`).bind(mailbox.domain_id).first<DomainRow>())!;

  const claimed = await db
    .prepare(`UPDATE email_mailboxes SET status = 'provisioning', reserved_until = ?, updated_at = ? WHERE id = ? AND status = 'reserved' AND reserved_until > ?`)
    .bind(plusMs(now, RESERVATION_LEASE_MS), now, mailbox.id, now)
    .run();
  if ((claimed.meta.changes ?? 0) === 0) return fail(409, "reservation_lost", "The reservation for this mailbox expired or changed. Try again.");

  const { result, durationMs } = await callProvider(() =>
    provider.createMailbox({
      providerServiceId: service.provider_service_id,
      domain: domain.domain,
      providerDomainId: domain.provider_domain_id,
      localPart: mailbox.local_part,
      address: mailbox.address,
      password,
      storageQuotaMb: service.storage_quota_mb,
      idempotencyKey: mailbox.id,
    })
  );
  const done = new Date(Math.max(Date.parse(now), Date.now())).toISOString();

  const statements: D1PreparedStatement[] = [];
  let providerError: ProviderError | null = null;

  if (result.ok) {
    statements.push(
      db
        .prepare(
          `UPDATE email_mailboxes SET status = 'active', provider_mailbox_id = ?, provider_service_id = COALESCE(?, provider_service_id), provisioned_at = ?, failure_code = NULL, last_error = NULL, reserved_until = NULL, updated_at = ?
           WHERE id = ? AND status IN ('provisioning', 'needs_review')`
        )
        .bind(result.value.providerMailboxId, result.value.providerServiceId, done, done, mailbox.id),
      db.prepare(`UPDATE email_services SET status = 'pending_setup', status_reason = NULL, updated_at = ? WHERE id = ? AND status = 'provisioning_error'`).bind(done, service.id)
    );
  } else {
    providerError = result.error;
    // A "duplicate" from the provider means a mailbox with this address
    // already exists there (possibly from an earlier attempt whose outcome
    // we lost). It occupies a slot, so hold it for review instead of
    // releasing it.
    const holdSlot = result.error.outcome === "unknown" || result.error.code === "duplicate";
    statements.push(
      db
        .prepare(`UPDATE email_mailboxes SET status = ?, failure_code = ?, last_error = ?, reserved_until = NULL, updated_at = ? WHERE id = ? AND status = 'provisioning'`)
        .bind(holdSlot ? "needs_review" : "failed", result.error.code, result.error.message.slice(0, 500), done, mailbox.id)
    );
    if (!holdSlot && mailbox.is_primary && service.status === "pending_setup") {
      statements.push(
        db
          .prepare(`UPDATE email_services SET status = 'provisioning_error', status_reason = ?, updated_at = ? WHERE id = ? AND status = 'pending_setup'`)
          .bind(`Initial mailbox provisioning failed: ${result.error.message}`.slice(0, 500), done, service.id)
      );
    }
  }
  statements.push(
    provisioningLogStatement(db, { serviceId: service.id, mailboxId: mailbox.id, provider: service.provider, operation: "create_mailbox", error: providerError, durationMs, actor, now: done }),
    auditStatement(db, {
      serviceId: service.id,
      mailboxId: mailbox.id,
      actor,
      action: result.ok ? "mailbox_provisioned" : "mailbox_provisioning_failed",
      after: result.ok ? { address: mailbox.address, providerMailboxId: result.value.providerMailboxId } : { address: mailbox.address, errorCode: result.error.code },
      now: done,
    })
  );
  await db.batch(statements);

  const final = (await db.prepare(`SELECT * FROM email_mailboxes WHERE id = ?`).bind(mailbox.id).first<MailboxRow>())!;
  return { ok: true, value: { mailbox: final, duplicateRequest: false, providerError } };
}

// failed -> reserved (capacity re-checked atomically) -> provisioning ...
// The password is required again: it was never stored.
export async function retryMailbox(
  db: D1Database,
  provider: EmailHostingProvider,
  input: { serviceId: string; mailboxId: string; password: string; actor: Actor; now?: string }
): Promise<EngineResult<ProvisionOutcome>> {
  const now = input.now ?? nowIso();
  await sweepStaleMailboxes(db, input.serviceId, now);
  const mailbox = await loadMailbox(db, input.serviceId, input.mailboxId);
  if (!mailbox) return fail(404, "mailbox_not_found", "Mailbox not found.");
  if (mailbox.status !== "failed") return fail(409, "not_retryable", `Only failed mailboxes can be retried (this one is ${mailbox.status.replace("_", " ")}).`);

  const res = await db
    .prepare(
      `UPDATE email_mailboxes SET status = 'reserved', reserved_until = ?, failure_code = NULL, last_error = NULL, updated_at = ?
       WHERE id = ? AND status = 'failed'
         AND EXISTS (
           SELECT 1 FROM email_services s
           JOIN email_domains d ON d.id = email_mailboxes.domain_id AND d.service_id = s.id AND d.status = 'active'
           WHERE s.id = email_mailboxes.service_id
             AND s.status IN (${PROVISIONABLE_SQL_LIST})
             AND s.plan_id IS NOT NULL
             AND (s.expires_at IS NULL OR s.expires_at > ?)
             AND ${TOTAL_ALLOWANCE_SQL} > ${COUNTED_SQL}
         )`
    )
    .bind(plusMs(now, RESERVATION_LEASE_MS), now, mailbox.id, now, now)
    .run();
  if ((res.meta.changes ?? 0) === 0) {
    const domain = await db.prepare(`SELECT status FROM email_domains WHERE id = ?`).bind(mailbox.domain_id).first<{ status: string }>();
    if (domain?.status !== "active") return fail(409, "domain_removed", "This mailbox's domain is no longer assigned to the service.");
    return explainReservationFailure(db, input.serviceId, now);
  }
  await db.batch([auditStatement(db, { serviceId: input.serviceId, mailboxId: mailbox.id, actor: input.actor, action: "mailbox_retry_reserved", now })]);
  const reserved = (await db.prepare(`SELECT * FROM email_mailboxes WHERE id = ?`).bind(mailbox.id).first<MailboxRow>())!;
  return runProvisioning(db, provider, reserved, input.password, input.actor, now);
}

// active | needs_review -> deleting -> provider delete -> deleted
// The slot is only released once the provider confirms (or reports the
// mailbox doesn't exist). Mailbox data is never deleted by anything else.
export async function deleteMailbox(
  db: D1Database,
  provider: EmailHostingProvider,
  input: { serviceId: string; mailboxId: string; reason: string; actor: Actor; now?: string }
): Promise<EngineResult<{ mailbox: MailboxRow; providerError: ProviderError | null }>> {
  const now = input.now ?? nowIso();
  await sweepStaleMailboxes(db, input.serviceId, now);
  const service = await loadService(db, input.serviceId);
  if (!service) return fail(404, "service_not_found", "Email service not found.");
  if (!staffCanManageMailboxes(service.status)) return fail(409, "service_cancelled", "This service has been decommissioned.");
  const mailbox = await loadMailbox(db, input.serviceId, input.mailboxId);
  if (!mailbox) return fail(404, "mailbox_not_found", "Mailbox not found.");
  if (mailbox.status !== "active" && mailbox.status !== "needs_review") {
    return fail(409, "not_deletable", `Only active or needs-review mailboxes can be deleted (this one is ${mailbox.status.replace("_", " ")}).`);
  }
  const previous = mailbox.status;

  const claimed = await db
    .prepare(`UPDATE email_mailboxes SET status = 'deleting', reserved_until = ?, updated_at = ? WHERE id = ? AND status = ?`)
    .bind(plusMs(now, RESERVATION_LEASE_MS), now, mailbox.id, previous)
    .run();
  if ((claimed.meta.changes ?? 0) === 0) return fail(409, "changed", "This mailbox changed while you were working. Refresh and try again.");

  const { result, durationMs } = await callProvider(() =>
    provider.deleteMailbox({ providerServiceId: service.provider_service_id, address: mailbox.address, providerMailboxId: mailbox.provider_mailbox_id })
  );
  const done = new Date(Math.max(Date.parse(now), Date.now())).toISOString();
  const confirmedGone = result.ok || result.error.code === "not_found";
  const providerError = result.ok ? null : result.error;

  let update: D1PreparedStatement;
  if (confirmedGone) {
    update = db
      .prepare(`UPDATE email_mailboxes SET status = 'deleted', deleted_at = ?, reserved_until = NULL, failure_code = NULL, last_error = NULL, updated_at = ? WHERE id = ? AND status = 'deleting'`)
      .bind(done, done, mailbox.id);
  } else if (providerError!.outcome === "unknown") {
    update = db
      .prepare(`UPDATE email_mailboxes SET status = 'needs_review', failure_code = ?, last_error = ?, reserved_until = NULL, updated_at = ? WHERE id = ? AND status = 'deleting'`)
      .bind(providerError!.code, `Delete outcome unknown: ${providerError!.message}`.slice(0, 500), done, mailbox.id);
  } else {
    update = db
      .prepare(`UPDATE email_mailboxes SET status = ?, failure_code = ?, last_error = ?, reserved_until = NULL, updated_at = ? WHERE id = ? AND status = 'deleting'`)
      .bind(previous, providerError!.code, `Delete failed: ${providerError!.message}`.slice(0, 500), done, mailbox.id);
  }

  await db.batch([
    update,
    provisioningLogStatement(db, { serviceId: service.id, mailboxId: mailbox.id, provider: service.provider, operation: "delete_mailbox", error: confirmedGone ? null : providerError, durationMs, actor: input.actor, now: done }),
    auditStatement(db, {
      serviceId: service.id,
      mailboxId: mailbox.id,
      actor: input.actor,
      action: confirmedGone ? "mailbox_deleted" : "mailbox_delete_failed",
      before: { status: previous },
      after: { address: mailbox.address, errorCode: providerError?.code ?? null },
      reason: input.reason,
      now: done,
    }),
  ]);
  const final = (await db.prepare(`SELECT * FROM email_mailboxes WHERE id = ?`).bind(mailbox.id).first<MailboxRow>())!;
  return { ok: true, value: { mailbox: final, providerError: confirmedGone ? null : providerError } };
}

// failed -> discarded: hides a dead attempt from the active list.
export async function discardMailbox(db: D1Database, input: { serviceId: string; mailboxId: string; actor: Actor; now?: string }): Promise<EngineResult<{ mailbox: MailboxRow }>> {
  const now = input.now ?? nowIso();
  const res = await db
    .prepare(`UPDATE email_mailboxes SET status = 'discarded', updated_at = ? WHERE id = ? AND service_id = ? AND status = 'failed' RETURNING *`)
    .bind(now, input.mailboxId, input.serviceId)
    .first<MailboxRow>();
  if (!res) {
    const existing = await loadMailbox(db, input.serviceId, input.mailboxId);
    if (!existing) return fail(404, "mailbox_not_found", "Mailbox not found.");
    return fail(409, "not_discardable", "Only failed mailboxes can be discarded.");
  }
  await db.batch([auditStatement(db, { serviceId: input.serviceId, mailboxId: input.mailboxId, actor: input.actor, action: "mailbox_discarded", now })]);
  return { ok: true, value: { mailbox: res } };
}

// Explicit human resolution of a needs_review mailbox, after checking the
// provider by hand (or reading a sync result). Never automatic.
//   exists -> active (the provider has it)
//   absent -> failed if it was never confirmed created, deleted otherwise
export async function resolveMailbox(
  db: D1Database,
  input: { serviceId: string; mailboxId: string; resolution: "exists" | "absent"; providerMailboxId: string | null; reason: string; actor: Actor; now?: string }
): Promise<EngineResult<{ mailbox: MailboxRow }>> {
  const now = input.now ?? nowIso();
  const mailbox = await loadMailbox(db, input.serviceId, input.mailboxId);
  if (!mailbox) return fail(404, "mailbox_not_found", "Mailbox not found.");
  if (mailbox.status !== "needs_review") return fail(409, "not_in_review", "Only mailboxes that need review can be resolved.");

  let update: D1PreparedStatement;
  let newStatus: MailboxStatus;
  if (input.resolution === "exists") {
    newStatus = "active";
    update = db
      .prepare(
        `UPDATE email_mailboxes SET status = 'active', provider_mailbox_id = COALESCE(?, provider_mailbox_id), provisioned_at = COALESCE(provisioned_at, ?), failure_code = NULL, last_error = NULL, updated_at = ?
         WHERE id = ? AND status = 'needs_review'`
      )
      .bind(input.providerMailboxId, now, now, mailbox.id);
  } else {
    newStatus = mailbox.provisioned_at ? "deleted" : "failed";
    update = db
      .prepare(`UPDATE email_mailboxes SET status = ?, deleted_at = CASE WHEN ? = 'deleted' THEN ? ELSE deleted_at END, updated_at = ? WHERE id = ? AND status = 'needs_review'`)
      .bind(newStatus, newStatus, now, now, mailbox.id);
  }
  const [res] = await db.batch([
    update,
    auditStatement(db, { serviceId: input.serviceId, mailboxId: mailbox.id, actor: input.actor, action: "mailbox_resolved", before: { status: "needs_review" }, after: { status: newStatus, resolution: input.resolution }, reason: input.reason, now }),
  ]);
  if ((res!.meta.changes ?? 0) === 0) return fail(409, "changed", "This mailbox changed while you were working. Refresh and try again.");
  const final = (await db.prepare(`SELECT * FROM email_mailboxes WHERE id = ?`).bind(mailbox.id).first<MailboxRow>())!;
  return { ok: true, value: { mailbox: final } };
}

// ---------------------------------------------------------------------------
// Manual fulfillment (CLAUDE.md §35)
//
// There is no real Z.com adapter. Until there is, a mailbox is created by a
// human in Z.com's own dashboard, and these three functions are the
// software around that manual step:
//   requestMailboxByClient  client asks for a mailbox  -> reserved (no lease, held)
//   fulfillMailboxManually  staff record what they made -> active (+ webmail bridge)
//   declineMailboxRequest   staff turn a request down   -> discarded (address freed)
// None of them calls a provider, and none of them accepts or stores a
// password: the mailbox password is set in Z.com's dashboard, and the SMTP
// password lives only in the mail worker's MAIL_SMTP_PROFILES_JSON secret.

export interface ClientRequestInput {
  serviceId: string;
  clientId: string;
  domainId: string;
  localPart: string;
  isPrimary: boolean;
  idempotencyKey: string | null;
  now?: string;
}

// A client-originated reservation. Never calls a provider and never runs
// provisioning: the row stays 'reserved' with reserved_until = NULL, which
// holds the slot indefinitely (see COUNTED_MAILBOX_SQL in policy.ts) until
// staff fulfill or decline it.
//
// One outstanding request per service at a time. A second request while a
// client-requested 'reserved' row exists is refused (request_pending),
// checked inside the same INSERT as ownership and capacity, so two
// simultaneous requests can't both get in. Reasoning: a request is a
// manual job for a human, and letting a client queue up several at once
// would let one service sit on its whole allowance in unfulfilled
// requests and bury staff in a batch they have to work through by hand.
// Once the first is fulfilled or declined, the next can be made.
//
// Allowed while the service is in a provisionable state (pending_setup,
// active, provisioning_error), the same rule staff provisioning uses, NOT
// clientCanManageMailboxes() (active only): a new service can't be
// activated until it has an active mailbox, so an active-only rule would
// leave a new client unable to ask for their first one. Every request is
// reviewed by staff before anything is created, so this is not
// self-service management.
export async function requestMailboxByClient(db: D1Database, input: ClientRequestInput): Promise<EngineResult<{ mailbox: MailboxRow; duplicateRequest: boolean }>> {
  const now = input.now ?? nowIso();
  const actor: Actor = { type: "client", id: input.clientId };
  const localPart = normalizeLocalPart(input.localPart);
  if (!localPart) return fail(400, "invalid_local_part", "The mailbox name may use letters, numbers, dots, dashes, underscores and plus signs.");

  const lookupExisting = async (): Promise<EngineResult<{ mailbox: MailboxRow; duplicateRequest: boolean }> | null> => {
    if (!input.idempotencyKey) return null;
    const existing = await db.prepare(`SELECT * FROM email_mailboxes WHERE idempotency_key = ?`).bind(input.idempotencyKey).first<MailboxRow>();
    if (!existing) return null;
    if (existing.service_id !== input.serviceId || existing.created_by !== input.clientId) return fail(409, "idempotency_conflict", "This request key was already used for a different request.");
    return { ok: true, value: { mailbox: existing, duplicateRequest: true } };
  };
  const repeat = await lookupExisting();
  if (repeat) return repeat;

  // Not found and not yours read the same, so a client can't probe for
  // other clients' service ids.
  const service = await db.prepare(`SELECT * FROM email_services WHERE id = ? AND client_id = ?`).bind(input.serviceId, input.clientId).first<ServiceRow>();
  if (!service) return fail(404, "service_not_found", "Email service not found.");

  await sweepStaleMailboxes(db, input.serviceId, now);

  const domain = await db
    .prepare(`SELECT * FROM email_domains WHERE id = ? AND service_id = ? AND status = 'active'`)
    .bind(input.domainId, input.serviceId)
    .first<DomainRow>();
  if (!domain) return fail(404, "domain_not_found", "That domain is not assigned to this service.");

  const id = crypto.randomUUID();
  const address = `${localPart}@${domain.domain}`;
  let changes: number;
  try {
    // THE client reservation: the same statement as provisionMailbox's,
    // plus `s.client_id = ?` (the real ownership boundary, enforced by the
    // statement that writes, not by the lookup above) and the
    // one-pending-request rule. reserved_until is NULL on purpose.
    const res = await db
      .prepare(
        `INSERT INTO email_mailboxes (id, service_id, domain_id, local_part, address, is_primary, status, inbound_source, provider_service_id, idempotency_key, reserved_until, created_by, created_by_type, created_at, updated_at)
         SELECT ?, s.id, d.id, ?, ?, ?, 'reserved', ?, s.provider_service_id, ?, NULL, ?, 'client', ?, ?
         FROM email_services s
         JOIN email_domains d ON d.id = ? AND d.service_id = s.id AND d.status = 'active'
         WHERE s.id = ?
           AND s.client_id = ?
           AND s.status IN (${PROVISIONABLE_SQL_LIST})
           AND s.plan_id IS NOT NULL
           AND (s.expires_at IS NULL OR s.expires_at > ?)
           AND NOT EXISTS (SELECT 1 FROM email_mailboxes p WHERE p.service_id = s.id AND p.status = 'reserved' AND p.created_by_type = 'client')
           AND ${TOTAL_ALLOWANCE_SQL} > ${COUNTED_SQL}`
      )
      .bind(
        id,
        localPart,
        address,
        input.isPrimary ? 1 : 0,
        PROVIDER_INBOUND_SOURCE[service.provider],
        input.idempotencyKey,
        input.clientId,
        now,
        now,
        input.domainId,
        input.serviceId,
        input.clientId,
        now,
        now
      )
      .run();
    changes = res.meta.changes ?? 0;
  } catch (err) {
    // Same handling as provisionMailbox: a repeat can collide on any
    // unique index first, so look the key up on any unique violation.
    if (input.idempotencyKey && String(err instanceof Error ? err.message : err).includes("UNIQUE constraint failed")) {
      const again = await lookupExisting();
      if (again) return again;
    }
    if (isUniqueViolation(err, "address")) return fail(409, "address_taken", `${address} is already taken. Choose a different name.`);
    if (isUniqueViolation(err, "service_id")) return fail(409, "primary_exists", "This service already has a primary mailbox.");
    throw err;
  }

  if (changes === 0) {
    const pending = await db
      .prepare(`SELECT address FROM email_mailboxes WHERE service_id = ? AND status = 'reserved' AND created_by_type = 'client' LIMIT 1`)
      .bind(input.serviceId)
      .first<{ address: string }>();
    if (pending) return fail(409, "request_pending", `Your request for ${pending.address} is still being set up. You can request another mailbox once it's done.`);
    return explainReservationFailure(db, input.serviceId, now);
  }

  const mailbox = (await db.prepare(`SELECT * FROM email_mailboxes WHERE id = ?`).bind(id).first<MailboxRow>())!;
  await db.batch([
    auditStatement(db, { serviceId: input.serviceId, mailboxId: id, actor, action: "mailbox_requested_by_client", after: { address, isPrimary: input.isPrimary }, now }),
    clientActivityStatement(db, service.client_id, "email_mailbox_requested", `Requested mailbox ${address}`, null, now),
  ]);
  return { ok: true, value: { mailbox, duplicateRequest: false } };
}

export interface ManualFulfillmentInput {
  serviceId: string;
  mailboxId: string;
  // Z.com's own ids for the mailbox staff created in its dashboard.
  providerMailboxId: string;
  providerServiceId?: string | null;
  // Name of the entry in the mail worker's MAIL_SMTP_PROFILES_JSON secret
  // that will hold this mailbox's SMTP login. Just an identifier: the
  // secret's value is configured outside this codebase. Required when
  // createBridgeAccount is true.
  smtpProfileKey: string | null;
  createBridgeAccount: boolean;
  bridgeDisplayName?: string | null;
  actor: Actor;
  now?: string;
  // Deliberately NO password field. Do not add one.
}

export interface ManualFulfillmentOutcome {
  mailbox: MailboxRow;
  mailAccountId: string | null;
  // The smtp_profile actually on the bridge account. Differs from the key
  // passed in only when an existing mail_accounts row already had one.
  smtpProfile: string | null;
}

// reserved | needs_review | failed -> active, using staff-entered provider
// ids instead of a provider call. Staff are asserting ground truth: they
// created the mailbox in Z.com's dashboard themselves.
//
// Fulfilling twice is rejected: a second call on an already-active
// mailbox returns 409 already_fulfilled and writes nothing. The
// transition itself is one conditional UPDATE, so two simultaneous
// fulfillments can't both win.
//
// A 'failed' mailbox no longer counts against the allowance, so reviving
// one re-checks service state, domain and capacity inside that same
// UPDATE (same conditions as retryMailbox). 'reserved' and 'needs_review'
// rows already hold their slot.
export async function fulfillMailboxManually(db: D1Database, input: ManualFulfillmentInput): Promise<EngineResult<ManualFulfillmentOutcome>> {
  const now = input.now ?? nowIso();
  if (input.actor.type !== "staff" || !input.actor.id) return fail(403, "staff_only", "Only staff can fulfill a mailbox.");

  const providerMailboxId = typeof input.providerMailboxId === "string" ? input.providerMailboxId.trim().slice(0, 200) : "";
  if (!providerMailboxId) return fail(400, "provider_mailbox_id_required", "Enter the Z.com mailbox id.");
  const providerServiceId = typeof input.providerServiceId === "string" && input.providerServiceId.trim() ? input.providerServiceId.trim().slice(0, 200) : null;
  let smtpProfileKey: string | null = null;
  if (input.createBridgeAccount) {
    smtpProfileKey = normalizeSmtpProfileKey(input.smtpProfileKey);
    if (!smtpProfileKey) return fail(400, "invalid_smtp_profile_key", "The SMTP profile key may use lowercase letters, numbers, dots, dashes and underscores (max 100 characters).");
  }

  await sweepStaleMailboxes(db, input.serviceId, now);
  const service = await loadService(db, input.serviceId);
  if (!service) return fail(404, "service_not_found", "Email service not found.");
  if (!staffCanManageMailboxes(service.status)) return fail(409, "service_cancelled", "This service has been decommissioned.");
  const before = await loadMailbox(db, input.serviceId, input.mailboxId);
  if (!before) return fail(404, "mailbox_not_found", "Mailbox not found.");
  if (before.status === "active") return fail(409, "already_fulfilled", "This mailbox is already active.");
  if (!MANUALLY_FULFILLABLE_STATUSES.includes(before.status)) {
    return fail(409, "not_fulfillable", `Only reserved, needs-review or failed mailboxes can be fulfilled (this one is ${before.status.replace("_", " ")}).`);
  }

  const claimed = await db
    .prepare(
      `UPDATE email_mailboxes SET status = 'active', provider_mailbox_id = ?,
         provider_service_id = COALESCE(?, provider_service_id, (SELECT s.provider_service_id FROM email_services s WHERE s.id = email_mailboxes.service_id)),
         provisioned_at = ?, reserved_until = NULL, failure_code = NULL, last_error = NULL, updated_at = ?
       WHERE id = ? AND service_id = ?
         AND (
           status IN ('reserved', 'needs_review')
           OR (status = 'failed' AND EXISTS (
             SELECT 1 FROM email_services s
             JOIN email_domains d ON d.id = email_mailboxes.domain_id AND d.service_id = s.id AND d.status = 'active'
             WHERE s.id = email_mailboxes.service_id
               AND s.status IN (${PROVISIONABLE_SQL_LIST})
               AND s.plan_id IS NOT NULL
               AND (s.expires_at IS NULL OR s.expires_at > ?)
               AND ${TOTAL_ALLOWANCE_SQL} > ${COUNTED_SQL}
           ))
         )
       RETURNING *`
    )
    .bind(providerMailboxId, providerServiceId, now, now, before.id, input.serviceId, now, now)
    .first<MailboxRow>();

  if (!claimed) {
    const current = await loadMailbox(db, input.serviceId, input.mailboxId);
    if (current?.status === "active") return fail(409, "already_fulfilled", "This mailbox is already active.");
    if (current?.status === "failed") {
      const domain = await db.prepare(`SELECT status FROM email_domains WHERE id = ?`).bind(current.domain_id).first<{ status: string }>();
      if (domain?.status !== "active") return fail(409, "domain_removed", "This mailbox's domain is no longer assigned to the service.");
      return explainReservationFailure(db, input.serviceId, now);
    }
    return fail(409, "changed", "This mailbox changed while you were working. Refresh and try again.");
  }

  const statements: D1PreparedStatement[] = [];
  if (input.createBridgeAccount) {
    const client = await db.prepare(`SELECT business_name FROM clients WHERE id = ?`).bind(service.client_id).first<{ business_name: string }>();
    const displayName = (input.bridgeDisplayName?.trim() || client?.business_name?.trim() || claimed.address).slice(0, 200);
    // mail_accounts.email_address is UNIQUE: reuse an existing row (e.g.
    // from an earlier attempt) instead of failing. An existing row keeps
    // its own smtp_profile; it is only filled in if it had none.
    statements.push(
      db
        .prepare(
          `INSERT INTO mail_accounts (id, email_address, display_name, smtp_profile, inbound_enabled, outbound_enabled, is_active, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, 1, 1, ?, ?, ?) ON CONFLICT(email_address) DO NOTHING`
        )
        .bind(crypto.randomUUID(), claimed.address, displayName, smtpProfileKey, input.actor.id, now, now),
      db.prepare(`UPDATE mail_accounts SET smtp_profile = ?, updated_at = ? WHERE email_address = ? AND smtp_profile IS NULL`).bind(smtpProfileKey, now, claimed.address),
      db
        .prepare(
          `INSERT INTO mail_account_access (account_id, user_id, can_send, granted_by, created_at)
           SELECT id, ?, 1, ?, ? FROM mail_accounts WHERE email_address = ? ON CONFLICT(account_id, user_id) DO NOTHING`
        )
        .bind(input.actor.id, input.actor.id, now, claimed.address),
      db.prepare(`UPDATE email_mailboxes SET mail_account_id = (SELECT id FROM mail_accounts WHERE email_address = ?) WHERE id = ?`).bind(claimed.address, claimed.id)
    );
  }
  statements.push(
    db.prepare(`UPDATE email_services SET status = 'pending_setup', status_reason = NULL, updated_at = ? WHERE id = ? AND status = 'provisioning_error'`).bind(now, service.id),
    provisioningLogStatement(db, {
      serviceId: service.id,
      mailboxId: claimed.id,
      provider: service.provider,
      operation: "manual_fulfillment",
      error: null,
      details: { previousStatus: before.status, providerMailboxId, providerServiceId: claimed.provider_service_id, bridged: input.createBridgeAccount, smtpProfileKey },
      actor: input.actor,
      now,
    })
  );

  try {
    await db.batch(statements);
  } catch (err) {
    // The bridge/log batch failed after the mailbox was already marked
    // active. Put the mailbox back as it was so staff can simply try
    // again, rather than leave an active mailbox with no bridge and no log.
    await db
      .prepare(
        `UPDATE email_mailboxes SET status = ?, provider_mailbox_id = ?, provider_service_id = ?, provisioned_at = ?, reserved_until = ?, failure_code = ?, last_error = ?, updated_at = ?
         WHERE id = ? AND status = 'active' AND mail_account_id IS NULL`
      )
      .bind(before.status, before.provider_mailbox_id, before.provider_service_id, before.provisioned_at, before.reserved_until, before.failure_code, before.last_error, nowIso(), before.id)
      .run()
      .catch(() => undefined);
    throw err;
  }

  const final = (await db.prepare(`SELECT * FROM email_mailboxes WHERE id = ?`).bind(claimed.id).first<MailboxRow>())!;
  const account = final.mail_account_id
    ? await db.prepare(`SELECT smtp_profile FROM mail_accounts WHERE id = ?`).bind(final.mail_account_id).first<{ smtp_profile: string | null }>()
    : null;

  await db.batch([
    auditStatement(db, {
      serviceId: service.id,
      mailboxId: final.id,
      actor: input.actor,
      action: "mailbox_fulfilled_manually",
      before: { status: before.status },
      after: { address: final.address, providerMailboxId: final.provider_mailbox_id, providerServiceId: final.provider_service_id, mailAccountId: final.mail_account_id, smtpProfileKey: account?.smtp_profile ?? null },
      now,
    }),
    clientActivityStatement(db, service.client_id, "email_mailbox_fulfilled", `Mailbox ${final.address} is set up`, input.actor.id, now),
  ]);
  return { ok: true, value: { mailbox: final, mailAccountId: final.mail_account_id, smtpProfile: account?.smtp_profile ?? null } };
}

// A client's pending request -> discarded. Only for client requests
// (status 'reserved', created_by_type 'client'): staff reservations
// already have retry/discard. 'discarded' rather than 'failed' because
// there is nothing to retry, and because 'discarded' is excluded from the
// live-address index, so the same name can be requested again at once.
export async function declineMailboxRequest(db: D1Database, input: { serviceId: string; mailboxId: string; reason: string; actor: Actor; now?: string }): Promise<EngineResult<{ mailbox: MailboxRow }>> {
  const now = input.now ?? nowIso();
  if (input.actor.type !== "staff" || !input.actor.id) return fail(403, "staff_only", "Only staff can decline a mailbox request.");
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 500) : "";
  if (!reason) return fail(400, "reason_required", "A reason is required to decline a request.");

  const res = await db
    .prepare(
      `UPDATE email_mailboxes SET status = 'discarded', failure_code = 'declined_by_staff', last_error = ?, reserved_until = NULL, updated_at = ?
       WHERE id = ? AND service_id = ? AND status = 'reserved' AND created_by_type = 'client' RETURNING *`
    )
    .bind(reason, now, input.mailboxId, input.serviceId)
    .first<MailboxRow>();
  if (!res) {
    const existing = await loadMailbox(db, input.serviceId, input.mailboxId);
    if (!existing) return fail(404, "mailbox_not_found", "Mailbox not found.");
    return fail(409, "not_a_pending_request", "Only a client's pending request can be declined.");
  }
  const service = (await loadService(db, input.serviceId))!;
  await db.batch([
    auditStatement(db, { serviceId: input.serviceId, mailboxId: res.id, actor: input.actor, action: "mailbox_request_declined", before: { status: "reserved" }, after: { status: "discarded", address: res.address }, reason, now }),
    clientActivityStatement(db, service.client_id, "email_mailbox_request_declined", `Mailbox request ${res.address} declined: ${reason}`.slice(0, 500), input.actor.id, now),
  ]);
  return { ok: true, value: { mailbox: res } };
}

// ---------------------------------------------------------------------------
// Entitlements

export async function adjustEntitlement(
  db: D1Database,
  input: { serviceId: string; kind: "addon" | "override"; quantity: number; reason: string | null; actor: Actor; now?: string }
): Promise<EngineResult<{ allowance: Allowance }>> {
  const now = input.now ?? nowIso();
  if (!Number.isInteger(input.quantity) || input.quantity === 0 || Math.abs(input.quantity) > 1000) return fail(400, "invalid_quantity", "Quantity must be a non-zero whole number.");
  if ((input.kind === "override" || input.quantity < 0) && !input.reason) return fail(400, "reason_required", "A reason is required for overrides and removals.");

  await sweepStaleMailboxes(db, input.serviceId, now);
  const id = crypto.randomUUID();
  // One statement: refuses to drop the allowance below what is already
  // counted (active + in-flight), or the add-on total below zero.
  const res = await db
    .prepare(
      `INSERT INTO email_service_entitlements (id, service_id, kind, quantity, unit_price_php, reason, created_by, created_at)
       SELECT ?, s.id, ?, ?, CASE WHEN ? = 'addon' THEN s.additional_mailbox_price_php ELSE NULL END, ?, ?, ?
       FROM email_services s
       WHERE s.id = ? AND s.status <> 'cancelled'
         AND ${TOTAL_ALLOWANCE_SQL} + ? >= ${COUNTED_SQL}
         AND ${TOTAL_ALLOWANCE_SQL} + ? >= 0
         AND (? <> 'addon' OR COALESCE((SELECT SUM(e.quantity) FROM email_service_entitlements e WHERE e.service_id = s.id AND e.kind = 'addon'), 0) + ? >= 0)`
    )
    .bind(id, input.kind, input.quantity, input.kind, input.reason, input.actor.type === "staff" ? input.actor.id : null, now, input.serviceId, input.quantity, now, input.quantity, input.kind, input.quantity)
    .run();

  if ((res.meta.changes ?? 0) === 0) {
    const service = await loadService(db, input.serviceId);
    if (!service) return fail(404, "service_not_found", "Email service not found.");
    if (service.status === "cancelled") return fail(409, "service_cancelled", "This service has been decommissioned.");
    const allowance = await getAllowance(db, input.serviceId, now);
    if (input.kind === "addon" && allowance && allowance.additional + input.quantity < 0) {
      return fail(409, "addon_below_zero", `Only ${allowance.additional} additional mailbox(es) are on this service.`, { allowance });
    }
    return fail(409, "below_usage", "That would leave fewer slots than mailboxes already in use. Delete mailboxes first.", { allowance });
  }

  const allowance = (await getAllowance(db, input.serviceId, now))!;
  await db.batch([
    auditStatement(db, {
      serviceId: input.serviceId,
      actor: input.actor,
      action: "entitlement_adjusted",
      after: { kind: input.kind, quantity: input.quantity, totalAllowance: allowance.total },
      reason: input.reason,
      now,
    }),
  ]);
  return { ok: true, value: { allowance } };
}

// Assigns or changes the plan and snapshots its values onto the service.
export async function assignPlan(db: D1Database, input: { serviceId: string; planId: string; reason: string | null; actor: Actor; now?: string }): Promise<EngineResult<{ service: ServiceRow }>> {
  const now = input.now ?? nowIso();
  const before = await loadService(db, input.serviceId);
  if (!before) return fail(404, "service_not_found", "Email service not found.");
  if (before.status === "cancelled") return fail(409, "service_cancelled", "This service has been decommissioned.");
  const plan = await db.prepare(`SELECT id, name, status, included_mailboxes FROM email_plans WHERE id = ?`).bind(input.planId).first<{ id: string; name: string; status: string; included_mailboxes: number }>();
  if (!plan) return fail(404, "plan_not_found", "Plan not found.");
  if (plan.status !== "active") return fail(409, "plan_archived", "Archived plans can't be assigned.");
  if (before.plan_id && before.plan_id !== input.planId && !input.reason) return fail(400, "reason_required", "A reason is required when changing an existing plan.");

  await sweepStaleMailboxes(db, input.serviceId, now);
  const res = await db
    .prepare(
      `UPDATE email_services AS s SET
         plan_id = p.id, plan_name_snapshot = p.name, included_mailboxes = p.included_mailboxes, storage_quota_mb = p.storage_quota_mb,
         price_php = p.price_php, additional_mailbox_price_php = p.additional_mailbox_price_php, updated_at = ?
       FROM email_plans p
       WHERE s.id = ? AND p.id = ? AND p.status = 'active' AND s.status <> 'cancelled'
         AND p.included_mailboxes + COALESCE((SELECT SUM(e.quantity) FROM email_service_entitlements e WHERE e.service_id = s.id), 0) >= ${COUNTED_SQL}`
    )
    .bind(now, input.serviceId, input.planId, now)
    .run();
  if ((res.meta.changes ?? 0) === 0) {
    const allowance = await getAllowance(db, input.serviceId, now);
    return fail(409, "below_usage", "That plan allows fewer mailboxes than are already in use. Delete mailboxes or add allowance first.", { allowance });
  }
  const after = (await loadService(db, input.serviceId))!;
  await db.batch([
    auditStatement(db, {
      serviceId: input.serviceId,
      actor: input.actor,
      action: before.plan_id ? "plan_changed" : "plan_assigned",
      before: { planId: before.plan_id, includedMailboxes: before.included_mailboxes, pricePhp: before.price_php },
      after: { planId: after.plan_id, includedMailboxes: after.included_mailboxes, pricePhp: after.price_php },
      reason: input.reason,
      now,
    }),
    clientActivityStatement(db, after.client_id, "email_plan_assigned", `Email plan set to ${plan.name}`, input.actor.type === "staff" ? input.actor.id : null, now),
  ]);
  return { ok: true, value: { service: after } };
}

// ---------------------------------------------------------------------------
// Domains

export async function addDomain(db: D1Database, input: { serviceId: string; domain: string; isPrimary: boolean; actor: Actor; now?: string }): Promise<EngineResult<{ domain: DomainRow }>> {
  const now = input.now ?? nowIso();
  const service = await loadService(db, input.serviceId);
  if (!service) return fail(404, "service_not_found", "Email service not found.");
  if (service.status === "cancelled") return fail(409, "service_cancelled", "This service has been decommissioned.");

  const existing = await db.prepare(`SELECT COUNT(*) AS n FROM email_domains WHERE service_id = ? AND status = 'active'`).bind(input.serviceId).first<{ n: number }>();
  const makePrimary = input.isPrimary || Number(existing?.n ?? 0) === 0;
  const id = crypto.randomUUID();
  const statements: D1PreparedStatement[] = [];
  if (makePrimary) statements.push(db.prepare(`UPDATE email_domains SET is_primary = 0, updated_at = ? WHERE service_id = ? AND status = 'active'`).bind(now, input.serviceId));
  statements.push(
    db
      .prepare(`INSERT INTO email_domains (id, service_id, domain, is_primary, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`)
      .bind(id, input.serviceId, input.domain, makePrimary ? 1 : 0, input.actor.type === "staff" ? input.actor.id : null, now, now),
    auditStatement(db, { serviceId: input.serviceId, actor: input.actor, action: "domain_assigned", after: { domain: input.domain, isPrimary: makePrimary }, now })
  );
  try {
    await db.batch(statements);
  } catch (err) {
    if (isUniqueViolation(err, "domain")) return fail(409, "domain_taken", `${input.domain} is already assigned to an email service.`);
    throw err;
  }
  const domain = (await db.prepare(`SELECT * FROM email_domains WHERE id = ?`).bind(id).first<DomainRow>())!;
  return { ok: true, value: { domain } };
}

export async function removeDomain(db: D1Database, input: { serviceId: string; domainId: string; reason: string | null; actor: Actor; now?: string }): Promise<EngineResult<{ removed: true }>> {
  const now = input.now ?? nowIso();
  await sweepStaleMailboxes(db, input.serviceId, now);
  const res = await db
    .prepare(
      `UPDATE email_domains SET status = 'removed', is_primary = 0, removed_at = ?, updated_at = ?
       WHERE id = ? AND service_id = ? AND status = 'active'
         AND NOT EXISTS (SELECT 1 FROM email_mailboxes m WHERE m.domain_id = email_domains.id AND ${COUNTED_MAILBOX_SQL})
       RETURNING domain`
    )
    .bind(now, now, input.domainId, input.serviceId, now)
    .first<{ domain: string }>();
  if (!res) {
    const domain = await db.prepare(`SELECT status FROM email_domains WHERE id = ? AND service_id = ?`).bind(input.domainId, input.serviceId).first<{ status: string }>();
    if (!domain || domain.status !== "active") return fail(404, "domain_not_found", "Domain not found on this service.");
    return fail(409, "domain_in_use", "This domain still has mailboxes. Delete them first.");
  }
  await db.batch([auditStatement(db, { serviceId: input.serviceId, actor: input.actor, action: "domain_removed", before: { domain: res.domain }, reason: input.reason, now })]);
  return { ok: true, value: { removed: true } };
}

// ---------------------------------------------------------------------------
// Service lifecycle

export async function transitionService(
  db: D1Database,
  input: { serviceId: string; action: LifecycleAction; reason: string | null; expiresAt: string | null; actor: Actor; now?: string }
): Promise<EngineResult<{ service: ServiceRow }>> {
  const now = input.now ?? nowIso();
  await sweepStaleMailboxes(db, input.serviceId, now);
  const service = await loadService(db, input.serviceId);
  if (!service) return fail(404, "service_not_found", "Email service not found.");
  if (LIFECYCLE_REQUIRES_REASON[input.action] && !input.reason) return fail(400, "reason_required", "A reason is required for this action.");

  const effective = effectiveServiceStatus(service.status, service.expires_at, now);
  if (!LIFECYCLE_FROM[input.action].includes(effective)) {
    return fail(409, "invalid_transition", `Can't ${input.action} a service that is ${effective.replace("_", " ")}.`);
  }

  const plan = service.plan_id
    ? await db.prepare(`SELECT billing_interval FROM email_plans WHERE id = ?`).bind(service.plan_id).first<{ billing_interval: "annual" | "monthly" }>()
    : null;
  const interval = plan?.billing_interval ?? "annual";

  let newStatus: ServiceStatus = service.status;
  let startsAt = service.starts_at;
  let expiresAt = service.expires_at;
  let decommissionedAt: string | null = service.decommissioned_at;
  const extra: D1PreparedStatement[] = [];

  switch (input.action) {
    case "activate": {
      const checklist = await activationChecklist(db, service.id);
      const missing = Object.entries(checklist).filter(([, ok]) => !ok).map(([k]) => k);
      if (missing.length) return fail(409, "activation_requirements", "This service isn't ready to activate yet.", { checklist });
      startsAt = startsAt ?? now;
      expiresAt = input.expiresAt ?? (expiresAt && expiresAt > now ? expiresAt : addInterval(startsAt > now ? startsAt : now, interval));
      newStatus = "active";
      break;
    }
    case "suspend":
      newStatus = "suspended";
      break;
    case "reactivate":
      if (!expiresAt || expiresAt <= now) return fail(409, "renew_required", "This service's term has ended. Renew it instead.");
      newStatus = "active";
      break;
    case "renew": {
      if (!service.plan_id) return fail(409, "no_plan", "Assign a plan before renewing.");
      const base = expiresAt && expiresAt > now ? expiresAt : now;
      expiresAt = input.expiresAt ?? addInterval(base, interval);
      if (expiresAt <= now) return fail(400, "invalid_date", "The new expiration date must be in the future.");
      if (service.status === "expired" || effective === "expired") newStatus = "active";
      break;
    }
    case "decommission": {
      const counted = await db
        .prepare(`SELECT COUNT(*) AS n FROM email_mailboxes m WHERE m.service_id = ? AND ${COUNTED_MAILBOX_SQL}`)
        .bind(service.id, now)
        .first<{ n: number }>();
      if (Number(counted?.n ?? 0) > 0) return fail(409, "mailboxes_remain", "Delete or resolve every mailbox before decommissioning. Mailbox data is never deleted automatically.");
      newStatus = "cancelled";
      decommissionedAt = now;
      extra.push(db.prepare(`UPDATE email_domains SET status = 'removed', is_primary = 0, removed_at = ?, updated_at = ? WHERE service_id = ? AND status = 'active'`).bind(now, now, service.id));
      break;
    }
  }

  // Optimistic concurrency: only applies if nobody changed status/expiry
  // since we read the row. For decommission the "no mailboxes left" rule is
  // repeated inside the same statement, so a mailbox reserved in between
  // can't slip past it.
  const update = await db
    .prepare(
      `UPDATE email_services SET status = ?, status_reason = ?, starts_at = ?, expires_at = ?, decommissioned_at = ?, updated_at = ?
       WHERE id = ? AND status = ? AND COALESCE(expires_at, '') = COALESCE(?, '')
         AND (? <> 'decommission' OR NOT EXISTS (SELECT 1 FROM email_mailboxes m WHERE m.service_id = email_services.id AND ${COUNTED_MAILBOX_SQL}))`
    )
    .bind(newStatus, input.reason, startsAt, expiresAt, decommissionedAt, now, service.id, service.status, service.expires_at, input.action, now)
    .run();
  if ((update.meta.changes ?? 0) === 0) {
    return fail(409, "changed", "This service changed while you were working. Refresh and try again.");
  }

  await db.batch([
    ...extra,
    auditStatement(db, {
      serviceId: service.id,
      actor: input.actor,
      action: `service_${input.action}`,
      before: { status: service.status, expiresAt: service.expires_at },
      after: { status: newStatus, expiresAt },
      reason: input.reason,
      now,
    }),
    clientActivityStatement(db, service.client_id, `email_service_${input.action}`, `Email service ${LIFECYCLE_PAST_TENSE[input.action]}${input.reason ? `: ${input.reason}` : ""}`.slice(0, 500), input.actor.type === "staff" ? input.actor.id : null, now),
  ]);
  return { ok: true, value: { service: (await loadService(db, service.id))! } };
}

const LIFECYCLE_PAST_TENSE: Record<LifecycleAction, string> = {
  activate: "activated",
  suspend: "suspended",
  reactivate: "reactivated",
  renew: "renewed",
  decommission: "decommissioned",
};

export async function activationChecklist(db: D1Database, serviceId: string): Promise<{ planAssigned: boolean; domainAssigned: boolean; mailboxActive: boolean }> {
  const row = await db
    .prepare(
      `SELECT s.plan_id IS NOT NULL AS plan,
              EXISTS (SELECT 1 FROM email_domains d WHERE d.service_id = s.id AND d.status = 'active') AS domain,
              EXISTS (SELECT 1 FROM email_mailboxes m WHERE m.service_id = s.id AND m.status = 'active') AS mailbox
       FROM email_services s WHERE s.id = ?`
    )
    .bind(serviceId)
    .first<{ plan: number; domain: number; mailbox: number }>();
  return { planAssigned: !!row?.plan, domainAssigned: !!row?.domain, mailboxActive: !!row?.mailbox };
}

// ---------------------------------------------------------------------------
// Provider sync + reconciliation. Read-only with respect to mailboxes: it
// records what it found and returns discrepancies; it never creates,
// deletes or changes a mailbox's state. Fixing anything is a separate,
// explicit admin action.

export interface SyncOutcome {
  ok: boolean;
  error: ProviderError | null;
  discrepancies: Discrepancy[];
  checkedDomains: string[];
}

export async function syncService(db: D1Database, provider: EmailHostingProvider, input: { serviceId: string; actor: Actor; now?: string }): Promise<EngineResult<SyncOutcome>> {
  const now = input.now ?? nowIso();
  await sweepStaleMailboxes(db, input.serviceId, now);
  const service = await loadService(db, input.serviceId);
  if (!service) return fail(404, "service_not_found", "Email service not found.");
  const domains = (await db.prepare(`SELECT * FROM email_domains WHERE service_id = ? AND status = 'active'`).bind(service.id).all<DomainRow>()).results;
  const local = (await db.prepare(`SELECT * FROM email_mailboxes WHERE service_id = ?`).bind(service.id).all<MailboxRow>()).results;

  const remote: ProviderMailbox[] = [];
  let error: ProviderError | null = null;
  let totalDuration = 0;
  for (const domain of domains) {
    const { result, durationMs } = await callProvider(() =>
      provider.listMailboxes({ providerServiceId: service.provider_service_id, domain: domain.domain, providerDomainId: domain.provider_domain_id })
    );
    totalDuration += durationMs;
    if (!result.ok) {
      error = result.error;
      break;
    }
    remote.push(...result.value);
  }

  // No domains means there is nothing to ask the provider about; still ask
  // for service details so an unconfigured provider is reported honestly.
  if (!domains.length) {
    const { result, durationMs } = await callProvider(() => provider.getServiceDetails({ providerServiceId: service.provider_service_id }));
    totalDuration += durationMs;
    if (!result.ok) error = result.error;
  }

  const allowance = (await getAllowance(db, service.id, now))!;
  const discrepancies = error
    ? []
    : reconcileMailboxes(
        local.map((m) => ({ id: m.id, address: m.address, status: m.status, providerMailboxId: m.provider_mailbox_id })),
        remote.map((r) => ({ providerMailboxId: r.providerMailboxId, address: r.address, status: r.status })),
        allowance.total
      );

  const statements: D1PreparedStatement[] = [
    db
      .prepare(`UPDATE email_services SET sync_status = ?, last_sync_at = ?, last_sync_error = ?, updated_at = ? WHERE id = ?`)
      .bind(error ? "error" : discrepancies.length ? "discrepancies" : "ok", now, error ? error.message.slice(0, 500) : null, now, service.id),
    provisioningLogStatement(db, {
      serviceId: service.id,
      provider: service.provider,
      operation: "sync",
      error,
      durationMs: totalDuration,
      details: { checkedDomains: domains.map((d) => d.domain), remoteMailboxes: remote.length, discrepancies },
      actor: input.actor,
      now,
    }),
  ];
  if (!error) {
    const matched = new Set(remote.map((r) => r.address.toLowerCase()));
    for (const m of local) {
      if (matched.has(m.address)) statements.push(db.prepare(`UPDATE email_mailboxes SET last_synced_at = ? WHERE id = ?`).bind(now, m.id));
    }
  }
  await db.batch(statements);

  return { ok: true, value: { ok: !error, error, discrepancies, checkedDomains: domains.map((d) => d.domain) } };
}
