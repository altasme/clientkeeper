// Talks to the MyCafe POS control-plane Worker's admin API
// (mycafe-pos-system/control-plane/src/index.ts) to provision a cafe or mint
// a device activation token for a `clients` row with `product = 'mycafe_pos'`
// (see CLAUDE.md's MyCafe section). Same "duplicate the pattern, not the
// code" convention as every other cross-repo shared concept in this
// codebase (functions/_lib/email.ts etc.) — MyCafe POS is a separate
// product with its own repo/deploy, this is just the one place this app
// calls out to it.
//
// MYCAFE_ADMIN_API_TOKEN is the SAME bearer token MyCafe's own control-plane
// /admin/* routes require everywhere else (its ADMIN_API_TOKEN secret) — set
// it here as a Cloudflare Pages environment variable/secret, never
// committed, same discipline as RESEND_API_KEY/WORKOS_API_KEY.

export interface MyCafeEnv {
  MYCAFE_ADMIN_API_TOKEN: string;
  MYCAFE_CONTROL_PLANE_URL: string;
}

export class MyCafeApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface ProvisionResult {
  cafeId: string;
  status: "active" | "provisioning";
  deviceActivationToken?: string;
  error?: string;
}

// Creates a brand-new cafe (first call for this client) or resumes a
// partially-provisioned one (mycafeCafeId already on file — provisioning is
// idempotent/resumable on MyCafe's side, see its BACKEND.md). A resume never
// returns a fresh deviceActivationToken (that step already ran) — call
// mintMyCafeDevice separately if the client needs a new one.
export async function provisionMyCafeCafe(
  env: MyCafeEnv,
  input: {
    mycafeCafeId: string | null;
    slug: string;
    businessName: string;
    storeName: string;
    ownerEmail: string;
    ownerName: string;
  },
): Promise<ProvisionResult> {
  const url = input.mycafeCafeId
    ? `${env.MYCAFE_CONTROL_PLANE_URL}/admin/cafes/${input.mycafeCafeId}/provision`
    : `${env.MYCAFE_CONTROL_PLANE_URL}/admin/cafes`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.MYCAFE_ADMIN_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: input.mycafeCafeId
      ? undefined
      : JSON.stringify({
          slug: input.slug,
          businessName: input.businessName,
          storeName: input.storeName,
          ownerEmail: input.ownerEmail,
          ownerName: input.ownerName,
        }),
  });

  const body = (await response.json().catch(() => null)) as ProvisionResult | null;
  if (!response.ok || !body) {
    throw new MyCafeApiError(response.status, body?.error || `MyCafe provisioning failed: ${response.status}`);
  }
  return body;
}

// Mints an additional device activation token for an already-active cafe —
// the plaintext token is only ever returned once by MyCafe's API and never
// stored there, same rule applies here: display it to staff once, never
// persist it in this app's own database either.
export async function mintMyCafeDevice(env: MyCafeEnv, mycafeCafeId: string): Promise<string> {
  const response = await fetch(`${env.MYCAFE_CONTROL_PLANE_URL}/admin/cafes/${mycafeCafeId}/devices`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.MYCAFE_ADMIN_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ deviceName: "ClientKeeper-issued device" }),
  });
  const body = (await response.json().catch(() => null)) as { deviceActivationToken?: string; error?: string } | null;
  if (!response.ok || !body?.deviceActivationToken) {
    throw new MyCafeApiError(response.status, body?.error || `Minting a device token failed: ${response.status}`);
  }
  return body.deviceActivationToken;
}

