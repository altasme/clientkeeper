// Typed client for every functions/api/app/* endpoint, plus the
// unauthenticated auth-logout call. All requests use credentials:
// "same-origin" (this app's own ck_session cookie) — never
// "include"/cross-origin, since this API is same-origin by construction
// (Cloudflare Pages Functions on the same domain as the SPA).

export type Stage =
  | "payment_received"
  | "account_created"
  | "discovery"
  | "building"
  | "ready_for_presentation"
  | "presentation"
  | "post_presentation"
  | "offer_unlocked"
  | "conversion"
  | "essential_upsell"
  | "on_hold"
  | "cancelled"
  | "completed";

export type StaffRole = "owner" | "developer" | "admin" | "sales";

export interface StaffUser {
  id: string;
  email: string;
  full_name: string | null;
  role: StaffRole;
}

export interface MeResponse {
  staffUser: StaffUser;
}

// Mirrors functions/_lib/roles.ts's isMyCafeAdmin exactly — display-only
// here (hides buttons a non-admin's request would be rejected for anyway;
// the server is what actually enforces this on every MyCafe provisioning/
// device/licensing route).
export function isMyCafeAdmin(staffUser: StaffUser): boolean {
  return staffUser.role === "owner" || staffUser.role === "admin";
}

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers: options.body ? { "Content-Type": "application/json", ...options.headers } : options.headers,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(res.status, (body as { error?: string } | null)?.error || `Request failed: ${res.status}`, body as Record<string, unknown> | null);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export class ApiError extends Error {
  status: number;
  // The full error response body, when the endpoint sent one beyond just
  // `error` (e.g. createClient's 409 duplicate-email response also
  // carries a `clientId` so the caller can link to the existing record).
  body: Record<string, unknown> | null;
  constructor(status: number, message: string, body: Record<string, unknown> | null = null) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export async function fetchMe(): Promise<MeResponse | "unauthenticated" | "not_staff"> {
  const res = await fetch("/api/app/me", { credentials: "same-origin" });
  if (res.status === 401) return "unauthenticated";
  if (res.status === 403) return "not_staff";
  if (!res.ok) throw new Error(`Failed to load account: ${res.status}`);
  return (await res.json()) as MeResponse;
}

export async function logout(): Promise<void> {
  await fetch("/api/auth-logout", { method: "POST", credentials: "same-origin" });
}

// ---------------------------------------------------------------------------
// Dashboard

export interface DashboardCounts {
  newClientsToday: number;
  discoveryToday: number;
  buildingToday: number;
  presentationToday: number;
  offersUnlockedToday: number;
  conversionsToday: number;
}

export interface ActiveClientRow {
  id: string;
  fullName: string;
  businessName: string;
  invitationStatus: string;
  stage: Stage | null;
  updatedAt: string | null;
}

export function fetchDashboard(): Promise<{ counts: DashboardCounts; activeClients: ActiveClientRow[] }> {
  return apiFetch("/api/app/dashboard");
}

// ---------------------------------------------------------------------------
// Clients

export interface ClientListRow {
  id: string;
  fullName: string;
  businessName: string;
  email: string;
  invitationStatus: string;
  createdAt: string;
  projectId: string | null;
  stage: Stage | null;
  updatedAt: string | null;
}

export function fetchClients(query: { q?: string; stage?: string; paidNoAccount?: boolean } = {}): Promise<ClientListRow[]> {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.stage) params.set("stage", query.stage);
  if (query.paidNoAccount) params.set("paidNoAccount", "1");
  const qs = params.toString();
  return apiFetch(`/api/app/clients${qs ? `?${qs}` : ""}`);
}

export function createClient(fields: {
  fullName: string;
  businessName: string;
  email: string;
  mobile?: string;
  facebook?: string;
  currentWebsite?: string;
  initialStage?: Stage;
}): Promise<{ id: string; projectId: string; createdAt: string }> {
  return apiFetch(`/api/app/clients`, { method: "POST", body: JSON.stringify(fields) });
}

