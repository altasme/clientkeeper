// Pure comparison of local mailbox records against what the provider
// reports. Produces a list of discrepancies for staff to look at; it never
// decides to change anything (CLAUDE.md §34: reconciliation only displays).

import type { MailboxStatus } from "./policy";

export interface LocalMailboxForSync {
  id: string;
  address: string;
  status: MailboxStatus;
  providerMailboxId: string | null;
}

export interface RemoteMailboxForSync {
  providerMailboxId: string;
  address: string;
  status: "active" | "suspended" | "unknown";
}

export type DiscrepancyType =
  | "provider_only" // exists at the provider, no live local record
  | "local_only" // local record says active, provider doesn't have it
  | "failed_but_exists" // local attempt marked failed, provider has it
  | "review_exists" // needs_review locally, provider has it -> likely resolve "exists"
  | "review_absent" // needs_review locally, provider doesn't -> likely resolve "absent"
  | "provider_id_mismatch"
  | "status_mismatch"
  | "duplicate_at_provider"
  | "over_allowance";

export interface Discrepancy {
  type: DiscrepancyType;
  address: string | null;
  mailboxId: string | null;
  providerMailboxId: string | null;
  detail: string;
}

const LIVE_LOCAL: MailboxStatus[] = ["reserved", "provisioning", "active", "needs_review", "deleting"];

export function reconcileMailboxes(local: LocalMailboxForSync[], remote: RemoteMailboxForSync[], totalAllowance: number): Discrepancy[] {
  const out: Discrepancy[] = [];
  const norm = (a: string) => a.trim().toLowerCase();

  const remoteByAddress = new Map<string, RemoteMailboxForSync[]>();
  for (const r of remote) {
    const key = norm(r.address);
    remoteByAddress.set(key, [...(remoteByAddress.get(key) ?? []), r]);
  }
  for (const [address, rows] of remoteByAddress) {
    if (rows.length > 1) {
      out.push({ type: "duplicate_at_provider", address, mailboxId: null, providerMailboxId: rows.map((r) => r.providerMailboxId).join(", "), detail: `${rows.length} provider mailboxes share this address.` });
    }
  }

  const remoteById = new Map(remote.map((r) => [r.providerMailboxId, r]));
  const matchedRemote = new Set<string>();

  for (const m of local) {
    const address = norm(m.address);
    const byId = m.providerMailboxId ? remoteById.get(m.providerMailboxId) : undefined;
    const byAddress = remoteByAddress.get(address)?.[0];
    const match = byId ?? byAddress;
    if (match) matchedRemote.add(match.providerMailboxId);

    if (m.status === "active" || m.status === "deleting") {
      if (!match) {
        out.push({ type: "local_only", address, mailboxId: m.id, providerMailboxId: m.providerMailboxId, detail: "Marked active locally but not found at the provider." });
        continue;
      }
      if (m.providerMailboxId && match.providerMailboxId !== m.providerMailboxId) {
        out.push({ type: "provider_id_mismatch", address, mailboxId: m.id, providerMailboxId: match.providerMailboxId, detail: `Local provider id ${m.providerMailboxId} differs from the provider's ${match.providerMailboxId}.` });
      }
      if (m.status === "active" && match.status === "suspended") {
        out.push({ type: "status_mismatch", address, mailboxId: m.id, providerMailboxId: match.providerMailboxId, detail: "Active locally, suspended at the provider." });
      }
    } else if (m.status === "needs_review") {
      out.push(
        match
          ? { type: "review_exists", address, mailboxId: m.id, providerMailboxId: match.providerMailboxId, detail: "Needs review; the provider has this mailbox." }
          : { type: "review_absent", address, mailboxId: m.id, providerMailboxId: null, detail: "Needs review; the provider does not have this mailbox." }
      );
    } else if (m.status === "failed" && match) {
      out.push({ type: "failed_but_exists", address, mailboxId: m.id, providerMailboxId: match.providerMailboxId, detail: "Marked failed locally but the provider has it." });
    }
  }

  const liveLocalAddresses = new Set(local.filter((m) => LIVE_LOCAL.includes(m.status) || m.status === "failed").map((m) => norm(m.address)));
  for (const r of remote) {
    if (matchedRemote.has(r.providerMailboxId)) continue;
    if (liveLocalAddresses.has(norm(r.address))) continue;
    out.push({ type: "provider_only", address: norm(r.address), mailboxId: null, providerMailboxId: r.providerMailboxId, detail: "Exists at the provider with no live local record." });
  }

  if (remote.length > totalAllowance) {
    out.push({ type: "over_allowance", address: null, mailboxId: null, providerMailboxId: null, detail: `The provider reports ${remote.length} mailboxes; the allowance is ${totalAllowance}.` });
  }
  return out;
}
