import { newDb } from "./d1Shim";
import { addDomain, assignPlan, type ServiceRow } from "../../functions/_lib/emailServices/engine";
import { createService } from "../../functions/_lib/emailServices/services";
import type { Actor } from "../../functions/_lib/emailServices/logs";
import type { EmailHostingProvider, ProviderError, ProviderMailbox, ProviderResult } from "../../functions/_lib/emailServices/provider";

export const STAFF: Actor = { type: "staff", id: "user_admin" };

export async function seed(opts: { planId?: string | null; domain?: string | null } = {}) {
  const db = newDb();
  const now = new Date().toISOString();
  db.raw.prepare(`INSERT INTO users (id, email, full_name, role, created_at) VALUES ('user_admin', 'admin@altasme.com', 'Admin', 'owner', ?)`).run(now);
  db.raw
    .prepare(`INSERT INTO clients (id, email, full_name, business_name, created_at, updated_at) VALUES ('client_1', 'owner@acme.ph', 'Ana Cruz', 'Acme PH', ?, ?)`)
    .run(now, now);
  const created = await createService(db, {
    clientId: "client_1",
    planId: opts.planId === undefined ? "team" : opts.planId,
    domain: opts.domain === undefined ? "acme.ph" : opts.domain,
    internalNotes: null,
    providerServiceId: null,
    actor: STAFF,
  });
  if (!created.ok) throw new Error(created.error);
  const domain = db.raw.prepare(`SELECT id FROM email_domains WHERE service_id = ?`).get(created.value.serviceId) as { id: string } | undefined;
  return { db, serviceId: created.value.serviceId, domainId: domain?.id ?? "" };
}

export function serviceRow(db: ReturnType<typeof newDb>, id: string): ServiceRow {
  return { ...(db.raw.prepare(`SELECT * FROM email_services WHERE id = ?`).get(id) as object) } as ServiceRow;
}

export function mailboxStatuses(db: ReturnType<typeof newDb>, serviceId: string): string[] {
  return (db.raw.prepare(`SELECT status FROM email_mailboxes WHERE service_id = ? ORDER BY created_at, address`).all(serviceId) as { status: string }[]).map((r) => r.status);
}

export { addDomain, assignPlan };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Test-only provider whose behavior each test scripts.
export class FakeProvider implements EmailHostingProvider {
  readonly name = "zcom" as const;
  createCalls = 0;
  deleteCalls = 0;
  remote: ProviderMailbox[] = [];
  createBehavior: "ok" | ProviderError | "throw" | "hang" = "ok";
  deleteBehavior: "ok" | ProviderError = "ok";
  delayMs = 5;

  status() {
    return { configured: true, displayName: "Fake", message: "test" };
  }
  private nope<T>(): Promise<ProviderResult<T>> {
    return Promise.resolve({ ok: false, error: { code: "not_supported", message: "fake", outcome: "not_performed", retryable: false } });
  }
  async createMailbox(input: { address: string }): Promise<ProviderResult<ProviderMailbox>> {
    this.createCalls++;
    await sleep(this.delayMs);
    if (this.createBehavior === "throw") throw new Error("socket hang up");
    if (this.createBehavior === "hang") return new Promise(() => {});
    if (this.createBehavior !== "ok") return { ok: false, error: this.createBehavior };
    const mb: ProviderMailbox = { providerServiceId: "zsvc-1", providerMailboxId: `zmail-${this.createCalls}`, address: input.address, status: "active", storageUsedMb: 0, storageQuotaMb: null };
    this.remote.push(mb);
    return { ok: true, value: mb };
  }
  async deleteMailbox(ref: { address: string }): Promise<ProviderResult<{ deleted: true }>> {
    this.deleteCalls++;
    await sleep(this.delayMs);
    if (this.deleteBehavior !== "ok") return { ok: false, error: this.deleteBehavior };
    this.remote = this.remote.filter((r) => r.address !== ref.address);
    return { ok: true, value: { deleted: true } };
  }
  async listMailboxes(): Promise<ProviderResult<ProviderMailbox[]>> {
    return { ok: true, value: [...this.remote] };
  }
  listDomains() {
    return this.nope<never>();
  }
  getMailboxDetails() {
    return this.nope<never>();
  }
  changeMailboxPassword() {
    return this.nope<never>();
  }
  configureForwarding() {
    return this.nope<never>();
  }
  getServiceDetails() {
    return this.nope<never>();
  }
  getUsage() {
    return this.nope<never>();
  }
  listMessages() {
    return this.nope<never>();
  }
  getMessageDetails() {
    return this.nope<never>();
  }
  getAttachment() {
    return this.nope<never>();
  }
}

export const PASSWORD = "Sup3rSecretPass";
