// Fixture for the mailbox-owner ("client mail") tests: two client-hosted
// mailboxes (A, B) on active Email Services, one Altaventures staff mailbox
// (S) that has an SMTP profile but is NOT client-hosted, a staff user with
// access to S and A, and mail (with attachments) in each. Runs the real
// SQL against the real fixture schema (FKs ON) via the shared D1 shim.

import { newDb } from "../emailServices/d1Shim";
import { createMailClientSessionCookie } from "../../functions/_lib/mailClient/session";
import { createSessionCookie } from "../../functions/_lib/session";
import type { MailClientEnv } from "../../functions/_lib/mailClient/handler";

export const SECRET = "test-session-secret-0123456789abcdef";
export const STAFF_ID = "user_staff_owner";
export const A = { id: "acct-a", email: "ana@acme.ph", profile: "client-a", password: "ana-real-pw" };
export const B = { id: "acct-b", email: "ben@beta.ph", profile: "client-b", password: "ben-real-pw" };
export const S = { id: "acct-s", email: "sales@altasme.com", profile: "staff-sales", password: "shared-sales-pw" };

// sanitize.ts uses the Workers-native HTMLRewriter, which Node doesn't have.
// These tests are about scoping, not sanitization (covered in workerd, see
// CLAUDE.md §32.6), so a pass-through stub is installed.
export function installHtmlRewriterStub() {
  const g = globalThis as unknown as { HTMLRewriter?: unknown };
  if (g.HTMLRewriter) return;
  g.HTMLRewriter = class {
    on() {
      return this;
    }
    onDocument() {
      return this;
    }
    transform(res: Response) {
      return res;
    }
  };
}

export function fakeBucket(objects: Record<string, string>): R2Bucket {
  return {
    async get(key: string) {
      const v = objects[key];
      if (v === undefined) return null;
      const bytes = new TextEncoder().encode(v);
      return { body: new Blob([bytes]).stream(), size: bytes.length, arrayBuffer: async () => bytes.buffer };
    },
  } as unknown as R2Bucket;
}

export type Db = ReturnType<typeof newDb>;

