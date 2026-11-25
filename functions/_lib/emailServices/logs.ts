// Audit and provisioning log writers. These return prepared statements so
// callers can include them in the same db.batch() as the change they
// describe (the audit row and the change commit or fail together).

import type { ProviderError } from "./provider";

export interface Actor {
  type: "staff" | "client" | "system";
  id: string | null;
}

export function auditStatement(
  db: D1Database,
  entry: { serviceId: string; mailboxId?: string | null; actor: Actor; action: string; before?: unknown; after?: unknown; reason?: string | null; now: string }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO email_audit_logs (id, service_id, mailbox_id, actor_type, actor_id, action, before_json, after_json, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      crypto.randomUUID(),
      entry.serviceId,
      entry.mailboxId ?? null,
      entry.actor.type,
      entry.actor.id,
      entry.action,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
      entry.reason ?? null,
      entry.now
    );
}

export function provisioningLogStatement(
  db: D1Database,
  entry: {
    serviceId: string;
    mailboxId?: string | null;
    provider: string;
    operation: string;
    error: ProviderError | null; // null = succeeded
    durationMs?: number | null;
    details?: unknown;
    actor: Actor;
    now: string;
  }
): D1PreparedStatement {
  const outcome = entry.error === null ? "succeeded" : entry.error.outcome === "unknown" ? "unknown" : "failed";
  return db
    .prepare(
      `INSERT INTO email_provisioning_logs (id, service_id, mailbox_id, provider, operation, outcome, error_code, error_message, retryable, duration_ms, details_json, actor_type, actor_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      crypto.randomUUID(),
      entry.serviceId,
      entry.mailboxId ?? null,
      entry.provider,
      entry.operation,
      outcome,
      entry.error?.code ?? null,
      entry.error?.message?.slice(0, 500) ?? null,
      entry.error?.retryable ? 1 : 0,
      entry.durationMs ?? null,
      entry.details === undefined ? null : JSON.stringify(entry.details),
      entry.actor.type,
      entry.actor.id,
      entry.now
    );
}

// Keeps the client's own timeline (client_activity, shown on ClientKeeper's
// client detail page) aware of major email-service events.
export function clientActivityStatement(db: D1Database, clientId: string, type: string, description: string, actorId: string | null, now: string): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO client_activity (id, client_id, type, description, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), clientId, type, description, actorId, now);
}
