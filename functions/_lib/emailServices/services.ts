// Service creation, editable fields, and the read models (list + detail)
// served to ClientKeeper's Email Services pages.

import { activationChecklist, assignPlan, addDomain, getAllowance, loadService, sweepExpiredServices, sweepStaleMailboxes, type DomainRow, type EngineResult, type MailboxRow, type ServiceRow } from "./engine";
import { auditStatement, clientActivityStatement, type Actor } from "./logs";
import { COUNTED_MAILBOX_SQL, effectiveServiceStatus, type Allowance } from "./policy";
import { getEmailProvider, providerDisplayName } from "./provider";

const nowIso = () => new Date().toISOString();

export async function createService(
  db: D1Database,
  input: { clientId: string; planId: string | null; domain: string | null; internalNotes: string | null; providerServiceId: string | null; actor: Actor; now?: string }
): Promise<EngineResult<{ serviceId: string; warnings: string[] }>> {
  const now = input.now ?? nowIso();
  const client = await db.prepare(`SELECT id, business_name FROM clients WHERE id = ?`).bind(input.clientId).first<{ id: string; business_name: string }>();
  if (!client) return { ok: false, status: 404, code: "client_not_found", error: "Client not found." };

  const id = crypto.randomUUID();
  await db.batch([
    db
      .prepare(
        `INSERT INTO email_services (id, client_id, provider, provider_service_id, status, internal_notes, created_by, created_at, updated_at)
         VALUES (?, ?, 'zcom', ?, 'pending_setup', ?, ?, ?, ?)`
      )
      .bind(id, input.clientId, input.providerServiceId, input.internalNotes, input.actor.type === "staff" ? input.actor.id : null, now, now),
    auditStatement(db, { serviceId: id, actor: input.actor, action: "service_created", after: { clientId: input.clientId }, now }),
    clientActivityStatement(db, input.clientId, "email_service_created", "Email service created", input.actor.type === "staff" ? input.actor.id : null, now),
  ]);

  // Plan and domain go through the same engine paths as later edits, so
  // the rules are identical. A failure here leaves a valid pending service
  // and is reported back rather than rolling the service back.
  const warnings: string[] = [];
  if (input.planId) {
    const r = await assignPlan(db, { serviceId: id, planId: input.planId, reason: null, actor: input.actor, now });
    if (!r.ok) warnings.push(`Plan not assigned: ${r.error}`);
  }
  if (input.domain) {
    const r = await addDomain(db, { serviceId: id, domain: input.domain, isPrimary: true, actor: input.actor, now });
    if (!r.ok) warnings.push(`Domain not assigned: ${r.error}`);
  }
  return { ok: true, value: { serviceId: id, warnings } };
}

export async function updateServiceFields(
  db: D1Database,
  input: { serviceId: string; internalNotes?: string | null; providerServiceId?: string | null; expiresAt?: string | null; reason: string | null; actor: Actor; now?: string }
): Promise<EngineResult<{ service: ServiceRow }>> {
  const now = input.now ?? nowIso();
  const before = await loadService(db, input.serviceId);
  if (!before) return { ok: false, status: 404, code: "service_not_found", error: "Email service not found." };
  if (input.expiresAt !== undefined && input.expiresAt !== before.expires_at && !input.reason) {
    return { ok: false, status: 400, code: "reason_required", error: "A reason is required when changing the expiration date." };
  }
  if (before.status === "cancelled" && (input.expiresAt !== undefined || input.providerServiceId !== undefined)) {
    return { ok: false, status: 409, code: "service_cancelled", error: "This service has been decommissioned." };
  }

  const notes = input.internalNotes !== undefined ? input.internalNotes : before.internal_notes;
  const providerServiceId = input.providerServiceId !== undefined ? input.providerServiceId : before.provider_service_id;
  const expiresAt = input.expiresAt !== undefined ? input.expiresAt : before.expires_at;

  await db.batch([
    db
      .prepare(`UPDATE email_services SET internal_notes = ?, provider_service_id = ?, expires_at = ?, updated_at = ? WHERE id = ?`)
      .bind(notes, providerServiceId, expiresAt, now, input.serviceId),
    auditStatement(db, {
      serviceId: input.serviceId,
      actor: input.actor,
      action: "service_updated",
      before: { providerServiceId: before.provider_service_id, expiresAt: before.expires_at, notesChanged: false },
      after: { providerServiceId, expiresAt, notesChanged: notes !== before.internal_notes },
      reason: input.reason,
      now,
    }),
  ]);
  return { ok: true, value: { service: (await loadService(db, input.serviceId))! } };
}

