// Typed client for /api/app/email-services/* and /api/app/email-plans/*
// (CLAUDE.md §34). Uses api.ts's apiFetch (same-origin, ck_session).

import { apiFetch, type StaffUser } from "./api";

export type ServiceStatus = "pending_setup" | "active" | "suspended" | "expired" | "cancelled" | "provisioning_error";
export type MailboxStatus = "reserved" | "provisioning" | "active" | "failed" | "needs_review" | "deleting" | "deleted" | "discarded";
export type LifecycleAction = "activate" | "suspend" | "reactivate" | "renew" | "decommission";

// Display-only mirror of the server's owner/admin gate.
export function canManageEmail(staffUser: StaffUser): boolean {
  return staffUser.role === "owner" || staffUser.role === "admin";
}

export interface Allowance {
  included: number;
  additional: number;
  overrides: number;
  total: number;
  active: number;
  pending: number;
  available: number;
}

export interface EmailServiceListItem {
  id: string;
  clientId: string;
  clientName: string;
  businessName: string;
  primaryDomain: string | null;
  planName: string | null;
  status: ServiceStatus;
  effectiveStatus: ServiceStatus;
  expiresAt: string | null;
  allowance: Allowance;
  syncStatus: string;
  failedCount: number;
  needsReviewCount: number;
  createdAt: string;
}

export interface EmailMailbox {
  id: string;
  address: string;
  domainId: string;
  isPrimary: boolean;
  status: MailboxStatus;
  inboundSource: string;
  providerServiceId: string | null;
  providerMailboxId: string | null;
  bridgedMailAccountId: string | null;
  failureCode: string | null;
  lastError: string | null;
  createdBy: string | null;
  createdByType: string;
  provisionedAt: string | null;
  deletedAt: string | null;
  lastSyncedAt: string | null;
  createdAt: string;
}

export interface Discrepancy {
  type: string;
  address: string | null;
  mailboxId: string | null;
  providerMailboxId: string | null;
  detail: string;
}

export interface EmailServiceDetail {
  id: string;
  client: { id: string; fullName: string; businessName: string; email: string } | null;
  status: ServiceStatus;
  effectiveStatus: ServiceStatus;
  statusReason: string | null;
  startsAt: string | null;
  expiresAt: string | null;
  decommissionedAt: string | null;
  internalNotes: string | null;
  plan: {
    id: string;
    name: string | null;
    currentCatalogName: string | null;
    catalogStatus: string | null;
    billingInterval: string | null;
    pricePhp: number | null;
    includedMailboxes: number;
    storageQuotaMb: number | null;
    additionalMailboxPricePhp: number | null;
  } | null;
  allowance: Allowance | null;
  activationChecklist: { planAssigned: boolean; domainAssigned: boolean; mailboxActive: boolean };
  domains: { id: string; domain: string; isPrimary: boolean; status: "active" | "removed"; providerDomainId: string | null; createdAt: string; removedAt: string | null }[];
  mailboxes: EmailMailbox[];
  entitlements: { id: string; kind: "addon" | "override"; quantity: number; unitPricePhp: number | null; reason: string | null; createdBy: string | null; createdAt: string }[];
  provider: {
    name: string;
    displayName: string;
    configured: boolean;
    message: string;
    providerServiceId: string | null;
    providerStatus: string | null;
    storageUsedMb: number | null;
    syncStatus: string;
    lastSyncAt: string | null;
    lastSyncError: string | null;
    lastSync: { outcome: string; errorCode: string | null; errorMessage: string | null; details: { discrepancies?: Discrepancy[]; checkedDomains?: string[] } | null; createdAt: string } | null;
  };
  createdAt: string;
  updatedAt: string;
}

export interface EmailPlan {
  id: string;
  name: string;
  pricePhp: number;
  billingInterval: "annual" | "monthly";
  includedMailboxes: number;
  storageQuotaMb: number;
  additionalMailboxPricePhp: number;
  features: string[];
  status: "active" | "archived";
  sortOrder: number;
  servicesUsing: number;
  updatedAt: string;
}

export interface AuditEntry {
  id: string;
  actorType: string;
  actor: string | null;
  action: string;
  mailboxAddress: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
  createdAt: string;
}

export interface OperationEntry {
  id: string;
  operation: string;
  outcome: "succeeded" | "failed" | "unknown";
  errorCode: string | null;
  errorMessage: string | null;
  retryable: boolean;
  durationMs: number | null;
  provider: string;
  actorType: string;
  mailboxAddress: string | null;
  createdAt: string;
}

export interface FailedOperation {
  id: string;
  serviceId: string;
  businessName: string;
  operation: string;
  outcome: string;
  errorCode: string | null;
  errorMessage: string | null;
  retryable: boolean;
  mailboxAddress: string | null;
  mailboxStatus: string | null;
  createdAt: string;
}

const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });
const svc = (id: string) => `/api/app/email-services/${encodeURIComponent(id)}`;

export const fetchEmailServices = (filters: { status?: string; q?: string } = {}) => {
  const p = new URLSearchParams();
  if (filters.status) p.set("status", filters.status);
  if (filters.q) p.set("q", filters.q);
  const qs = p.toString();
  return apiFetch<{ services: EmailServiceListItem[] }>(`/api/app/email-services${qs ? `?${qs}` : ""}`).then((r) => r.services);
};
export const fetchFailedOperations = () => apiFetch<{ operations: FailedOperation[] }>(`/api/app/email-services/operations`).then((r) => r.operations);
export const createEmailService = (body: { clientId: string; planId?: string; domain?: string; internalNotes?: string }) =>
  apiFetch<{ serviceId: string; warnings: string[] }>(`/api/app/email-services`, post(body));
