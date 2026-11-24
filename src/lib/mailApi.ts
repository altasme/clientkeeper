// Typed client for functions/api/app/mail/*. Reuses api.ts's apiFetch
// (same-origin ck_session cookie, ApiError on non-2xx).

import { apiFetch, ApiError } from "./api";

export type FolderId = "inbox" | "starred" | "sent" | "drafts" | "archive" | "junk" | "trash";
export interface Addr {
  name: string | null;
  email: string;
}

export interface Signature {
  id: string;
  accountId: string;
  name: string;
  bodyHtml: string;
  bodyText: string;
  useForNew: boolean;
  useForReply: boolean;
}

export interface Identity {
  id: string;
  emailAddress: string;
  displayName: string;
  replyTo: string | null;
  smtpProfile?: string | null;
  inboundEnabled: boolean;
  outboundEnabled: boolean;
  isActive: boolean;
  sortOrder: number;
  canAccess: boolean;
  canSend: boolean;
  smtpStatus: "configured" | "not_configured";
  lastInboundAt: string | null;
  accessCount?: number;
  signatures: Signature[];
}

export interface Label {
  id: string;
  accountId: string;
  name: string;
  color: string;
}

export interface MessageMeta {
  id: string;
  accountId: string;
  threadId: string;
  direction: "inbound" | "outbound";
  folder: string;
  status: string;
  from: Addr;
  replyTo: string | null;
  to: Addr[];
  cc: Addr[];
  bcc: Addr[];
  subject: string;
  snippet: string;
  isRead: boolean;
  isStarred: boolean;
  hasAttachments: boolean;
  size: number;
  messageIdHeader: string | null;
  inReplyTo: string | null;
  references: string | null;
  authResults: string | null;
  date: string;
  labelIds: string[];
}

export interface AttachmentInfo {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  contentId: string | null;
  isInline: boolean;
  available: boolean;
}

export interface MessageDetail extends MessageMeta {
  bodyHtml: string;
  bodyText: string;
  remoteImagesBlocked: number;
  remoteImagePolicy: "block" | "allow" | "never";
  remoteImagesShown: boolean;
  attachments: AttachmentInfo[];
  sendJob: { status: string; attempts: number; lastError: string | null; nextRetryAt: string | null; lastAttemptedAt: string | null } | null;
}

export interface ThreadRow {
  threadId: string;
  latest: MessageMeta;
  messageIds: string[];
  matchCount: number;
  threadMessageCount: number;
  unreadCount: number;
  isStarred: boolean;
  hasAttachments: boolean;
  labelIds: string[];
  failedSend: boolean;
  pendingSend: boolean;
  latestAt: string;
}

export interface ListFilters {
  q?: string;
  unread?: boolean;
  starred?: boolean;
  hasAttachments?: boolean;
  from?: string;
  to?: string;
  dateFrom?: string;
  dateTo?: string;
}

export interface DraftSummary {
  id: string;
  accountId: string;
  composeMode: string;
  to: Addr[];
  subject: string;
  snippet: string;
  attachmentCount: number;
  updatedAt: string;
}

export interface Draft {
  id: string;
  accountId: string;
  threadId: string | null;
  composeMode: "new" | "reply" | "reply_all" | "forward";
  sourceMessageId: string | null;
  to: Addr[];
  cc: Addr[];
  bcc: Addr[];
  subject: string;
  bodyHtml: string;
  version: number;
  attachments: AttachmentInfo[];
  updatedAt: string;
}

export interface Counts {
  accounts: Record<string, Partial<Record<string, { total: number; unread: number }>>>;
  labels: Record<string, { total: number; unread: number }>;
  newMessages: { id: string; threadId: string; accountId: string; fromName: string | null; fromEmail: string; subject: string; createdAt: string }[];
  serverTime: string;
}

export interface MailUserSettings {
  defaultAccountId: string | null;
  defaultFolder: "inbox" | "starred" | "sent" | "drafts" | "archive";
  sortOrder: "newest" | "oldest";
  density: "comfortable" | "compact";
  readingPane: "right" | "full";
  refreshIntervalSec: number;
  notifyNewMail: boolean;
  sound: boolean;
  desktopNotifications: boolean;
  unreadBadge: boolean;
  composerFormat: "rich" | "plain";
  autosave: boolean;
}

export interface MailPolicy {
  maxAttachmentBytes: number;
  maxAttachmentCount: number;
  maxTotalAttachmentBytes: number;
  maxRecipients: number;
  sendsPerHourPerUser: number;
  remoteImagePolicy: "block" | "allow" | "never";
}

export interface SendResult {
  jobId: string;
  messageId: string;
  threadId: string;
  duplicate: boolean;
  status: "sent" | "retry_scheduled" | "failed" | "queued" | "sending";
  error: string | null;
  nextRetryAt: string | null;
}

export type MessageAction =
  | "markRead"
  | "markUnread"
  | "star"
  | "unstar"
  | "archive"
  | "moveToInbox"
  | "junk"
  | "notJunk"
  | "trash"
  | "restore"
  | "deleteForever"
  | "applyLabel"
  | "removeLabel";

const BASE = "/api/app/mail";
const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });

function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "" || v === false) continue;
    sp.set(k, v === true ? "1" : String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export const mailApi = {
  identities: (all = false) => apiFetch<{ isAdmin: boolean; identities: Identity[] }>(`${BASE}/identities${all ? "?all=1" : ""}`),
  createIdentity: (f: Partial<Identity>) => apiFetch<{ id: string }>(`${BASE}/identities`, { method: "POST", ...json(f) }),
  updateIdentity: (id: string, f: Partial<Identity>) => apiFetch<{ ok: true }>(`${BASE}/identities/${id}`, { method: "PATCH", ...json(f) }),
  identityAccess: (id: string) =>
    apiFetch<{ grants: { userId: string; canSend: boolean; email: string; fullName: string | null; role: string }[] }>(`${BASE}/identities/${id}/access`),
  setIdentityAccess: (id: string, grants: { userId: string; canSend: boolean }[]) => apiFetch<{ ok: true }>(`${BASE}/identities/${id}/access`, { method: "PUT", ...json({ grants }) }),
  staff: () => apiFetch<{ staff: { id: string; email: string; fullName: string | null; role: string }[] }>(`${BASE}/staff`),
  createSignature: (accountId: string, f: { name: string; bodyHtml: string; useForNew: boolean; useForReply: boolean }) =>
    apiFetch<{ id: string }>(`${BASE}/identities/${accountId}/signatures`, { method: "POST", ...json(f) }),
  updateSignature: (id: string, f: Partial<{ name: string; bodyHtml: string; useForNew: boolean; useForReply: boolean }>) =>
    apiFetch<{ ok: true }>(`${BASE}/signatures/${id}`, { method: "PATCH", ...json(f) }),
  deleteSignature: (id: string) => apiFetch<{ ok: true }>(`${BASE}/signatures/${id}`, { method: "DELETE" }),

  counts: (accountId: string, since?: string) => apiFetch<Counts>(`${BASE}/counts${qs({ accountId, since })}`),
  list: (p: { accountId: string; folder: string; labelId?: string | null; sort?: string; offset?: number } & ListFilters) =>
    apiFetch<{ threads: ThreadRow[]; hasMore: boolean; searchMode: string }>(`${BASE}/${p.q || p.from || p.to || p.dateFrom || p.dateTo ? "search" : "messages"}${qs({ ...p, limit: 50 })}`),
  thread: (id: string, context: string, remoteImages = false) =>
    apiFetch<{ id: string; accountId: string; subject: string; messages: MessageDetail[] }>(`${BASE}/threads/${id}${qs({ context, remoteImages })}`),
  message: (id: string, remoteImages = false) => apiFetch<MessageDetail>(`${BASE}/messages/${id}${qs({ remoteImages })}`),
  bulk: (messageIds: string[], action: MessageAction, labelId?: string) =>
    apiFetch<{ ok: true; affected: number }>(`${BASE}/messages/bulk`, { method: "POST", ...json({ messageIds, action, labelId }) }),

  labels: (accountId: string) => apiFetch<{ labels: Label[] }>(`${BASE}/labels${qs({ accountId })}`),
  createLabel: (f: { accountId: string; name: string; color: string }) => apiFetch<Label>(`${BASE}/labels`, { method: "POST", ...json(f) }),
  updateLabel: (id: string, f: { name?: string; color?: string }) => apiFetch<Label>(`${BASE}/labels/${id}`, { method: "PATCH", ...json(f) }),
  deleteLabel: (id: string) => apiFetch<{ ok: true }>(`${BASE}/labels/${id}`, { method: "DELETE" }),

  drafts: (accountId: string) => apiFetch<{ drafts: DraftSummary[] }>(`${BASE}/drafts${qs({ accountId })}`),
  createDraft: (f: { accountId: string; mode: Draft["composeMode"]; sourceMessageId?: string | null }) => apiFetch<Draft>(`${BASE}/drafts`, { method: "POST", ...json(f) }),
  draft: (id: string) => apiFetch<Draft>(`${BASE}/drafts/${id}`),
  saveDraft: (id: string, f: Partial<Pick<Draft, "accountId" | "to" | "cc" | "bcc" | "subject" | "bodyHtml">> & { version: number }) =>
    apiFetch<Draft>(`${BASE}/drafts/${id}`, { method: "PATCH", ...json(f) }),
  deleteDraft: (id: string) => apiFetch<{ ok: true }>(`${BASE}/drafts/${id}`, { method: "DELETE" }),
  sendDraft: (id: string, idempotencyKey: string) => apiFetch<SendResult>(`${BASE}/drafts/${id}/send`, { method: "POST", ...json({ idempotencyKey }) }),
  retrySend: (messageId: string) => apiFetch<{ status: string; error: string | null }>(`${BASE}/send/retry`, { method: "POST", ...json({ messageId }) }),

  async upload(draftId: string, file: File): Promise<AttachmentInfo> {
    const form = new FormData();
    form.set("draftId", draftId);
    form.set("file", file);
    const res = await fetch(`${BASE}/attachments/upload`, { method: "POST", body: form, credentials: "same-origin" });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new ApiError(res.status, body?.error || `Upload failed: ${res.status}`);
    }
    return (await res.json()) as AttachmentInfo;
  },
  removeAttachment: (id: string) => apiFetch<{ ok: true }>(`${BASE}/attachments/${id}`, { method: "DELETE" }),
  downloadUrl: (id: string) => `${BASE}/attachments/${id}`,
  previewUrl: (id: string) => `${BASE}/attachments/${id}/preview`,
  rawUrl: (messageId: string) => `${BASE}/messages/${messageId}/raw`,

  settings: () => apiFetch<{ user: MailUserSettings; policy: MailPolicy; isAdmin: boolean }>(`${BASE}/settings`),
  saveSettings: (f: { user?: Partial<MailUserSettings>; policy?: Partial<MailPolicy> }) =>
    apiFetch<{ user: MailUserSettings; policy: MailPolicy; isAdmin: boolean }>(`${BASE}/settings`, { method: "PATCH", ...json(f) }),
};

export function newIdempotencyKey(): string {
  return crypto.randomUUID().replace(/-/g, "");
}
