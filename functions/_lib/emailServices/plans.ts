// Email plan catalog (email_plans). Editable by owner/admin. Plans are never
// deleted (services keep a reference); they're archived instead. Editing a
// plan changes only future assignments, because services snapshot plan
// values when the plan is assigned (engine.ts assignPlan).

import type { StaffUser } from "../roles";
import { cleanText } from "./validation";

export interface PlanRow {
  id: string;
  name: string;
  price_php: number;
  billing_interval: "annual" | "monthly";
  included_mailboxes: number;
  storage_quota_mb: number;
  additional_mailbox_price_php: number;
  features_json: string;
  status: "active" | "archived";
  sort_order: number;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export function serializePlan(p: PlanRow, servicesUsing = 0) {
  let features: string[] = [];
  try {
    const parsed = JSON.parse(p.features_json);
    if (Array.isArray(parsed)) features = parsed.filter((f): f is string => typeof f === "string");
  } catch {
    features = [];
  }
  return {
    id: p.id,
    name: p.name,
    pricePhp: p.price_php,
    billingInterval: p.billing_interval,
    includedMailboxes: p.included_mailboxes,
    storageQuotaMb: p.storage_quota_mb,
    additionalMailboxPricePhp: p.additional_mailbox_price_php,
    features,
    status: p.status,
    sortOrder: p.sort_order,
    servicesUsing,
    updatedAt: p.updated_at,
  };
}

export async function listPlans(db: D1Database, includeArchived: boolean) {
  const rows = await db
    .prepare(
      `SELECT p.*, (SELECT COUNT(*) FROM email_services s WHERE s.plan_id = p.id AND s.status <> 'cancelled') AS services_using
       FROM email_plans p ${includeArchived ? "" : "WHERE p.status = 'active'"} ORDER BY p.sort_order, p.name`
    )
    .all<PlanRow & { services_using: number }>();
  return rows.results.map((r) => serializePlan(r, Number(r.services_using)));
}

type PlanFields = Omit<PlanRow, "id" | "updated_by" | "created_at" | "updated_at">;

const nonNegInt = (v: unknown, min: number, max: number): number | null => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null);

// Validates a full or partial plan body. Returns the fields to write.
export function validatePlanBody(body: Record<string, unknown>, existing: PlanRow | null): { ok: true; fields: PlanFields } | { ok: false; error: string } {
  const errors: string[] = [];
  function pick<T>(raw: unknown, current: T | undefined, parse: (v: unknown) => T | null, label: string): T {
    if (raw === undefined) {
      if (current !== undefined) return current;
      errors.push(`${label} is required.`);
      return undefined as T;
    }
    const v = parse(raw);
    if (v === null) errors.push(`${label} is invalid.`);
    return v as T;
  }

  const fields: PlanFields = {
    name: pick(body.name, existing?.name, (v) => cleanText(v, 60), "Name"),
    price_php: pick(body.pricePhp, existing?.price_php, (v) => nonNegInt(v, 0, 10_000_000), "Price"),
    billing_interval: pick(body.billingInterval, existing?.billing_interval, (v) => (v === "annual" || v === "monthly" ? v : null), "Billing interval"),
    included_mailboxes: pick(body.includedMailboxes, existing?.included_mailboxes, (v) => nonNegInt(v, 1, 10_000), "Included mailboxes"),
    storage_quota_mb: pick(body.storageQuotaMb, existing?.storage_quota_mb, (v) => nonNegInt(v, 1, 100_000_000), "Storage quota"),
    additional_mailbox_price_php: pick(body.additionalMailboxPricePhp, existing?.additional_mailbox_price_php, (v) => nonNegInt(v, 0, 10_000_000), "Additional mailbox price"),
    status: pick(body.status, existing?.status ?? "active", (v) => (v === "active" || v === "archived" ? v : null), "Status"),
    sort_order: pick(body.sortOrder, existing?.sort_order ?? 100, (v) => nonNegInt(v, 0, 100_000), "Sort order"),
    features_json: pick(
      body.features,
      existing?.features_json ?? "[]",
      (v) =>
        Array.isArray(v) && v.length <= 30 && v.every((f) => typeof f === "string")
          ? JSON.stringify((v as string[]).map((f) => f.trim().slice(0, 120)).filter(Boolean))
          : null,
      "Features"
    ),
  };
  return errors.length ? { ok: false, error: errors[0]! } : { ok: true, fields };
}

export async function createPlan(db: D1Database, fields: PlanFields, staffUser: StaffUser): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        `INSERT INTO email_plans (id, name, price_php, billing_interval, included_mailboxes, storage_quota_mb, additional_mailbox_price_php, features_json, status, sort_order, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(id, fields.name, fields.price_php, fields.billing_interval, fields.included_mailboxes, fields.storage_quota_mb, fields.additional_mailbox_price_php, fields.features_json, fields.status, fields.sort_order, staffUser.id, now, now),
    planAudit(db, staffUser, "email_plan_created", id, null, fields, now),
  ]);
  return id;
}

export async function updatePlan(db: D1Database, existing: PlanRow, fields: PlanFields, staffUser: StaffUser): Promise<void> {
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        `UPDATE email_plans SET name = ?, price_php = ?, billing_interval = ?, included_mailboxes = ?, storage_quota_mb = ?, additional_mailbox_price_php = ?, features_json = ?, status = ?, sort_order = ?, updated_by = ?, updated_at = ?
         WHERE id = ?`
      )
      .bind(fields.name, fields.price_php, fields.billing_interval, fields.included_mailboxes, fields.storage_quota_mb, fields.additional_mailbox_price_php, fields.features_json, fields.status, fields.sort_order, staffUser.id, now, existing.id),
    planAudit(db, staffUser, "email_plan_updated", existing.id, existing, fields, now),
  ]);
}

// Plan changes are catalog-level, not tied to one service, so they go to
// the shared audit_log (entity_type 'email_plan') rather than
// email_audit_logs, which is keyed by service.
function planAudit(db: D1Database, staffUser: StaffUser, action: string, planId: string, before: unknown, after: unknown, now: string): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO audit_log (id, actor_id, action, entity_type, entity_id, before, after, reason, created_at) VALUES (?, ?, ?, 'email_plan', ?, ?, ?, NULL, ?)`)
    .bind(crypto.randomUUID(), staffUser.id, action, planId, before ? JSON.stringify(before) : null, JSON.stringify(after), now);
}