async function adminGet<T>(env: MyCafeEnv, path: string): Promise<T> {
  const response = await fetch(`${env.MYCAFE_CONTROL_PLANE_URL}${path}`, {
    headers: { Authorization: `Bearer ${env.MYCAFE_ADMIN_API_TOKEN}` },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = (body as { error?: string } | null)?.error || `MyCafe request failed: ${response.status}`;
    throw new MyCafeApiError(response.status, message);
  }
  return body as T;
}

export interface MyCafeEntitlement {
  state: string;
  tier: string | null;
  trialEndsAt: string;
  daysRemaining: number;
  currentPeriodEndsAt: string | null;
}

export interface MyCafeAccountSummary {
  id: string;
  slug: string;
  businessName: string;
  storeName: string;
  ownerEmail: string;
  ownerName: string;
  status: "provisioning" | "active" | "suspended";
  createdAt: string;
  activatedAt: string | null;
  entitlement: MyCafeEntitlement | null;
  branchLimit: number | null;
  branchCount: number;
  deviceCount: number;
  activeDeviceCount: number;
}

// Every provisioned cafe, for the Overview Dashboard's counts. Read-only
// admin data — never cached here, always a live call, since staff need an
// accurate current count, not a snapshot.
export function listMyCafeCafes(env: MyCafeEnv): Promise<MyCafeAccountSummary[]> {
  return adminGet(env, `/admin/cafes`);
}

export interface MyCafeCafeDetail extends MyCafeAccountSummary {
  tier: string | null;
  billingCycle: string | null;
  branches: { id: string; name: string; active: boolean; createdAt: string }[];
}

export function getMyCafeCafeDetail(env: MyCafeEnv, mycafeCafeId: string): Promise<MyCafeCafeDetail> {
  return adminGet(env, `/admin/cafes/${mycafeCafeId}`);
}

export interface MyCafeDevice {
  id: string;
  deviceName: string;
  branchId: string | null;
  branchName: string | null;
  active: boolean;
  createdAt: string;
  deactivatedAt: string | null;
  lastUsedAt: string | null;
}

export function listMyCafeDevices(env: MyCafeEnv, mycafeCafeId: string): Promise<MyCafeDevice[]> {
  return adminGet(env, `/admin/cafes/${mycafeCafeId}/devices`);
}

export async function revokeMyCafeDevice(env: MyCafeEnv, mycafeCafeId: string, deviceId: string): Promise<void> {
  const response = await fetch(
    `${env.MYCAFE_CONTROL_PLANE_URL}/admin/cafes/${mycafeCafeId}/devices/${deviceId}/revoke`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${env.MYCAFE_ADMIN_API_TOKEN}` },
    },
  );
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) {
    throw new MyCafeApiError(response.status, body?.error || `Revoking the device failed: ${response.status}`);
  }
}

// ---- Announcements / "What's New" ------------------------------------------
// Posts live in MyCafe's own database and are shown in every cafe's Owner Panel;
// this app only writes them through MyCafe's admin API (the same token as
// everything above). Rules (lengths, https-only links, statuses) are enforced on
// MyCafe's side too -- this is a thin pass-through, not a second source of truth.
export type MyCafeAnnouncementCategory = "new_feature" | "improvement" | "fix" | "announcement" | "maintenance";
export type MyCafeAnnouncementStatus = "draft" | "published" | "archived";

export interface MyCafeAnnouncement {
  id: number;
  title: string;
  body: string;
  category: MyCafeAnnouncementCategory;
  linkUrl: string | null;
  linkLabel: string | null;
  pinned: boolean;
  status: MyCafeAnnouncementStatus;
  publishedAt: string | null;
  author: string | null;
  createdAt: string;
  updatedAt: string;
  readByCafes: number;
}

async function adminSend<T>(env: MyCafeEnv, method: "POST" | "PATCH" | "DELETE", path: string, payload?: unknown): Promise<T> {
  const response = await fetch(`${env.MYCAFE_CONTROL_PLANE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.MYCAFE_ADMIN_API_TOKEN}`,
      ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new MyCafeApiError(response.status, (body as { error?: string } | null)?.error || `MyCafe request failed: ${response.status}`);
  }
  return body as T;
}

export async function listMyCafeAnnouncements(env: MyCafeEnv, status?: string): Promise<MyCafeAnnouncement[]> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  const result = await adminGet<{ announcements: MyCafeAnnouncement[] }>(env, `/admin/announcements${qs}`);
  return result.announcements;
}

export function getMyCafeAnnouncement(env: MyCafeEnv, id: string): Promise<MyCafeAnnouncement> {
  return adminGet(env, `/admin/announcements/${encodeURIComponent(id)}`);
}

export function createMyCafeAnnouncement(env: MyCafeEnv, fields: Record<string, unknown>): Promise<MyCafeAnnouncement> {
  return adminSend(env, "POST", `/admin/announcements`, fields);
}

export function updateMyCafeAnnouncement(env: MyCafeEnv, id: string, fields: Record<string, unknown>): Promise<MyCafeAnnouncement> {
  return adminSend(env, "PATCH", `/admin/announcements/${encodeURIComponent(id)}`, fields);
}

export function deleteMyCafeAnnouncement(env: MyCafeEnv, id: string): Promise<{ deleted: boolean }> {
  return adminSend(env, "DELETE", `/admin/announcements/${encodeURIComponent(id)}`);
}

// ---- Per-café insights and account actions ---------------------------------
// MyCafe's own admin routes (mycafe-pos-system control-plane/src/cafe-admin.ts).
// Sales figures are aggregates only; nothing here identifies a customer or an order.
export interface MyCafeSalesSummary {
  cafeId: string;
  from: string;
  to: string;
  days: number;
  grossCentavos: number;
  netCentavos: number;
  discountCentavos: number;
  refundCentavos: number;
  deliveryFeeCentavos: number;
  orderCount: number;
  averageOrderCentavos: number;
  paymentBreakdown: { method: string; amountCentavos: number }[];
  topProducts: { name: string; units: number; revenueCentavos: number }[];
  daily: { date: string; netCentavos: number; orders: number }[];
}

export interface MyCafeCafeActivity {
  cafeId: string;
  status: "provisioning" | "active" | "suspended";
  suspendedAt: string | null;
  suspendedReason: string | null;
  lastOrderAt: string | null;
  orders7d: number;
  orders30d: number;
  lastDeviceUseAt: string | null;
  openShifts: number;
  activeStaff: number;
  billing: { id: string; kind: string; amountCentavos: number; reference: string | null; createdAt: string }[];
  actions: { action: string; reason: string | null; actor: string | null; detail: unknown; createdAt: string }[];
}

export function getMyCafeSalesSummary(env: MyCafeEnv, mycafeCafeId: string, from?: string, to?: string): Promise<MyCafeSalesSummary> {
  const qs = new URLSearchParams();
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  const q = qs.toString();
  return adminGet(env, `/admin/cafes/${mycafeCafeId}/sales-summary${q ? `?${q}` : ""}`);
}

export function getMyCafeActivity(env: MyCafeEnv, mycafeCafeId: string): Promise<MyCafeCafeActivity> {
  return adminGet(env, `/admin/cafes/${mycafeCafeId}/activity`);
}

export function suspendMyCafeCafe(env: MyCafeEnv, mycafeCafeId: string, reason: string, actor: string): Promise<{ status: string }> {
  return adminSend(env, "POST", `/admin/cafes/${mycafeCafeId}/suspend`, { reason, actor });
}

export function reactivateMyCafeCafe(env: MyCafeEnv, mycafeCafeId: string, actor: string): Promise<{ status: string }> {
  return adminSend(env, "POST", `/admin/cafes/${mycafeCafeId}/reactivate`, { actor });
}

export function extendMyCafeTrial(
  env: MyCafeEnv,
  mycafeCafeId: string,
  days: number,
  reason: string | null,
  actor: string,
): Promise<{ trialEndsAt: string; daysAdded: number }> {
  return adminSend(env, "POST", `/admin/cafes/${mycafeCafeId}/extend-trial`, { days, reason, actor });
}