// MyCafe POS — a second product line, deliberately separate from the
// web_dev clients/projects/stage machine above (see clientkeeper's CLAUDE.md
// MyCafe section). A MyCafe client only ever has these fields; there's no
// stage, no project, no discovery/presentation/offer concepts for it.

export interface MyCafeClientRow {
  id: string;
  fullName: string;
  businessName: string;
  email: string;
  mycafeCafeId: string | null;
  mycafeStatus: string | null;
  createdAt: string;
}

export function fetchMyCafeClients(filters: { q?: string; status?: string } = {}): Promise<MyCafeClientRow[]> {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.status) params.set("status", filters.status);
  const qs = params.toString();
  return apiFetch(`/api/app/mycafe/clients${qs ? `?${qs}` : ""}`);
}

export interface MyCafeEntitlement {
  state: string;
  tier: string | null;
  trialEndsAt: string;
  daysRemaining: number;
  currentPeriodEndsAt: string | null;
}

export interface MyCafeDashboard {
  counts: {
    totalBusinesses: number;
    activeBusinesses: number;
    trialBusinesses: number;
    expiredBusinesses: number;
    provisioningBusinesses: number;
    registeredDevices: number;
    activeDevices: number;
  };
  recentActivity: {
    id: string;
    clientId: string;
    businessName: string;
    type: string;
    description: string;
    createdAt: string;
  }[];
}

export function fetchMyCafeDashboard(): Promise<MyCafeDashboard> {
  return apiFetch(`/api/app/mycafe/dashboard`);
}

export interface MyCafeCafeDetail {
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
  tier: string | null;
  billingCycle: string | null;
  branchLimit: number | null;
  branches: { id: string; name: string; active: boolean; createdAt: string }[];
}

export interface MyCafeClientDetail {
  client: {
    id: string;
    fullName: string;
    businessName: string;
    email: string;
    mycafeSlug: string | null;
    mycafeStoreName: string | null;
    mycafeCafeId: string | null;
    mycafeStatus: string | null;
    createdAt: string;
    updatedAt: string;
  };
  cafe: MyCafeCafeDetail | null;
  cafeError: string | null;
  activity: { id: string; type: string; description: string; actor_id: string | null; created_at: string }[];
}

export function fetchMyCafeClientDetail(clientId: string): Promise<MyCafeClientDetail> {
  return apiFetch(`/api/app/mycafe/clients/${clientId}`);
}

export interface MyCafeDeviceRow {
  id: string;
  deviceName: string;
  branchId: string | null;
  branchName: string | null;
  active: boolean;
  createdAt: string;
  deactivatedAt: string | null;
  lastUsedAt: string | null;
}

export function fetchMyCafeDevices(clientId: string): Promise<MyCafeDeviceRow[]> {
  return apiFetch(`/api/app/mycafe/clients/${clientId}/devices`);
}

export function revokeMyCafeDevice(clientId: string, deviceId: string): Promise<{ ok: boolean }> {
  return apiFetch(`/api/app/mycafe/clients/${clientId}/devices/${deviceId}/revoke`, { method: "POST" });
}

export function createMyCafeClient(fields: {
  fullName: string;
  businessName: string;
  email: string;
  storeName: string;
  slug: string;
}): Promise<{ id: string; createdAt: string }> {
  return apiFetch(`/api/app/mycafe/clients`, { method: "POST", body: JSON.stringify(fields) });
}

export interface MyCafeProvisionResult {
  cafeId: string;
  status: "active" | "provisioning";
  deviceActivationToken?: string;
  // Set whenever status !== "active" — MyCafe's own explanation of which
  // provisioning step failed. Surface this; a silent "provisioning" status
  // with no reason leaves staff unable to tell a stuck cafe from one still
  // mid-flight.
  error?: string;
}

export function provisionMyCafeClient(clientId: string): Promise<MyCafeProvisionResult> {
  return apiFetch(`/api/app/mycafe/clients/${clientId}/provision`, { method: "POST" });
}

