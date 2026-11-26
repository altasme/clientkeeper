// Typed client for functions/api/mail-client/* -- the mailbox-owner
// ("client mail") API, CLAUDE.md §36. This is the ONLY data layer the
// client mail pages use; it never calls /api/app/* (the staff API), and the
// staff mailApi.ts is never used by those pages.
//
// Reuses api.ts's apiFetch for transport only: it attaches no auth header
// and sends cookies same-origin, nothing staff-specific. Which session a
// request carries is decided by the browser from cookie paths: the client
// cookie is Path=/api/mail-client, and the server side of this API reads
// only that cookie. Types are shared with mailApi.ts as type-only imports
// (the response shapes come from the same @altasme/webmail-kit functions).

import { apiFetch, ApiError } from "./api";
import type { Addr, MessageDetail, ThreadRow } from "./mailApi";

export type ClientFolder = "inbox" | "starred" | "sent" | "archive" | "junk" | "trash";
export type ComposeMode = "new" | "reply" | "reply_all" | "forward";

export interface ClientMailbox {
  emailAddress: string;
  displayName: string;
  canSend: boolean;
}

export interface ClientThread {
  id: string;
  subject: string;
  messages: MessageDetail[];
}

export interface ComposePrefill {
  mode: ComposeMode;
  to: Addr[];
  cc: Addr[];
  subject: string;
  bodyHtml: string;
  sourceMessageId: string | null;
}

export interface ClientSendResult {
  jobId: string;
  messageId: string;
  threadId: string;
  duplicate: boolean;
  status: "sent" | "retry_scheduled" | "failed" | "queued" | "sending";
  error: string | null;
}

const BASE = "/api/mail-client";

export const clientMailApi = {
  /** null when not signed in. */
  async me(): Promise<ClientMailbox | null> {
    try {
      return await apiFetch<ClientMailbox>(`${BASE}/me`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return null;
      throw err;
    }
  },
  login(email: string, password: string) {
    return apiFetch<{ ok: true; emailAddress: string; displayName: string }>(`${BASE}/login`, { method: "POST", body: JSON.stringify({ email, password }) });
  },
  logout() {
    return apiFetch<{ ok: true }>(`${BASE}/logout`, { method: "POST", body: JSON.stringify({}) });
  },
  list(folder: ClientFolder, q: string, offset = 0) {
    const sp = new URLSearchParams({ folder: q ? "all" : folder, offset: String(offset) });
    if (q) sp.set("q", q);
    return apiFetch<{ threads: ThreadRow[]; hasMore: boolean; offset: number; limit: number }>(`${BASE}/messages?${sp}`);
  },
  thread(id: string, context: ClientFolder, remoteImages = false) {
    const sp = new URLSearchParams({ context });
    if (remoteImages) sp.set("remoteImages", "1");
    return apiFetch<ClientThread>(`${BASE}/threads/${encodeURIComponent(id)}?${sp}`);
  },
  setFlags(id: string, flags: { isRead?: boolean; isStarred?: boolean }) {
    return apiFetch<{ id: string; isRead: boolean; isStarred: boolean; folder: string }>(`${BASE}/messages/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(flags) });
  },
  move(id: string, to: "inbox" | "archive" | "junk" | "trash") {
    return apiFetch<{ ok: true; changed: boolean; folder: string }>(`${BASE}/messages/${encodeURIComponent(id)}/move`, { method: "POST", body: JSON.stringify({ to }) });
  },
  prefill(mode: ComposeMode, sourceMessageId?: string) {
    const sp = new URLSearchParams({ mode });
    if (sourceMessageId) sp.set("sourceMessageId", sourceMessageId);
    return apiFetch<ComposePrefill>(`${BASE}/compose?${sp}`);
  },
  send(body: { mode: ComposeMode; to: Addr[]; cc: Addr[]; bcc: Addr[]; subject: string; html: string; idempotencyKey: string; sourceMessageId: string | null }) {
    return apiFetch<ClientSendResult>(`${BASE}/send`, { method: "POST", body: JSON.stringify(body) });
  },
  downloadUrl(attachmentId: string) {
    return `${BASE}/attachments/${encodeURIComponent(attachmentId)}`;
  },
};