function insertMessage(db: Db, m: { id: string; account: string; thread: string; folder: string; subject: string; body: string; from: string; direction?: string }) {
  const now = new Date().toISOString();
  db.raw
    .prepare(
      `INSERT INTO mail_messages (id, account_id, thread_id, direction, folder, status, dedupe_key, from_email, subject, body_text, body_html, snippet, received_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'received', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(m.id, m.account, m.thread, m.direction ?? "inbound", m.folder, `dk-${m.id}`, m.from, m.subject, m.body, `<p>${m.body}</p>`, m.body.slice(0, 50), now, now, now);
  db.raw
    .prepare(`INSERT INTO mail_messages_fts (message_id, account_id, sender, recipients, subject, body, attachments) VALUES (?, ?, ?, '', ?, ?, '')`)
    .run(m.id, m.account, m.from, m.subject, m.body);
}

export function seedMail() {
  const db = newDb();
  const now = new Date().toISOString();
  const run = (sql: string, ...args: (string | number | null)[]) => db.raw.prepare(sql).run(...args);
  // mail_settings isn't in the fixture; copied from clienthub's schema so policy overrides can be tested.
  db.raw.exec(`CREATE TABLE IF NOT EXISTS mail_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_by TEXT REFERENCES users(id), updated_at TEXT NOT NULL)`);

  run(`INSERT INTO users (id, email, full_name, role, created_at) VALUES (?, 'owner@altasme.com', 'Owner', 'owner', ?)`, STAFF_ID, now);
  for (const [client, svc, dom, domain] of [
    ["client_a", "svc-a", "dom-a", "acme.ph"],
    ["client_b", "svc-b", "dom-b", "beta.ph"],
  ] as const) {
    run(`INSERT INTO clients (id, email, full_name, business_name, created_at, updated_at) VALUES (?, ?, 'X', 'X', ?, ?)`, client, `${client}@x.test`, now, now);
    run(`INSERT INTO email_services (id, client_id, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`, svc, client, now, now);
    run(`INSERT INTO email_domains (id, service_id, domain, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`, dom, svc, domain, now, now);
  }
  for (const acct of [A, B, S]) {
    run(
      `INSERT INTO mail_accounts (id, email_address, display_name, smtp_profile, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      acct.id,
      acct.email,
      acct.email.split("@")[0]!,
      acct.profile,
      now,
      now
    );
  }
  run(`INSERT INTO email_mailboxes (id, service_id, domain_id, local_part, address, status, mail_account_id, created_at, updated_at) VALUES ('mb-a', 'svc-a', 'dom-a', 'ana', ?, 'active', ?, ?, ?)`, A.email, A.id, now, now);
  run(`INSERT INTO email_mailboxes (id, service_id, domain_id, local_part, address, status, mail_account_id, created_at, updated_at) VALUES ('mb-b', 'svc-b', 'dom-b', 'ben', ?, 'active', ?, ?, ?)`, B.email, B.id, now, now);
  // Staff access: the shared sales mailbox, plus A (as fulfillment grants it, CLAUDE.md §35).
  run(`INSERT INTO mail_account_access (account_id, user_id, can_send, created_at) VALUES (?, ?, 1, ?)`, S.id, STAFF_ID, now);
  run(`INSERT INTO mail_account_access (account_id, user_id, can_send, created_at) VALUES (?, ?, 1, ?)`, A.id, STAFF_ID, now);

  for (const [thread, account, subject] of [
    ["thr-a", A.id, "Hello Ana"],
    ["thr-b", B.id, "Ben's private invoice"],
    ["thr-s", S.id, "Internal sales pipeline"],
  ] as const) {
    run(`INSERT INTO mail_threads (id, account_id, subject, message_count, latest_message_at, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)`, thread, account, subject, now, now, now);
  }
  insertMessage(db, { id: "msg-a", account: A.id, thread: "thr-a", folder: "inbox", subject: "Hello Ana", body: "welcome aboard", from: "friend@example.com" });
  insertMessage(db, { id: "msg-b", account: B.id, thread: "thr-b", folder: "inbox", subject: "Ben's private invoice", body: "zebrapassphrase invoice details", from: "billing@example.com" });
  insertMessage(db, { id: "msg-s", account: S.id, thread: "thr-s", folder: "inbox", subject: "Internal sales pipeline", body: "zebrapassphrase staff only", from: "boss@altasme.com" });

  const att = (id: string, account: string, message: string | null, draft: string | null, key: string) =>
    run(
      `INSERT INTO mail_attachments (id, account_id, message_id, draft_id, filename, mime_type, size_bytes, storage_key, storage_status, created_at) VALUES (?, ?, ?, ?, ?, 'text/plain', 5, ?, 'stored', ?)`,
      id,
      account,
      message,
      draft,
      `${id}.txt`,
      key,
      now
    );
  att("att-a", A.id, "msg-a", null, "k/att-a");
  att("att-b", B.id, "msg-b", null, "k/att-b");
  // A staff member's draft IN mailbox A, with an attachment: a mailbox owner
  // of A must still not see it (drafts are private to their staff author).
  run(
    `INSERT INTO mail_drafts (id, account_id, compose_mode, to_json, cc_json, bcc_json, subject, body_html, body_text, version, created_by, created_at, updated_at) VALUES ('draft-staff', ?, 'new', '[]', '[]', '[]', 'staff draft', '', '', 1, ?, ?, ?)`,
    A.id,
    STAFF_ID,
    now,
    now
  );
  att("att-draft", A.id, null, "draft-staff", "k/att-draft");

  const profiles = {
    [A.profile]: { host: "smtp.acme.test", port: 465, username: A.email, password: "outbound-a" },
    [B.profile]: { host: "smtp.beta.test", port: 465, username: B.email, password: "outbound-b" },
    [S.profile]: { host: "smtp.altasme.test", port: 465, username: S.email, password: "outbound-s" },
  };
  const env: MailClientEnv = {
    DB: db,
    SESSION_SECRET: SECRET,
    MAIL_SMTP_PROFILES_JSON: JSON.stringify(profiles),
    MAIL_ATTACHMENTS: fakeBucket({ "k/att-a": "AAAAA", "k/att-b": "BBBBB", "k/att-draft": "DDDDD" }),
  };
  return { db, env, profiles };
}

/** The "name=value" pair from a Set-Cookie string. */
export function cookiePair(setCookie: string): string {
  return setCookie.split(";")[0]!;
}

export async function clientCookieFor(acct: { id: string; email: string }, secret = SECRET): Promise<string> {
  return cookiePair(await createMailClientSessionCookie(secret, { mailAccountId: acct.id, emailAddress: acct.email }));
}

export async function staffCookie(secret = SECRET): Promise<string> {
  return cookiePair(await createSessionCookie(secret, { workosUserId: STAFF_ID, issuedAt: Date.now() }));
}

export interface CtxInit {
  method?: string;
  cookie?: string;
  body?: unknown;
  params?: Record<string, string>;
  headers?: Record<string, string>;
  contentType?: string | null;
}

/** A Pages Functions EventContext stand-in. `nextCalled` reports whether a middleware let the request through. */
export function makeCtx(env: MailClientEnv, url: string, init: CtxInit = {}) {
  const method = init.method ?? "GET";
  const headers = new Headers(init.headers ?? {});
  if (init.cookie) headers.set("Cookie", init.cookie);
  let body: string | undefined;
  if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    if (init.contentType !== null) headers.set("content-type", init.contentType ?? "application/json");
  }
  const state = { nextCalled: false };
  const ctx = {
    request: new Request(`https://mail.altasme.com${url}`, { method, headers, body }),
    env,
    params: init.params ?? {},
    data: {} as Record<string, unknown>,
    next: async () => {
      state.nextCalled = true;
      return new Response("reached the route", { status: 200 });
    },
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    functionPath: url,
  };
  return { ctx: ctx as unknown as EventContext<MailClientEnv, string, Record<string, unknown>>, state };
}

export async function call(fn: unknown, env: MailClientEnv, url: string, init: CtxInit = {}) {
  const { ctx, state } = makeCtx(env, url, init);
  const res = await (fn as (c: unknown) => Promise<Response>)(ctx);
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { res, status: res.status, text, json, state, data: ctx.data };
}
