// Typed client for functions/api/mail-connect/* -- the Webmail Connect
// API, CLAUDE.md §38. The ONLY data layer /mail/connect uses; it never
// calls /api/app/* (staff) or /api/mail-client/* (mailbox-owner login).
//
// A connect session can hold several mailboxes, so every mailbox call
// carries an explicit mailboxId (query on reads, body on writes), and the
// server checks it against that person's live grants on every request.
// forMailbox() binds one mailbox into the shape OwnerMailWorkspace takes.
// Which session a request carries is decided by the browser from cookie
// paths: the connect cookie is Path=/api/mail-connect.

import { apiFetch, ApiError } from "./api";
import type { ClientSendResult, ClientThread, ComposePrefill } from "./clientMailApi";
import type { ThreadRow } from "./mailApi";
import type { OwnerMailApi } from "../components/mail/OwnerMailWorkspace";

export interface ConnectMailbox {
  id: string;
  emailAddress: string;
  displayName: string;
  canSend: boolean;
  canDelete: boolean;
  canManageSettings: boolean;
  isDefault: boolean;
}

export interface ConnectSession {
  integrationName: string;
  returnUrl: string | null;
  unavailableCount: number;
  mailboxes: ConnectMailbox[];
}

const BASE = "/api/mail-connect";

export const connectMailApi = {
  /** null when not signed in. */
  async me(): Promise<ConnectSession | null> {
    try {
      return await apiFetch<ConnectSession>(`${BASE}/me`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return null;
      throw err;
    }
  },
  logout() {
    return apiFetch<{ ok: true }>(`${BASE}/logout`, { method: "POST", body: JSON.stringify({}) });
  },
  createSignature(mailboxId: string, body: { name: string; bodyHtml: string; useForNew: boolean; useForReply: boolean }) {
    return apiFetch<{ id: string }>(`${BASE}/signatures`, { method: "POST", body: JSON.stringify({ mailboxId, ...body }) });
  },
  forMailbox(mailboxId: string): OwnerMailApi {
    return {
      list(folder, q, offset = 0) {
        const sp = new URLSearchParams({ mailboxId, folder: q ? "all" : folder, offset: String(offset) });
        if (q) sp.set("q", q);
        return apiFetch<{ threads: ThreadRow[]; hasMore: boolean }>(`${BASE}/messages?${sp}`);
      },
      thread(id, context, remoteImages = false) {
        const sp = new URLSearchParams({ mailboxId, context });
        if (remoteImages) sp.set("remoteImages", "1");
        return apiFetch<ClientThread>(`${BASE}/threads/${encodeURIComponent(id)}?${sp}`);
      },
      setFlags(id, flags) {
        return apiFetch(`${BASE}/messages/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ mailboxId, ...flags }) });
      },
      move(id, to) {
        return apiFetch(`${BASE}/messages/${encodeURIComponent(id)}/move`, { method: "POST", body: JSON.stringify({ mailboxId, to }) });
      },
      prefill(mode, sourceMessageId) {
        const sp = new URLSearchParams({ mailboxId, mode });
        if (sourceMessageId) sp.set("sourceMessageId", sourceMessageId);
        return apiFetch<ComposePrefill>(`${BASE}/compose?${sp}`);
      },
      send(body) {
        return apiFetch<ClientSendResult>(`${BASE}/send`, { method: "POST", body: JSON.stringify({ mailboxId, ...body }) });
      },
      downloadUrl(attachmentId) {
        return `${BASE}/attachments/${encodeURIComponent(attachmentId)}`;
      },
    };
  },
};

/** Only http(s) "back" links are ever rendered; the server already validated it, this is belt and braces. */
export function safeReturnUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}