export function mintMyCafeDeviceToken(clientId: string): Promise<{ deviceActivationToken: string }> {
  return apiFetch(`/api/app/mycafe/clients/${clientId}/new-device`, { method: "POST" });
}

export interface ClientDetail {
  client: {
    id: string;
    workos_user_id: string | null;
    email: string;
    full_name: string;
    business_name: string;
    mobile: string | null;
    facebook: string | null;
    current_website: string | null;
    invitation_status: string;
    domain_registered_at: string | null;
    plan_renewal_date: string | null;
    created_at: string;
    updated_at: string;
  };
  project: {
    id: string;
    stage: Stage;
    assigned_developer_id: string | null;
    website_url: string | null;
    created_at: string;
    updated_at: string;
  } | null;
  discovery: {
    id: string;
    external_status: string;
    internal_notes: string | null;
    preferred_times: string | null;
    scheduled_at: string | null;
    meeting_link: string | null;
    created_at: string;
    updated_at: string;
  } | null;
  presentation: {
    id: string;
    external_status: string;
    internal_notes: string | null;
    preferred_times: string | null;
    scheduled_at: string | null;
    meeting_link: string | null;
    client_decision: string | null;
    created_at: string;
    updated_at: string;
  } | null;
  offers: Array<{
    id: string;
    type: string;
    status: string;
    content: Record<string, unknown> | null;
    unlocked_by: string | null;
    unlocked_at: string | null;
    created_at: string;
    updated_at: string;
  }>;
  stageHistory: Array<{ id: string; from_stage: string | null; to_stage: string; actor_id: string | null; reason: string | null; created_at: string }>;
  payments: Array<{ id: string; ganap_reference_number: string; external_reference: string | null; amount: number; currency: string; status: string; created_at: string }>;
  activity: Array<{ id: string; type: string; description: string; actor_id: string | null; created_at: string }>;
  subscriptions: Array<{
    id: string;
    item_type: "plan" | "addon";
    item_id: string;
    item_name: string;
    billing_cycle: "one_time" | "annual" | "monthly";
    amount_php: number;
    renewal_amount_php: number | null;
    next_renewal_date: string | null;
    started_at: string;
  }>;
}

export function fetchClientDetail(id: string): Promise<ClientDetail> {
  return apiFetch(`/api/app/clients/${id}`);
}

export function addClientActivity(id: string, note: string): Promise<{ id: string; createdAt: string }> {
  return apiFetch(`/api/app/clients/${id}/activity`, { method: "POST", body: JSON.stringify({ note }) });
}

export function resendInvite(id: string): Promise<{ ok: true }> {
  return apiFetch(`/api/app/clients/${id}/resend-invite`, { method: "POST" });
}

export function setClientPlan(id: string, planId: string): Promise<{ ok: true; plan: string }> {
  return apiFetch(`/api/app/clients/${id}/set-plan`, { method: "POST", body: JSON.stringify({ planId }) });
}

export function setProjectWebsite(id: string, websiteUrl: string): Promise<{ ok: true; websiteUrl: string | null }> {
  return apiFetch(`/api/app/projects/${id}/website`, { method: "POST", body: JSON.stringify({ websiteUrl }) });
}

export function setClientDates(
  id: string,
  fields: { domainRegisteredAt?: string | null; planRenewalDate?: string | null }
): Promise<{ ok: true; domainRegisteredAt: string | null; planRenewalDate: string | null }> {
  return apiFetch(`/api/app/clients/${id}/set-dates`, { method: "POST", body: JSON.stringify(fields) });
}

export interface ClientDetailsFields {
  fullName?: string;
  businessName?: string;
  email?: string;
  mobile?: string | null;
  facebook?: string | null;
  currentWebsite?: string | null;
}

export function setClientDetails(
  id: string,
  fields: ClientDetailsFields
): Promise<{
  ok: true;
  fullName: string;
  businessName: string;
  email: string;
  mobile: string | null;
  facebook: string | null;
  currentWebsite: string | null;
}> {
  return apiFetch(`/api/app/clients/${id}/set-details`, { method: "POST", body: JSON.stringify(fields) });
}