export const fetchEmailService = (id: string) => apiFetch<EmailServiceDetail>(svc(id));
export const updateEmailService = (id: string, body: { internalNotes?: string; providerServiceId?: string; expiresAt?: string | null; reason?: string }) =>
  apiFetch<unknown>(svc(id), { method: "PATCH", body: JSON.stringify(body) });
export const assignEmailPlan = (id: string, planId: string, reason?: string) => apiFetch<unknown>(`${svc(id)}/plan`, post({ planId, reason }));
export const addEmailDomain = (id: string, domain: string, isPrimary: boolean) => apiFetch<unknown>(`${svc(id)}/domains`, post({ domain, isPrimary }));
export const removeEmailDomain = (id: string, domainId: string, reason?: string) =>
  apiFetch<unknown>(`${svc(id)}/domains/${encodeURIComponent(domainId)}`, { method: "DELETE", body: JSON.stringify({ reason }) });
export const adjustEmailEntitlement = (id: string, kind: "addon" | "override", quantity: number, reason?: string) =>
  apiFetch<{ allowance: Allowance }>(`${svc(id)}/entitlements`, post({ kind, quantity, reason }));
export const provisionEmailMailbox = (id: string, body: { domainId: string; localPart: string; password: string; isPrimary: boolean; idempotencyKey: string }) =>
  apiFetch<{ mailbox: EmailMailbox }>(`${svc(id)}/mailboxes`, post(body));
const mb = (id: string, mailboxId: string, action: string) => `${svc(id)}/mailboxes/${encodeURIComponent(mailboxId)}/${action}`;
export const retryEmailMailbox = (id: string, mailboxId: string, password: string) => apiFetch<{ mailbox: EmailMailbox }>(mb(id, mailboxId, "retry"), post({ password }));
export const deleteEmailMailbox = (id: string, mailboxId: string, reason: string) => apiFetch<{ mailbox: EmailMailbox }>(mb(id, mailboxId, "delete"), post({ reason }));
export const discardEmailMailbox = (id: string, mailboxId: string) => apiFetch<unknown>(mb(id, mailboxId, "discard"), post({}));
export const resolveEmailMailbox = (id: string, mailboxId: string, resolution: "exists" | "absent", reason: string, providerMailboxId?: string) =>
  apiFetch<unknown>(mb(id, mailboxId, "resolve"), post({ resolution, reason, providerMailboxId }));
export const transitionEmailService = (id: string, action: LifecycleAction, reason?: string, expiresAt?: string) =>
  apiFetch<unknown>(`${svc(id)}/lifecycle`, post({ action, reason, expiresAt }));
export const syncEmailService = (id: string) =>
  apiFetch<{ ok: boolean; error: { code: string; message: string } | null; discrepancies: Discrepancy[]; checkedDomains: string[] }>(`${svc(id)}/sync`, post({}));
export const fetchEmailServiceLogs = (id: string) => apiFetch<{ audit: AuditEntry[]; operations: OperationEntry[] }>(`${svc(id)}/logs`);

export const fetchEmailPlans = (all = false) => apiFetch<{ plans: EmailPlan[] }>(`/api/app/email-plans${all ? "?all=1" : ""}`).then((r) => r.plans);
export type EmailPlanInput = Partial<Pick<EmailPlan, "name" | "pricePhp" | "billingInterval" | "includedMailboxes" | "storageQuotaMb" | "additionalMailboxPricePhp" | "features" | "status" | "sortOrder">>;
export const createEmailPlan = (body: EmailPlanInput) => apiFetch<{ id: string }>(`/api/app/email-plans`, post(body));
export const updateEmailPlan = (id: string, body: EmailPlanInput) => apiFetch<unknown>(`/api/app/email-plans/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) });

// ---------------------------------------------------------------------------
// Display helpers

export const SERVICE_STATUS_LABEL: Record<ServiceStatus, string> = {
  pending_setup: "Pending setup",
  active: "Active",
  suspended: "Suspended",
  expired: "Expired",
  cancelled: "Cancelled",
  provisioning_error: "Provisioning error",
};

export const SERVICE_STATUS_STYLE: Record<ServiceStatus, string> = {
  pending_setup: "bg-amber-100 text-amber-700",
  active: "bg-green-100 text-green-700",
  suspended: "bg-orange-100 text-orange-700",
  expired: "bg-ink/10 text-ink/60",
  cancelled: "bg-ink/10 text-ink/50",
  provisioning_error: "bg-red-100 text-red-700",
};

export const MAILBOX_STATUS_LABEL: Record<MailboxStatus, string> = {
  reserved: "Reserved",
  provisioning: "Provisioning",
  active: "Active",
  failed: "Failed",
  needs_review: "Needs review",
  deleting: "Deleting",
  deleted: "Deleted",
  discarded: "Discarded",
};

export const MAILBOX_STATUS_STYLE: Record<MailboxStatus, string> = {
  reserved: "bg-sky-100 text-sky-700",
  provisioning: "bg-sky-100 text-sky-700",
  active: "bg-green-100 text-green-700",
  failed: "bg-red-100 text-red-700",
  needs_review: "bg-amber-100 text-amber-700",
  deleting: "bg-orange-100 text-orange-700",
  deleted: "bg-ink/10 text-ink/50",
  discarded: "bg-ink/10 text-ink/40",
};

const PHP = new Intl.NumberFormat("en-US");
export const formatPhp = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `₱${PHP.format(n)}`);
export const formatStorage = (mb: number | null | undefined) => (mb === null || mb === undefined ? "—" : mb % 1024 === 0 ? `${mb / 1024} GB` : `${(mb / 1024).toFixed(1)} GB`);
export const formatDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—");
export const formatDateTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : "—");
