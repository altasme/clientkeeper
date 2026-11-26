// Central rules for email services (CLAUDE.md §34): statuses, which mailbox
// states count against the allowance, which service states allow which
// actions, and the effective-expiry rule. Every route (and the future
// client-facing module in clienthub) reads these, never its own copy.

export const SERVICE_STATUSES = ["pending_setup", "active", "suspended", "expired", "cancelled", "provisioning_error"] as const;
export type ServiceStatus = (typeof SERVICE_STATUSES)[number];

export const MAILBOX_STATUSES = ["reserved", "provisioning", "active", "failed", "needs_review", "deleting", "deleted", "discarded"] as const;
export type MailboxStatus = (typeof MAILBOX_STATUSES)[number];

// How long a fresh reservation may sit before the provider is called, and
// how long a provider call may stay 'provisioning'/'deleting' before it is
// treated as outcome-unknown.
export const RESERVATION_LEASE_MS = 2 * 60 * 1000;

// SQL fragment: a mailbox row (alias `m`) that counts against the
// allowance. `?` is bound to "now". Kept here, next to the TS version
// below, so the two can't silently disagree.
//
// A 'reserved' row counts while its lease is live, OR when it has no
// lease at all (reserved_until IS NULL). The NULL case is a client's
// mailbox request awaiting manual fulfillment by staff
// (requestMailboxByClient in engine.ts): it holds its slot indefinitely,
// until staff fulfill or decline it. sweepStaleMailboxes never touches it
// (`reserved_until <= ?` is never true for NULL) and runProvisioning
// never claims it (it requires `reserved_until > ?`), so only the two
// explicit staff actions can move it.
export const COUNTED_MAILBOX_SQL = `(m.status IN ('provisioning', 'active', 'needs_review', 'deleting') OR (m.status = 'reserved' AND (m.reserved_until IS NULL OR m.reserved_until > ?)))`;

export function mailboxCountsAgainstAllowance(status: MailboxStatus, reservedUntil: string | null, now: string): boolean {
  if (status === "provisioning" || status === "active" || status === "needs_review" || status === "deleting") return true;
  if (status === "reserved") return reservedUntil === null || reservedUntil > now;
  return false;
}

// States staff may fulfill by hand (fulfillMailboxManually): a reservation
// (a client request, or a staff one whose provider call never happened),
// an outcome-unknown attempt, or a definite failure being recovered.
export const MANUALLY_FULFILLABLE_STATUSES: MailboxStatus[] = ["reserved", "needs_review", "failed"];

export interface Allowance {
  included: number;
  additional: number; // purchased add-ons
  overrides: number; // staff adjustments, may be negative
  total: number;
  active: number; // confirmed at the provider
  pending: number; // reserved (incl. client requests)/provisioning/needs_review/deleting: held but not confirmed active
  available: number;
}

export function computeAllowance(input: { included: number; additional: number; overrides: number; active: number; pending: number }): Allowance {
  const total = input.included + input.additional + input.overrides;
  return { ...input, total, available: Math.max(0, total - input.active - input.pending) };
}

export function isPastExpiry(expiresAt: string | null, now: string): boolean {
  return expiresAt !== null && expiresAt <= now;
}

// What the service is right now. An 'active' service whose expires_at has
// passed is expired, whether or not anything has rewritten the row yet.
export function effectiveServiceStatus(status: ServiceStatus, expiresAt: string | null, now: string): ServiceStatus {
  if (status === "active" && isPastExpiry(expiresAt, now)) return "expired";
  return status;
}

// Service states in which a NEW mailbox may be provisioned. Suspended,
// expired and cancelled services never get new mailboxes. The same rule is
// repeated in SQL inside the reservation statement (engine.ts), which is
// the one that actually enforces it.
export const PROVISIONABLE_SERVICE_STATUSES: ServiceStatus[] = ["pending_setup", "active", "provisioning_error"];

export function canProvisionMailbox(status: ServiceStatus, expiresAt: string | null, now: string): boolean {
  return PROVISIONABLE_SERVICE_STATUSES.includes(effectiveServiceStatus(status, expiresAt, now));
}

// Whether the client (future clienthub module) may self-manage mailboxes.
// Staff keep full inspect/manage ability in every state but 'cancelled'.
export function clientCanManageMailboxes(status: ServiceStatus, expiresAt: string | null, now: string): boolean {
  return effectiveServiceStatus(status, expiresAt, now) === "active";
}

export function staffCanManageMailboxes(status: ServiceStatus): boolean {
  return status !== "cancelled";
}

export type LifecycleAction = "activate" | "suspend" | "reactivate" | "renew" | "decommission";

export const LIFECYCLE_FROM: Record<LifecycleAction, ServiceStatus[]> = {
  activate: ["pending_setup", "provisioning_error"],
  suspend: ["active", "expired"],
  reactivate: ["suspended"],
  renew: ["active", "expired", "suspended"],
  decommission: ["pending_setup", "active", "suspended", "expired", "provisioning_error"],
};

export const LIFECYCLE_REQUIRES_REASON: Record<LifecycleAction, boolean> = {
  activate: false,
  suspend: true,
  reactivate: false,
  renew: false,
  decommission: true,
};

// Adds one billing interval to an ISO date. Annual is calendar-year based
// (Feb 29 rolls to Mar 1, standard Date behavior).
export function addInterval(fromIso: string, interval: "annual" | "monthly"): string {
  const d = new Date(fromIso);
  if (interval === "annual") d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString();
}

export function isEmailAdminRole(role: string): boolean {
  return role === "owner" || role === "admin";
}