// ---------------------------------------------------------------------------
// Read models

export interface ServiceListItem {
  id: string;
  clientId: string;
  clientName: string;
  businessName: string;
  primaryDomain: string | null;
  planName: string | null;
  status: string;
  effectiveStatus: string;
  expiresAt: string | null;
  allowance: Allowance;
  syncStatus: string;
  failedCount: number;
  needsReviewCount: number;
  createdAt: string;
}

export async function listServices(db: D1Database, filters: { status?: string | null; q?: string | null; clientId?: string | null } = {}): Promise<ServiceListItem[]> {
  const now = nowIso();
  await sweepExpiredServices(db, null, now);
  await sweepStaleMailboxes(db, null, now);

  const where: string[] = [];
  const binds: unknown[] = [now];
  if (filters.status) {
    where.push(`s.status = ?`);
    binds.push(filters.status);
  }
  if (filters.clientId) {
    where.push(`s.client_id = ?`);
    binds.push(filters.clientId);
  }
  if (filters.q) {
    const like = `%${filters.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(`(c.full_name LIKE ? ESCAPE '\\' OR c.business_name LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM email_domains d2 WHERE d2.service_id = s.id AND d2.domain LIKE ? ESCAPE '\\'))`);
    binds.push(like, like, like);
  }

  const rows = await db
    .prepare(
      `SELECT s.*, c.full_name AS client_name, c.business_name,
         (SELECT d.domain FROM email_domains d WHERE d.service_id = s.id AND d.status = 'active' ORDER BY d.is_primary DESC, d.created_at LIMIT 1) AS primary_domain,
         COALESCE((SELECT SUM(quantity) FROM email_service_entitlements e WHERE e.service_id = s.id AND e.kind = 'addon'), 0) AS additional,
         COALESCE((SELECT SUM(quantity) FROM email_service_entitlements e WHERE e.service_id = s.id AND e.kind = 'override'), 0) AS overrides,
         (SELECT COUNT(*) FROM email_mailboxes m WHERE m.service_id = s.id AND m.status = 'active') AS active_count,
         (SELECT COUNT(*) FROM email_mailboxes m WHERE m.service_id = s.id AND m.status <> 'active' AND ${COUNTED_MAILBOX_SQL}) AS pending_count,
         (SELECT COUNT(*) FROM email_mailboxes m WHERE m.service_id = s.id AND m.status = 'failed') AS failed_count,
         (SELECT COUNT(*) FROM email_mailboxes m WHERE m.service_id = s.id AND m.status = 'needs_review') AS review_count
       FROM email_services s JOIN clients c ON c.id = s.client_id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY s.created_at DESC LIMIT 500`
    )
    .bind(...binds)
    .all<ServiceRow & { client_name: string; business_name: string; primary_domain: string | null; additional: number; overrides: number; active_count: number; pending_count: number; failed_count: number; review_count: number }>();

  return rows.results.map((r) => {
    const included = Number(r.included_mailboxes);
    const total = included + Number(r.additional) + Number(r.overrides);
    const active = Number(r.active_count);
    const pending = Number(r.pending_count);
    return {
      id: r.id,
      clientId: r.client_id,
      clientName: r.client_name,
      businessName: r.business_name,
      primaryDomain: r.primary_domain,
      planName: r.plan_name_snapshot,
      status: r.status,
      effectiveStatus: effectiveServiceStatus(r.status, r.expires_at, now),
      expiresAt: r.expires_at,
      allowance: { included, additional: Number(r.additional), overrides: Number(r.overrides), total, active, pending, available: Math.max(0, total - active - pending) },
      syncStatus: r.sync_status,
      failedCount: Number(r.failed_count),
      needsReviewCount: Number(r.review_count),
      createdAt: r.created_at,
    };
  });
}

function serializeMailbox(m: MailboxRow, creatorNames: Map<string, string>) {
  return {
    id: m.id,
    address: m.address,
    domainId: m.domain_id,
    isPrimary: !!m.is_primary,
    status: m.status,
    inboundSource: m.inbound_source,
    providerServiceId: m.provider_service_id,
    providerMailboxId: m.provider_mailbox_id,
    bridgedMailAccountId: m.mail_account_id,
    failureCode: m.failure_code,
    lastError: m.last_error,
    createdBy: m.created_by ? (creatorNames.get(m.created_by) ?? m.created_by) : null,
    createdByType: m.created_by_type,
    provisionedAt: m.provisioned_at,
    deletedAt: m.deleted_at,
    lastSyncedAt: m.last_synced_at,
    createdAt: m.created_at,
  };
}

export async function getServiceDetail(db: D1Database, serviceId: string) {
  const now = nowIso();
  await sweepExpiredServices(db, serviceId, now);
  await sweepStaleMailboxes(db, serviceId, now);
  const s = await loadService(db, serviceId);
  if (!s) return null;

  const [client, domains, mailboxes, entitlements, allowance, checklist, lastSync, plan] = await Promise.all([
    db.prepare(`SELECT id, full_name, business_name, email FROM clients WHERE id = ?`).bind(s.client_id).first<{ id: string; full_name: string; business_name: string; email: string }>(),
    db.prepare(`SELECT * FROM email_domains WHERE service_id = ? ORDER BY status, is_primary DESC, created_at`).bind(serviceId).all<DomainRow & { removed_at: string | null }>(),
    db.prepare(`SELECT * FROM email_mailboxes WHERE service_id = ? ORDER BY is_primary DESC, created_at`).bind(serviceId).all<MailboxRow>(),
    db
      .prepare(`SELECT e.*, u.full_name AS creator_name, u.email AS creator_email FROM email_service_entitlements e LEFT JOIN users u ON u.id = e.created_by WHERE e.service_id = ? ORDER BY e.created_at DESC`)
      .bind(serviceId)
      .all<{ id: string; kind: string; quantity: number; unit_price_php: number | null; reason: string | null; creator_name: string | null; creator_email: string | null; created_at: string }>(),
    getAllowance(db, serviceId, now),
    activationChecklist(db, serviceId),
    db
      .prepare(`SELECT outcome, error_code, error_message, details_json, created_at FROM email_provisioning_logs WHERE service_id = ? AND operation = 'sync' ORDER BY created_at DESC LIMIT 1`)
      .bind(serviceId)
      .first<{ outcome: string; error_code: string | null; error_message: string | null; details_json: string | null; created_at: string }>(),
    s.plan_id ? db.prepare(`SELECT id, name, status, billing_interval FROM email_plans WHERE id = ?`).bind(s.plan_id).first<{ id: string; name: string; status: string; billing_interval: string }>() : Promise.resolve(null),
  ]);

  const staffIds = [...new Set(mailboxes.results.filter((m) => m.created_by_type === "staff" && m.created_by).map((m) => m.created_by!))];
  const creatorNames = new Map<string, string>();
  if (staffIds.length) {
    const users = await db
      .prepare(`SELECT id, COALESCE(full_name, email) AS name FROM users WHERE id IN (${staffIds.map(() => "?").join(",")})`)
      .bind(...staffIds)
      .all<{ id: string; name: string }>();
    for (const u of users.results) creatorNames.set(u.id, u.name);
  }

  const provider = getEmailProvider(s.provider);
  const providerStatus = provider.status();
  let lastSyncDetails: unknown = null;
  try {
    lastSyncDetails = lastSync?.details_json ? JSON.parse(lastSync.details_json) : null;
  } catch {
    lastSyncDetails = null;
  }

  return {
    id: s.id,
    client: client ? { id: client.id, fullName: client.full_name, businessName: client.business_name, email: client.email } : null,
    status: s.status,
    effectiveStatus: effectiveServiceStatus(s.status, s.expires_at, now),
    statusReason: s.status_reason,
    startsAt: s.starts_at,
    expiresAt: s.expires_at,
    decommissionedAt: s.decommissioned_at,
    internalNotes: s.internal_notes,
    plan: s.plan_id
      ? {
          id: s.plan_id,
          name: s.plan_name_snapshot,
          currentCatalogName: plan?.name ?? null,
          catalogStatus: plan?.status ?? null,
          billingInterval: plan?.billing_interval ?? null,
          pricePhp: s.price_php,
          includedMailboxes: s.included_mailboxes,
          storageQuotaMb: s.storage_quota_mb,
          additionalMailboxPricePhp: s.additional_mailbox_price_php,
        }
      : null,
    allowance,
    activationChecklist: checklist,
    domains: domains.results.map((d) => ({ id: d.id, domain: d.domain, isPrimary: !!d.is_primary, status: d.status, providerDomainId: d.provider_domain_id, createdAt: d.created_at, removedAt: d.removed_at })),
    mailboxes: mailboxes.results.map((m) => serializeMailbox(m, creatorNames)),
    entitlements: entitlements.results.map((e) => ({
      id: e.id,
      kind: e.kind,
      quantity: e.quantity,
      unitPricePhp: e.unit_price_php,
      reason: e.reason,
      createdBy: e.creator_name || e.creator_email,
      createdAt: e.created_at,
    })),
    provider: {
      name: s.provider,
      displayName: providerDisplayName(s.provider),
      configured: providerStatus.configured,
      message: providerStatus.message,
      providerServiceId: s.provider_service_id,
      providerStatus: s.provider_status,
      storageUsedMb: s.storage_used_mb,
      syncStatus: s.sync_status,
      lastSyncAt: s.last_sync_at,
      lastSyncError: s.last_sync_error,
      lastSync: lastSync ? { outcome: lastSync.outcome, errorCode: lastSync.error_code, errorMessage: lastSync.error_message, details: lastSyncDetails, createdAt: lastSync.created_at } : null,
    },
    createdAt: s.created_at,
    updatedAt: s.updated_at,
  };
}

export async function getServiceLogs(db: D1Database, serviceId: string, opts: { limit?: number } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  const [audit, provisioning] = await Promise.all([
    db
      .prepare(
        `SELECT a.*, u.full_name AS staff_name, u.email AS staff_email, m.address AS mailbox_address
         FROM email_audit_logs a LEFT JOIN users u ON a.actor_type = 'staff' AND u.id = a.actor_id LEFT JOIN email_mailboxes m ON m.id = a.mailbox_id
         WHERE a.service_id = ? ORDER BY a.created_at DESC, a.rowid DESC LIMIT ?`
      )
      .bind(serviceId, limit)
      .all<{ id: string; actor_type: string; actor_id: string | null; action: string; before_json: string | null; after_json: string | null; reason: string | null; created_at: string; staff_name: string | null; staff_email: string | null; mailbox_address: string | null }>(),
    db
      .prepare(
        `SELECT p.*, m.address AS mailbox_address FROM email_provisioning_logs p LEFT JOIN email_mailboxes m ON m.id = p.mailbox_id
         WHERE p.service_id = ? ORDER BY p.created_at DESC, p.rowid DESC LIMIT ?`
      )
      .bind(serviceId, limit)
      .all<{ id: string; operation: string; outcome: string; error_code: string | null; error_message: string | null; retryable: number; duration_ms: number | null; provider: string; actor_type: string; created_at: string; mailbox_address: string | null }>(),
  ]);
  const parse = (v: string | null) => {
    if (!v) return null;
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  };
  return {
    audit: audit.results.map((a) => ({
      id: a.id,
      actorType: a.actor_type,
      actor: a.actor_type === "staff" ? a.staff_name || a.staff_email || a.actor_id : a.actor_type === "system" ? "System" : a.actor_id,
      action: a.action,
      mailboxAddress: a.mailbox_address,
      before: parse(a.before_json),
      after: parse(a.after_json),
      reason: a.reason,
      createdAt: a.created_at,
    })),
    operations: provisioning.results.map((p) => ({
      id: p.id,
      operation: p.operation,
      outcome: p.outcome,
      errorCode: p.error_code,
      errorMessage: p.error_message,
      retryable: !!p.retryable,
      durationMs: p.duration_ms,
      provider: p.provider,
      actorType: p.actor_type,
      mailboxAddress: p.mailbox_address,
      createdAt: p.created_at,
    })),
  };
}

// Failed/unknown provider operations across every service, newest first.
export async function listFailedOperations(db: D1Database, limit = 100) {
  const rows = await db
    .prepare(
      `SELECT p.id, p.service_id, p.operation, p.outcome, p.error_code, p.error_message, p.retryable, p.created_at, m.address AS mailbox_address, m.status AS mailbox_status, c.business_name
       FROM email_provisioning_logs p
       JOIN email_services s ON s.id = p.service_id JOIN clients c ON c.id = s.client_id
       LEFT JOIN email_mailboxes m ON m.id = p.mailbox_id
       WHERE p.outcome IN ('failed', 'unknown') ORDER BY p.created_at DESC LIMIT ?`
    )
    .bind(Math.min(Math.max(limit, 1), 500))
    .all<{ id: string; service_id: string; operation: string; outcome: string; error_code: string | null; error_message: string | null; retryable: number; created_at: string; mailbox_address: string | null; mailbox_status: string | null; business_name: string }>();
  return rows.results.map((r) => ({
    id: r.id,
    serviceId: r.service_id,
    businessName: r.business_name,
    operation: r.operation,
    outcome: r.outcome,
    errorCode: r.error_code,
    errorMessage: r.error_message,
    retryable: !!r.retryable,
    mailboxAddress: r.mailbox_address,
    mailboxStatus: r.mailbox_status,
    createdAt: r.created_at,
  }));
}