export function sendWsaLink(id: string): Promise<{ ok: true }> {
  return apiFetch(`/api/app/clients/${id}/send-wsa`, { method: "POST" });
}

export function sendDomainReminder(id: string): Promise<{ ok: true }> {
  return apiFetch(`/api/app/clients/${id}/send-domain-reminder`, { method: "POST" });
}

export function deleteClient(id: string): Promise<{ ok: true }> {
  return apiFetch(`/api/app/clients/${id}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Leads

export interface Lead {
  id: string;
  full_name: string | null;
  business_name: string | null;
  email: string | null;
  phone: string | null;
  source: string | null;
  status: "new" | "contacted" | "qualified" | "converted" | "lost";
  notes: string | null;
  created_at: string;
  updated_at: string;
}

// [2026-10-15] Single-lead fetch for LeadDetailPage (CLAUDE.md §25's
// "proposal generator that doesn't need a client" -- the lead-detail
// page a prospect proposal is created and viewed from).
export function fetchLead(id: string): Promise<Lead> {
  return apiFetch(`/api/app/leads/${id}`);
}

export function fetchLeads(query: { q?: string; status?: string } = {}): Promise<Lead[]> {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.status) params.set("status", query.status);
  const qs = params.toString();
  return apiFetch(`/api/app/leads${qs ? `?${qs}` : ""}`);
}

export function createLead(fields: {
  fullName?: string;
  businessName?: string;
  email?: string;
  phone?: string;
  source?: string;
  notes?: string;
}): Promise<{ id: string; createdAt: string }> {
  return apiFetch(`/api/app/leads`, { method: "POST", body: JSON.stringify(fields) });
}

export function updateLead(id: string, fields: { status?: Lead["status"]; notes?: string }): Promise<{ ok: true }> {
  return apiFetch(`/api/app/leads/${id}`, { method: "PATCH", body: JSON.stringify(fields) });
}

// ---------------------------------------------------------------------------
// Projects

export interface ProjectListRow {
  id: string;
  stage: Stage;
  websiteUrl: string | null;
  updatedAt: string;
  assignedDeveloperId: string | null;
  clientId: string;
  clientFullName: string;
  businessName: string;
}

export function fetchProjects(stage?: string): Promise<ProjectListRow[]> {
  const qs = stage ? `?stage=${encodeURIComponent(stage)}` : "";
  return apiFetch(`/api/app/projects${qs}`);
}

export function advanceProject(id: string, toStage: Stage): Promise<{ stage: Stage }> {
  return apiFetch(`/api/app/projects/${id}/advance`, { method: "POST", body: JSON.stringify({ toStage }) });
}

export function overrideProject(id: string, toStage: Stage, reason: string): Promise<{ stage: Stage }> {
  return apiFetch(`/api/app/projects/${id}/override`, { method: "POST", body: JSON.stringify({ toStage, reason }) });
}

// ---------------------------------------------------------------------------
// Discovery / Presentations

export interface DiscoveryRow {
  id: string;
  external_status: string;
  internal_notes: string | null;
  preferred_times: string | null;
  scheduled_at: string | null;
  created_at: string;
  updated_at: string;
  project_id: string;
  client_id: string;
  full_name: string;
  business_name: string;
}

export function fetchDiscoverySessions(status?: string): Promise<DiscoveryRow[]> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  return apiFetch(`/api/app/discovery${qs}`);
}

export function updateDiscoverySession(
  id: string,
  fields: { externalStatus?: string; internalNotes?: string; scheduledAt?: string | null; meetingLink?: string | null }
): Promise<{ ok: true }> {
  return apiFetch(`/api/app/discovery/${id}`, { method: "PATCH", body: JSON.stringify(fields) });
}

export interface PresentationRow extends DiscoveryRow {
  client_decision: string | null;
}

export function fetchPresentations(status?: string): Promise<PresentationRow[]> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  return apiFetch(`/api/app/presentations${qs}`);
}

export function createPresentation(fields: { projectId: string; scheduledAt: string; meetingLink?: string }): Promise<{ id: string }> {
  return apiFetch(`/api/app/presentations`, { method: "POST", body: JSON.stringify(fields) });
}

export function updatePresentation(
  id: string,
  fields: { externalStatus?: string; internalNotes?: string; scheduledAt?: string | null; meetingLink?: string | null }
): Promise<{ ok: true }> {
  return apiFetch(`/api/app/presentations/${id}`, { method: "PATCH", body: JSON.stringify(fields) });
}

// ---------------------------------------------------------------------------
// Availability (booking engine)

export interface AvailabilityRule {
  id: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
  created_at: string;
}

export function fetchAvailabilityRules(): Promise<AvailabilityRule[]> {
  return apiFetch(`/api/app/availability`);
}

export function addAvailabilityRule(fields: { dayOfWeek: number; startTime: string; endTime: string }): Promise<{ id: string }> {
  return apiFetch(`/api/app/availability`, { method: "POST", body: JSON.stringify(fields) });
}

export function deleteAvailabilityRule(id: string): Promise<{ ok: true }> {
  return apiFetch(`/api/app/availability/${id}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Offers

export interface OfferRow {
  id: string;
  type: string;
  status: string;
  content: Record<string, unknown> | null;
  unlockedBy: string | null;
  unlockedAt: string | null;
  createdAt: string;
  updatedAt: string;
  clientId: string;
  clientFullName: string;
  businessName: string;
}

export function fetchOffers(): Promise<OfferRow[]> {
  return apiFetch(`/api/app/offers`);
}

export function unlockOffer(projectId: string, type: "1499" | "essential"): Promise<{ offerId: string; stage: Stage }> {
  return apiFetch(`/api/app/offers/unlock`, { method: "POST", body: JSON.stringify({ projectId, type }) });
}

export function recordOfferDecision(id: string, decision: "accepted" | "declined"): Promise<{ ok: true }> {
  return apiFetch(`/api/app/offers/${id}/decision`, { method: "POST", body: JSON.stringify({ decision }) });
}

// ---------------------------------------------------------------------------
// Payments

export interface PaymentRow {
  id: string;
  ganap_reference_number: string;
  external_reference: string | null;
  amount: number;
  currency: string;
  status: string;
  created_at: string;
  client_id: string | null;
  full_name: string | null;
  business_name: string | null;
}

export function fetchPayments(): Promise<PaymentRow[]> {
  return apiFetch(`/api/app/payments`);
}

// ---------------------------------------------------------------------------
// Bills (Bill of Service)

export type BillStatus = "pending" | "paid" | "expired" | "cancelled";
export type ClientType = "individual" | "corporate";

export interface BillListRow {
  id: string;
  billNumber: string;
  token: string;
  clientType: ClientType;
  recipientName: string;
  currency: string;
  totalAmount: number;
  status: BillStatus;
  issueDate: string;
  expiresAt: string;
  createdAt: string;
  clientId: string | null;
  clientFullName: string | null;
  clientBusinessName: string | null;
}

export function fetchBills(): Promise<BillListRow[]> {
  return apiFetch(`/api/app/bills`);
}

export interface BillLineItem {
  description: string;
  amount: number;
}

export interface BillDetail {
  id: string;
  billNumber: string;
  token: string;
  publicUrl: string;
  clientId: string | null;
  clientFullName: string | null;
  clientBusinessName: string | null;
  clientType: ClientType;
  recipientName: string;
  recipientContactPerson: string | null;
  recipientTin: string | null;
  recipientEmail: string | null;
  scopeDescription: string | null;
  currency: string;
  totalAmount: number;
  validityDays: number;
  issueDate: string;
  expiresAt: string;
  status: BillStatus;
  notes: string | null;
  paidAt: string | null;
  createdAt: string;
  lineItems: BillLineItem[];
}

export function fetchBillDetail(id: string): Promise<BillDetail> {
  return apiFetch(`/api/app/bills/${id}`);
}

export function createBill(fields: {
  clientId?: string;
  clientType: ClientType;
  recipientName: string;
  recipientContactPerson?: string;
  recipientTin?: string;
  recipientEmail?: string;
  scopeDescription?: string;
  lineItems: BillLineItem[];
  validityDays?: number;
  notes?: string;
}): Promise<{ id: string; billNumber: string; token: string; publicUrl: string; createdAt: string }> {
  return apiFetch(`/api/app/bills`, { method: "POST", body: JSON.stringify(fields) });
}

export function cancelBill(id: string): Promise<{ ok: true }> {
  return apiFetch(`/api/app/bills/${id}/cancel`, { method: "POST" });
}

export interface ReconcileBillResult {
  reconciled: boolean;
  billStatus: string;
  ganapStatus?: string;
  webhookDelivered?: boolean | null;
  webhookLastResponse?: string | null;
  message?: string;
  error?: string;
}

// Deliberately NOT apiFetch() — this hits clienthub's domain directly,
// cross-origin, since ClientKeeper holds no ganap.net credentials of its
// own (this app's isolation-by-design, see CLAUDE.md §0) and the actual
// status-check call can only happen where those credentials live. No
// cookies needed: the bill's own token is the endpoint's only gate, same
// as the public bill page itself.
export async function reconcileBillPayment(token: string): Promise<ReconcileBillResult> {
  const res = await fetch(`https://account.altasme.com/api/public/bill/${token}/reconcile`, {
    method: "POST",
  });
  const data = (await res.json().catch(() => ({}))) as ReconcileBillResult;
  if (!res.ok) throw new Error(data.error || "Couldn't check payment status.");
  return data;
}

// ---------------------------------------------------------------------------
// Proposals & Questionnaires
//
// Public, client-facing viewing/signing/filling pages are served by the
// marketing site (www.altasme.com/proposal/:slug, /questions/:slug),
// reading the same shared D1 database directly -- the publicUrl each
// endpoint below returns points there, not at anything in this app.

export type ProposalStatus = "draft" | "published" | "sent" | "signed" | "declined" | "expired" | "revoked";

export interface ProposalListRow {
  id: string;
  slug: string;
  publicUrl: string;
  title: string;
  status: ProposalStatus;
  currentVersion: number;
  questionnaireId: string | null;
  createdAt: string;
  updatedAt: string;
}

export function fetchProposals(clientId: string): Promise<ProposalListRow[]> {
  return apiFetch(`/api/app/clients/${clientId}/proposals`);
}

export function createProposal(clientId: string, title?: string): Promise<{ id: string; slug: string; title: string; status: ProposalStatus }> {
  return apiFetch(`/api/app/clients/${clientId}/proposals`, { method: "POST", body: JSON.stringify({ title }) });
}

// [2026-10-15] Lead-scoped siblings, for a proposal sent to a prospect
// who isn't a client yet (CLAUDE.md §25). Same shapes as the client
// versions above -- only the parent in the URL differs.
export function fetchLeadProposals(leadId: string): Promise<ProposalListRow[]> {
  return apiFetch(`/api/app/leads/${leadId}/proposals`);
}

export function createLeadProposal(leadId: string, title?: string): Promise<{ id: string; slug: string; title: string; status: ProposalStatus }> {
  return apiFetch(`/api/app/leads/${leadId}/proposals`, { method: "POST", body: JSON.stringify({ title }) });
}

// [2026-10-30] A standalone proposal's own listing row (GET
// /api/app/proposals) -- deliberately a separate, flatter shape from
// ProposalDetail/ProposalListRow (whichever of those exist for the
// client-/lead-scoped listings), since this is the one place that
// needs prospect_* fields directly rather than a resolved client/lead.
export interface StandaloneProposalRow {
  id: string;
  slug: string;
  access_token: string;
  title: string;
  status: ProposalStatus;
  prospect_full_name: string | null;
  prospect_business_name: string | null;
  prospect_email: string | null;
  prospect_phone: string | null;
  created_at: string;
  updated_at: string;
}

export function fetchStandaloneProposals(query: { q?: string; status?: string } = {}): Promise<StandaloneProposalRow[]> {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.status) params.set("status", query.status);
  const qs = params.toString();
  return apiFetch(`/api/app/proposals${qs ? `?${qs}` : ""}`);
}

// [2026-10-16] A proposal with no parent at all (CLAUDE.md §26: "create a
// proposal even outside of a lead or client"). The prospect's contact
// info is collected here, at creation, since it's what altaventureswebsite's
// public sign endpoint uses to auto-create a real client the moment this
// proposal is signed -- it's never collected from the public signer.
// prospectEmail is optional [2026-10-29]: name/business name are still
// required, but a proposal created without an email simply won't
// auto-create a client on signing (see the Function's own comment).
export function createStandaloneProposal(fields: {
  prospectFullName: string;
  prospectBusinessName: string;
  prospectEmail?: string;
  prospectPhone?: string;
  title?: string;
}): Promise<{ id: string; slug: string; title: string; status: ProposalStatus }> {
  return apiFetch(`/api/app/proposals`, { method: "POST", body: JSON.stringify(fields) });
}

export interface ProposalVersion {
  id: string;
  versionNumber: number;
  title: string;
  contentHtml: string;
  createdAt: string;
}

export interface ProposalSignature {
  id: string;
  versionId: string;
  signerName: string;
  signerTitle: string | null;
  signatureDataUrl: string;
  ipAddress: string | null;
  signedAt: string;
}

export interface ProposalDetail {
  id: string;
  // [2026-10-15] Exactly one of these is set -- CLAUDE.md §25's
  // client-or-lead parent. The editor uses this to build the right
  // "back to..." link and to hide the questionnaire-link card when
  // there's no client to link a questionnaire to.
  clientId: string | null;
  leadId: string | null;
  // [2026-10-16] Only ever set on a standalone proposal (clientId and
  // leadId both null) -- the prospect info staff entered at creation,
  // read-only here (there's no PATCH support for these, per CLAUDE.md
  // §26: entered once, at creation, never edited after).
  prospectFullName: string | null;
  prospectBusinessName: string | null;
  prospectEmail: string | null;
  prospectPhone: string | null;
  slug: string;
  publicUrl: string;
  title: string;
  contentHtml: string;
  status: ProposalStatus;
  currentVersion: number;
  questionnaireId: string | null;
  expiresAt: string | null;
  // [2026-10-29] Payment-request fields, CLAUDE.md §27 -- configurable
  // per proposal in the editor below, shown on the public payment screen
  // right after the client signs.
  paymentEnabled: boolean;
  paymentAmountLabel: string;
  paymentGcashNumber: string;
  paymentGcashAccountName: string;
  paymentBankNote: string;
  paymentMarkedPaidAt: string | null;
  createdAt: string;
  updatedAt: string;
  versions: ProposalVersion[];
  signature: ProposalSignature | null;
}

// [2026-10-15] Flattened to /api/app/proposals/:id -- a proposal no
// longer needs a client (or lead) parent in the URL to be resolved by
// its own id (CLAUDE.md §25). Resolving by id alone also means this one
// set of calls now serves both client-backed and lead-backed proposals.
export function fetchProposalDetail(proposalId: string): Promise<ProposalDetail> {
  return apiFetch(`/api/app/proposals/${proposalId}`);
}

export function updateProposalDraft(
  proposalId: string,
  fields: {
    title?: string;
    contentHtml?: string;
    questionnaireId?: string | null;
    paymentEnabled?: boolean;
    paymentAmountLabel?: string;
    paymentGcashNumber?: string;
    paymentGcashAccountName?: string;
    paymentBankNote?: string;
  }
): Promise<{ ok: true; updatedAt: string }> {
  return apiFetch(`/api/app/proposals/${proposalId}`, { method: "PATCH", body: JSON.stringify(fields) });
}

export function publishProposal(proposalId: string): Promise<{ status: ProposalStatus; versionNumber: number }> {
  return apiFetch(`/api/app/proposals/${proposalId}/publish`, { method: "POST" });
}

export function revokeProposal(proposalId: string): Promise<{ ok: true }> {
  return apiFetch(`/api/app/proposals/${proposalId}/revoke`, { method: "POST" });
}

export type QuestionnaireStatus = "draft" | "published" | "submitted" | "closed";
export type QuestionFieldType = "short_text" | "long_text" | "single_choice" | "multi_choice" | "dropdown" | "yes_no" | "date" | "url" | "file";

export interface QuestionnaireListRow {
  id: string;
  slug: string;
  publicUrl: string;
  title: string;
  status: QuestionnaireStatus;
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
}

export function fetchQuestionnaires(clientId: string): Promise<QuestionnaireListRow[]> {
  return apiFetch(`/api/app/clients/${clientId}/questionnaires`);
}

export function createQuestionnaire(clientId: string, title?: string, description?: string): Promise<{ id: string; slug: string; title: string; status: QuestionnaireStatus }> {
  return apiFetch(`/api/app/clients/${clientId}/questionnaires`, { method: "POST", body: JSON.stringify({ title, description }) });
}

export interface QuestionDraft {
  id: string;
  sectionHeading: string | null;
  sectionDescription: string | null;
  prompt: string;
  helpText: string | null;
  fieldType: QuestionFieldType;
  isRequired: boolean;
  options: string[];
  sortOrder: number;
}

export interface QuestionnaireVersion {
  id: string;
  versionNumber: number;
  title: string;
  description: string | null;
  createdAt: string;
}

export interface QuestionnaireDetail {
  id: string;
  slug: string;
  publicUrl: string;
  title: string;
  description: string | null;
  status: QuestionnaireStatus;
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
  draftQuestions: QuestionDraft[];
  versions: QuestionnaireVersion[];
  responseCount: number;
}

export function fetchQuestionnaireDetail(clientId: string, questionnaireId: string): Promise<QuestionnaireDetail> {
  return apiFetch(`/api/app/clients/${clientId}/questionnaires/${questionnaireId}`);
}

export function updateQuestionnaireDraft(clientId: string, questionnaireId: string, fields: { title?: string; description?: string | null }): Promise<{ ok: true; updatedAt: string }> {
  return apiFetch(`/api/app/clients/${clientId}/questionnaires/${questionnaireId}`, { method: "PATCH", body: JSON.stringify(fields) });
}

export interface QuestionInput {
  sectionHeading: string | null;
  sectionDescription: string | null;
  prompt: string;
  helpText: string | null;
  fieldType: QuestionFieldType;
  isRequired: boolean;
  options: string[];
}

export function saveQuestionnaireQuestions(clientId: string, questionnaireId: string, questions: QuestionInput[]): Promise<{ ok: true; count: number }> {
  return apiFetch(`/api/app/clients/${clientId}/questionnaires/${questionnaireId}/questions`, { method: "PUT", body: JSON.stringify({ questions }) });
}

export function publishQuestionnaire(clientId: string, questionnaireId: string): Promise<{ status: QuestionnaireStatus; versionNumber: number }> {
  return apiFetch(`/api/app/clients/${clientId}/questionnaires/${questionnaireId}/publish`, { method: "POST" });
}

export function revokeQuestionnaire(clientId: string, questionnaireId: string): Promise<{ ok: true }> {
  return apiFetch(`/api/app/clients/${clientId}/questionnaires/${questionnaireId}/revoke`, { method: "POST" });
}

export interface QuestionnaireAnswer {
  questionId: string;
  prompt: string;
  fieldType: QuestionFieldType;
  valueText: string | null;
  valueList: string[] | null;
  fileUrl: string | null;
  fileName: string | null;
}

export interface QuestionnaireResponse {
  id: string;
  submittedAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  answers: QuestionnaireAnswer[];
}

export function fetchQuestionnaireResponses(clientId: string, questionnaireId: string): Promise<QuestionnaireResponse[]> {
  return apiFetch(`/api/app/clients/${clientId}/questionnaires/${questionnaireId}/responses`);
}
