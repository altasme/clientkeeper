// Mailbox audit trail (mail_events). Best-effort by design: an audit write
// failing must never turn a successful user action into an error response.

export async function logMailEvent(
  db: D1Database,
  e: { accountId?: string | null; messageId?: string | null; type: string; data?: unknown; actorId: string | null }
): Promise<void> {
  try {
    await db
      .prepare(`INSERT INTO mail_events (id, account_id, message_id, event_type, event_data, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        crypto.randomUUID(),
        e.accountId ?? null,
        e.messageId ?? null,
        e.type,
        e.data === undefined ? null : JSON.stringify(e.data).slice(0, 4000),
        e.actorId,
        new Date().toISOString()
      )
      .run();
  } catch (err) {
    console.error("mail_events write failed", err instanceof Error ? err.message : err);
  }
}

export function mailEventStatement(
  db: D1Database,
  e: { accountId?: string | null; messageId?: string | null; type: string; data?: unknown; actorId: string | null }
): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO mail_events (id, account_id, message_id, event_type, event_data, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      crypto.randomUUID(),
      e.accountId ?? null,
      e.messageId ?? null,
      e.type,
      e.data === undefined ? null : JSON.stringify(e.data).slice(0, 4000),
      e.actorId,
      new Date().toISOString()
    );
}
