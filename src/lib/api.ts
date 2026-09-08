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
