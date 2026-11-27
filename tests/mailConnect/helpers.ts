// Fixture for the Webmail Connect tests. Builds on the mailbox-owner
// fixture (../mailClient/helpers.ts): client_a hosts mailbox A, client_b
// hosts mailbox B, and S (sales@altasme.com) is an Altaventures staff
// mailbox that is NOT client-hosted. On top of that: an integration for
// client_a (created through the real staff function, so its secret is a
// real one whose hash is stored) and one for client_b.

import { createMailConnectSessionCookie } from "../../functions/_lib/mailConnect/session";
import { createIntegration } from "../../functions/_lib/mailConnect/integrations";
import { cookiePair, seedMail, STAFF_ID } from "../mailClient/helpers";

export { A, B, S, SECRET, STAFF_ID, call, clientCookieFor, cookiePair, installHtmlRewriterStub, staffCookie } from "../mailClient/helpers";

export async function seedConnect() {
  const base = seedMail();
  const a = await createIntegration(base.db, { clientId: "client_a", name: "Acme Admin Panel", staffId: STAFF_ID });
  const b = await createIntegration(base.db, { clientId: "client_b", name: "Beta Admin Panel", staffId: STAFF_ID });
  if (!a.ok || !b.ok) throw new Error("fixture: integration not created");
  return {
    ...base,
    intA: { id: a.value.integration.id, secret: a.value.secret },
    intB: { id: b.value.integration.id, secret: b.value.secret },
  };
}

export type ConnectFixture = Awaited<ReturnType<typeof seedConnect>>;

/** Inserts a grant row directly (the admin API is tested separately). */
export function grant(
  f: ConnectFixture,
  integrationId: string,
  externalUserId: string,
  mailAccountId: string,
  perms: { read?: boolean; send?: boolean; delete?: boolean; settings?: boolean; isDefault?: boolean } = {}
) {
  const now = new Date().toISOString();
  f.db.raw
    .prepare(
      `INSERT INTO mail_external_mailbox_access (id, integration_id, external_user_id, mail_account_id, can_read, can_send, can_delete, can_manage_settings, is_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      crypto.randomUUID(),
      integrationId,
      externalUserId,
      mailAccountId,
      perms.read === false ? 0 : 1,
      perms.send ? 1 : 0,
      perms.delete ? 1 : 0,
      perms.settings ? 1 : 0,
      perms.isDefault ? 1 : 0,
      now,
      now
    );
}

/** Staff-attaches a mailbox to an integration (the allowlist). */
export function attach(f: ConnectFixture, integrationId: string, mailAccountId: string) {
  f.db.raw.prepare(`INSERT INTO mail_client_integration_mailboxes (integration_id, mail_account_id, created_at) VALUES (?, ?, ?)`).run(integrationId, mailAccountId, new Date().toISOString());
}

/** A launch-code row so /me can resolve a return URL. Returns its id. */
export function launchRow(f: ConnectFixture, integrationId: string, externalUserId: string, returnUrl: string | null = null) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  f.db.raw
    .prepare(`INSERT INTO mail_launch_codes (id, integration_id, external_user_id, return_url, code, status, expires_at, used_at, created_at) VALUES (?, ?, ?, ?, ?, 'used', ?, ?, ?)`)
    .run(id, integrationId, externalUserId, returnUrl, `${id}.${"0".repeat(64)}`, now, now, now);
  return id;
}

export async function connectCookie(integrationId: string, externalUserId: string, launchId = crypto.randomUUID(), secret = "test-session-secret-0123456789abcdef"): Promise<string> {
  return cookiePair(await createMailConnectSessionCookie(secret, { integrationId, externalUserId, launchId }));
}

export const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });
