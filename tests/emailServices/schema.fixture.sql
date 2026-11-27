-- TEST FIXTURE ONLY. The canonical schema is clienthub/d1/schema.sql.
-- This file is the minimal set of tables the email-services engine tests
-- need: the tables it references (copied verbatim) plus the whole
-- "Email Services" block, copied verbatim from the end of that file.
-- tests/emailServices/schema-drift.test.ts fails if the block below no
-- longer matches clienthub's copy (when a clienthub checkout is next to
-- this repo), so update both together.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,               -- WorkOS user id
  email TEXT NOT NULL,
  full_name TEXT,
  role TEXT NOT NULL CHECK (role IN ('owner', 'developer', 'admin', 'sales')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  workos_user_id TEXT UNIQUE,        -- NULL until invitation accepted
  email TEXT NOT NULL,
  full_name TEXT NOT NULL,
  business_name TEXT NOT NULL,
  mobile TEXT,
  facebook TEXT,
  current_website TEXT,
  -- Invitation bookkeeping, so a paid-but-no-account client is never
  -- invisible (CLAUDE.md §4's "Paid, no account yet" list + re-issue).
  workos_invitation_id TEXT,
  invitation_status TEXT NOT NULL DEFAULT 'pending' CHECK (invitation_status IN ('pending', 'accepted', 'expired', 'revoked')),
  -- NULL until the client dismisses the first-login welcome modal
  -- (functions/api/client/welcome-dismiss.ts); non-NULL means never show
  -- it again. A fresh CREATE TABLE picks this up automatically, but the
  -- live database needs a manual migration — see CLAUDE.md's note on this
  -- column for the exact ALTER TABLE statement, since this file's
  -- CREATE TABLE IF NOT EXISTS is a no-op against an existing table.
  welcome_dismissed_at TEXT,
  -- Staff-set record-keeping fields (ClientKeeper's Client Detail page,
  -- "YYYY-MM-DD"), not derived from any billing/renewal logic: an admin
  -- types these in directly so domain/plan renewal dates can be tracked
  -- even for clients with no subscriptions row (a comp, a legacy client,
  -- the new no-op "free"/"299" catalog entries) or whose real domain
  -- registrar/renewal date doesn't match subscriptions.next_renewal_date's
  -- auto-computed billing-cycle math. NULL means not tracked yet.
  --
  -- domain_registered_at is the date the domain was actually registered
  -- (renamed from an earlier, briefly-drafted domain_expires_at that was
  -- never deployed — see clientkeeper's CLAUDE.md §19/§20). Expiration is
  -- NOT a stored column: it's always computed as registration + 1 year,
  -- everywhere it's shown (ClientKeeper's UI, the renewal reminder email),
  -- so there is exactly one source of truth for that date and no risk of
  -- the two drifting apart if a registration date is corrected later.
  --
  -- Same live-database migration caveat as welcome_dismissed_at above —
  -- see clientkeeper's CLAUDE.md for the exact ALTER TABLE statements.
  domain_registered_at TEXT,
  plan_renewal_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS client_activity (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  type TEXT NOT NULL,
  description TEXT NOT NULL,
  actor_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  before TEXT,                        -- JSON
  after TEXT,                         -- JSON
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mail_accounts (
  id TEXT PRIMARY KEY,
  email_address TEXT NOT NULL UNIQUE,        -- stored lowercased
  display_name TEXT NOT NULL,
  reply_to TEXT,                             -- optional Reply-To header for mail sent from this identity
  smtp_profile TEXT,
  inbound_enabled INTEGER NOT NULL DEFAULT 1, -- 0 = the mail worker rejects mail to this address
  outbound_enabled INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Webmail tables the manual-fulfillment bridge (mail_account_access) and
-- the Z.com poll sync (mail-worker/src/zcomPollSync.ts, through
-- @altasme/webmail-kit's processInbound) write. Copied verbatim.

-- Explicit per-staff mailbox access. can_send = 0 is read-only access
-- (the identity never appears in that person's composer From list).
CREATE TABLE IF NOT EXISTS mail_account_access (
  account_id TEXT NOT NULL REFERENCES mail_accounts(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  can_send INTEGER NOT NULL DEFAULT 1,
  granted_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_mail_account_access_user_id ON mail_account_access(user_id);

-- Per-identity signatures. use_for_new/use_for_reply pick which one the
-- composer inserts automatically (at most one of each per account,
-- enforced in application code); an account with no use_for_reply
-- signature simply inserts none on replies ("disable signature on reply").
CREATE TABLE IF NOT EXISTS mail_signatures (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES mail_accounts(id),
  name TEXT NOT NULL,
  body_html TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '',
  use_for_new INTEGER NOT NULL DEFAULT 0,
  use_for_reply INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mail_signatures_account_id ON mail_signatures(account_id);

-- A conversation. Thread membership is resolved from standard headers
-- (Message-ID / In-Reply-To / References), never from subject alone.
-- participants is a JSON string[] of lowercased addresses.
CREATE TABLE IF NOT EXISTS mail_threads (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES mail_accounts(id),
  subject TEXT NOT NULL DEFAULT '',
  participants TEXT NOT NULL DEFAULT '[]',
  message_count INTEGER NOT NULL DEFAULT 0,
  latest_message_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mail_threads_account_latest ON mail_threads(account_id, latest_message_at);

-- One row per real email (inbound or outbound). Drafts are NOT here --
-- they live in mail_drafts until sent. `folder` is persistent server
-- state (inbox/sent/archive/junk/trash); previous_folder remembers where a
-- message was before Junk/Trash so Restore puts it back. `status` tracks
-- the outbound lifecycle honestly: 'sent' means the SMTP server accepted
-- it (250 after DATA), never "delivered". dedupe_key makes inbound
-- processing idempotent per mailbox: normalized Message-ID when present,
-- otherwise a SHA-256 over sender/date/subject/body (see the mail
-- worker's computeDedupeKey()).
CREATE TABLE IF NOT EXISTS mail_messages (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES mail_accounts(id),
  thread_id TEXT NOT NULL REFERENCES mail_threads(id),
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  folder TEXT NOT NULL CHECK (folder IN ('inbox', 'sent', 'archive', 'junk', 'trash')),
  previous_folder TEXT,
  status TEXT NOT NULL CHECK (status IN ('received', 'queued', 'sending', 'sent', 'failed', 'retry_scheduled')),
  message_id_header TEXT,                    -- as sent/received, with angle brackets
  message_id_normalized TEXT,                -- lowercased, no brackets; lookup key for threading
  in_reply_to TEXT,
  references_header TEXT,
  dedupe_key TEXT NOT NULL,
  from_name TEXT,
  from_email TEXT NOT NULL,
  reply_to TEXT,
  subject TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '',
  body_html TEXT NOT NULL DEFAULT '',        -- untrusted for inbound; only ever rendered after server-side sanitization
  snippet TEXT NOT NULL DEFAULT '',
  is_read INTEGER NOT NULL DEFAULT 0,
  is_starred INTEGER NOT NULL DEFAULT 0,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  raw_storage_key TEXT,                      -- R2 key of the original .eml (inbound) when stored
  auth_results TEXT,                         -- raw Authentication-Results header, display only
  trashed_at TEXT,
  received_at TEXT,
  sent_at TEXT,
  created_by TEXT REFERENCES users(id),     -- staff sender for outbound; NULL for inbound
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (account_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_mail_messages_account_folder ON mail_messages(account_id, folder, created_at);
CREATE INDEX IF NOT EXISTS idx_mail_messages_thread_id ON mail_messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_mail_messages_msgid ON mail_messages(account_id, message_id_normalized);
CREATE INDEX IF NOT EXISTS idx_mail_messages_starred ON mail_messages(account_id, is_starred);

CREATE TABLE IF NOT EXISTS mail_recipients (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES mail_messages(id),
  recipient_type TEXT NOT NULL CHECK (recipient_type IN ('to', 'cc', 'bcc')),
  display_name TEXT,
  email TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_mail_recipients_message_id ON mail_recipients(message_id);
CREATE INDEX IF NOT EXISTS idx_mail_recipients_email ON mail_recipients(email);

-- Unsent work. to/cc/bcc are JSON arrays of {name, email}. `version` is
-- an optimistic-concurrency counter so a stale autosave from a second
-- tab can't silently overwrite newer content (PATCH with an old version
-- -> 409). compose_mode/source_message_id remember what a reply/forward
-- draft is attached to so threading headers survive a page refresh.
CREATE TABLE IF NOT EXISTS mail_drafts (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES mail_accounts(id),
  thread_id TEXT REFERENCES mail_threads(id),
  compose_mode TEXT NOT NULL DEFAULT 'new' CHECK (compose_mode IN ('new', 'reply', 'reply_all', 'forward')),
  source_message_id TEXT REFERENCES mail_messages(id),
  to_json TEXT NOT NULL DEFAULT '[]',
  cc_json TEXT NOT NULL DEFAULT '[]',
  bcc_json TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL DEFAULT '',
  body_html TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mail_drafts_account_id ON mail_drafts(account_id, updated_at);

-- Attachment metadata; bytes live in R2 under storage_key. A row belongs
-- to a message (received/sent) or a draft (still being composed), never
-- both. Forwarding re-references the same storage_key in a new row, so
-- R2 objects are only deleted once no row references them any more.
-- storage_status = 'failed' records an inbound attachment whose R2 write
-- failed -- the message itself is still stored (never discarded) and the
-- original bytes remain recoverable from the raw .eml copy.
CREATE TABLE IF NOT EXISTS mail_attachments (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES mail_accounts(id),
  message_id TEXT REFERENCES mail_messages(id),
  draft_id TEXT REFERENCES mail_drafts(id),
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  storage_key TEXT NOT NULL,
  content_id TEXT,                           -- for cid: inline images
  is_inline INTEGER NOT NULL DEFAULT 0,
  storage_status TEXT NOT NULL DEFAULT 'stored' CHECK (storage_status IN ('stored', 'failed')),
  uploaded_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mail_attachments_message_id ON mail_attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_mail_attachments_draft_id ON mail_attachments(draft_id);
CREATE INDEX IF NOT EXISTS idx_mail_attachments_storage_key ON mail_attachments(storage_key);

CREATE TABLE IF NOT EXISTS mail_labels (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES mail_accounts(id),
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#0D68EF',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (account_id, name)
);

CREATE TABLE IF NOT EXISTS mail_message_labels (
  message_id TEXT NOT NULL REFERENCES mail_messages(id),
  label_id TEXT NOT NULL REFERENCES mail_labels(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (message_id, label_id)
);
CREATE INDEX IF NOT EXISTS idx_mail_message_labels_label_id ON mail_message_labels(label_id);

-- The outbound send pipeline. A job is created in the SAME D1 batch as
-- its mail_messages row, before any SMTP traffic, so an email can never
-- be sent without a record of it. idempotency_key (client-supplied per
-- compose session) makes a double-click / retried request return the
-- existing job instead of sending twice. locked_until is a lease: a job
-- found still 'sending' after its lease expired (a crash mid-SMTP) is
-- marked failed with an "outcome unknown" error rather than auto-resent,
-- because the server may already have accepted it -- a human decides.
CREATE TABLE IF NOT EXISTS mail_send_jobs (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE REFERENCES mail_messages(id),
  account_id TEXT NOT NULL REFERENCES mail_accounts(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'retry_scheduled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  next_retry_at TEXT,
  locked_until TEXT,
  last_error TEXT,                           -- redacted, human-readable; never an SMTP transcript
  last_attempted_at TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mail_send_jobs_due ON mail_send_jobs(status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_mail_send_jobs_created_by ON mail_send_jobs(created_by, created_at);

CREATE TABLE IF NOT EXISTS mail_send_attempts (
  id TEXT PRIMARY KEY,
  send_job_id TEXT NOT NULL REFERENCES mail_send_jobs(id),
  attempt_number INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted', 'transient_failure', 'permanent_failure', 'unknown')),
  smtp_code INTEGER,
  error TEXT,
  attempted_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mail_send_attempts_job_id ON mail_send_attempts(send_job_id);

-- Mailbox audit trail (moves, label changes, sends, deletions, settings
-- and access changes). message_id deliberately has no REFERENCES so the
-- trail survives a permanent delete of the message it describes.
CREATE TABLE IF NOT EXISTS mail_events (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  message_id TEXT,
  event_type TEXT NOT NULL,
  event_data TEXT,                           -- JSON
  actor_id TEXT,                             -- users.id, or 'mail-worker' for inbound processing
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mail_events_account_id ON mail_events(account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_mail_events_message_id ON mail_events(message_id);

-- Inbound mail the worker could not fully process. The raw message is
-- kept in R2 (raw_storage_key) so nothing is ever lost; resolved_at is
-- set once a human has dealt with it.
CREATE TABLE IF NOT EXISTS mail_inbound_failures (
  id TEXT PRIMARY KEY,
  envelope_from TEXT,
  envelope_to TEXT,
  raw_storage_key TEXT,
  error TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

-- Full-text search index (SQLite FTS5, which D1 supports). Maintained by
-- application code on insert/delete, not triggers, so both writers (the
-- Pages Functions and the mail worker) control exactly what's indexed.
-- message_id/account_id are UNINDEXED join/scoping keys -- every search
-- query also filters by the caller's accessible account ids. The API
-- falls back to LIKE matching if this table is unavailable.
-- Note: `wrangler d1 export` does not export virtual tables; this index
-- can be rebuilt from mail_messages at any time.
CREATE VIRTUAL TABLE IF NOT EXISTS mail_messages_fts USING fts5(
  message_id UNINDEXED,
  account_id UNINDEXED,
  sender,
  recipients,
  subject,
  body,
  attachments,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- =====================================================================
-- Email Services: client email hosting managed from ClientKeeper
-- [2026-11-25]
--
-- A DIFFERENT system from the webmail block above. The webmail tables
-- (mail_*) hold Altaventures' own staff mailboxes on altasme.com, received
-- through Cloudflare Email Routing. The tables below hold email-hosting
-- SUBSCRIPTIONS that Altaventures sells to its clients: a plan, a mailbox
-- allowance, the client's domain(s), and the mailboxes created at a
-- third-party hosting provider (Z.com initially) on the client's behalf.
-- No row here points at a mail_* row and vice versa.
--
-- ClientKeeper is the source of truth and the only writer this round
-- (functions/api/app/email-services/*, staff-only). A later round adds a
-- client-facing "Email Management" module in clienthub that reads these
-- same tables scoped by clients.id and creates mailboxes through the SAME
-- entitlement rules (actor_type = 'client' in the logs below).
--
-- Mailbox passwords are NEVER stored anywhere in this database. A password
-- is passed straight through to the provider and forgotten. Provider API
-- credentials live only in Pages env/secrets, never in a table.
--
-- All brand-new tables: re-running this whole file is safe (IF NOT EXISTS
-- / INSERT OR IGNORE), no ALTER TABLE needed. See the migration note at
-- the end of this block.
-- =====================================================================

-- Centrally managed plan catalog, editable by owner/admin in ClientKeeper.
-- id is a stable slug rather than a random UUID so the seed below is
-- idempotent (INSERT OR IGNORE on a fixed key) and so a plan can be named
-- in support conversations; new plans created from the UI get a random id.
-- Plan values are SNAPSHOTTED onto email_services when a plan is assigned
-- (see below), so editing a plan's price or allowance here never silently
-- changes what an existing customer already has.
-- storage_quota_mb is the figure the operator published per plan, as a
-- plain integer (MB, so any value fits). Z.com sizes quota in 5 GB steps
-- at the mail-service level, which 3/10/30/100 GB don't all match; that is
-- an open business question, so nothing here assumes a multiple of 5 GB
-- and nothing enforces the quota locally. It is display/record data only.
CREATE TABLE IF NOT EXISTS email_plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price_php INTEGER NOT NULL CHECK (price_php >= 0),
  billing_interval TEXT NOT NULL DEFAULT 'annual' CHECK (billing_interval IN ('annual', 'monthly')),
  included_mailboxes INTEGER NOT NULL CHECK (included_mailboxes >= 1),
  storage_quota_mb INTEGER NOT NULL CHECK (storage_quota_mb > 0),
  additional_mailbox_price_php INTEGER NOT NULL CHECK (additional_mailbox_price_php >= 0),
  features_json TEXT NOT NULL DEFAULT '[]',   -- JSON array of display strings
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO email_plans (id, name, price_php, billing_interval, included_mailboxes, storage_quota_mb, additional_mailbox_price_php, features_json, status, sort_order, created_at, updated_at) VALUES
  ('solo',       'Solo',        1500, 'annual',  1,   3072, 250, '["Lite Business Webmail access","Imunify360 security","Virus protection","Spam protection"]', 'active', 10, '2026-11-25T00:00:00.000Z', '2026-11-25T00:00:00.000Z'),
  ('team',       'Team',        1999, 'annual',  3,   3072, 250, '["Lite Business Webmail access","Imunify360 security","Virus protection","Spam protection"]', 'active', 20, '2026-11-25T00:00:00.000Z', '2026-11-25T00:00:00.000Z'),
  ('growth',     'Growth',      4199, 'annual', 10,  10240, 250, '["Lite Business Webmail access","Imunify360 security","Virus protection","Spam protection"]', 'active', 30, '2026-11-25T00:00:00.000Z', '2026-11-25T00:00:00.000Z'),
  ('business',   'Business',    5499, 'annual', 15,  30720, 250, '["Lite Business Webmail access","Imunify360 security","Virus protection","Spam protection"]', 'active', 40, '2026-11-25T00:00:00.000Z', '2026-11-25T00:00:00.000Z'),
  ('enterprise', 'Enterprise', 10999, 'annual', 20, 102400, 250, '["Lite Business Webmail access","Imunify360 security","Virus protection","Spam protection"]', 'active', 50, '2026-11-25T00:00:00.000Z', '2026-11-25T00:00:00.000Z');

-- One email-hosting subscription, always belonging to an existing client
-- (client identity is never duplicated here). A client may hold more than
-- one service (e.g. two unrelated domains billed separately).
--
-- plan_id is NULL while the service is pending setup. The four *_snapshot
-- columns are copied from email_plans at assignment time and are what the
-- entitlement engine actually reads.
--
-- Total mailbox allowance is never stored: it is always computed as
--   included_mailboxes + SUM(email_service_entitlements.quantity)
-- in the same SQL statement that reserves a slot, so it can't drift.
--
-- status is the stored lifecycle state. "Expired" is ALSO enforced by
-- expires_at directly in every provisioning check, so a service whose date
-- has passed is treated as expired even before anything rewrites its
-- status (ClientKeeper sweeps active -> expired on read).
CREATE TABLE IF NOT EXISTS email_services (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  provider TEXT NOT NULL DEFAULT 'zcom' CHECK (provider IN ('zcom')),
  provider_service_id TEXT,
  plan_id TEXT REFERENCES email_plans(id),
  plan_name_snapshot TEXT,
  included_mailboxes INTEGER NOT NULL DEFAULT 0 CHECK (included_mailboxes >= 0),
  storage_quota_mb INTEGER,
  price_php INTEGER,
  additional_mailbox_price_php INTEGER,
  status TEXT NOT NULL DEFAULT 'pending_setup' CHECK (status IN ('pending_setup', 'active', 'suspended', 'expired', 'cancelled', 'provisioning_error')),
  status_reason TEXT,
  starts_at TEXT,
  expires_at TEXT,
  -- Provider-reported data, NULL until a real provider sync has run.
  provider_status TEXT,
  storage_used_mb INTEGER,
  sync_status TEXT NOT NULL DEFAULT 'never' CHECK (sync_status IN ('never', 'ok', 'discrepancies', 'error')),
  last_sync_at TEXT,
  last_sync_error TEXT,
  internal_notes TEXT,
  created_by TEXT REFERENCES users(id),
  decommissioned_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_services_client_id ON email_services(client_id);
CREATE INDEX IF NOT EXISTS idx_email_services_plan_id ON email_services(plan_id);
CREATE INDEX IF NOT EXISTS idx_email_services_status ON email_services(status);

-- Entitlement ledger: purchased additional mailboxes ('addon') and staff
-- overrides ('override'), as signed quantities. Removing allowance is a
-- negative row, never an UPDATE/DELETE, so the history of every change
-- (who, when, why, at what unit price) is kept. The engine refuses any
-- row that would push the allowance below the mailboxes already counted
-- against it, or the add-on total below zero.
CREATE TABLE IF NOT EXISTS email_service_entitlements (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES email_services(id),
  kind TEXT NOT NULL CHECK (kind IN ('addon', 'override')),
  quantity INTEGER NOT NULL CHECK (quantity <> 0),
  unit_price_php INTEGER,                    -- addon price at the time (snapshot); NULL for overrides
  reason TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_service_entitlements_service_id ON email_service_entitlements(service_id);

-- Domains assigned to a service. A domain can be live (status 'active')
-- on at most one service at a time; a removed row is kept for history.
CREATE TABLE IF NOT EXISTS email_domains (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES email_services(id),
  domain TEXT NOT NULL,                      -- stored lowercased, no trailing dot
  provider_domain_id TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  created_by TEXT REFERENCES users(id),
  removed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_domains_service_id ON email_domains(service_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_domains_live_domain ON email_domains(domain) WHERE status = 'active';

-- Mailboxes managed for a service. The row IS the provisioning state
-- machine and the reservation: there is no separate reservations table.
--   reserved      a slot is held; the provider has not been called yet.
--                 reserved_until is a lease: a 'reserved' row past its
--                 lease never reached the provider, so it stops counting
--                 and is swept to 'failed'.
--   provisioning  the provider call is in flight.
--   active        the provider confirmed the mailbox exists. The ONLY
--                 state shown to anyone as a working mailbox.
--   failed        the provider definitely did not create it. Slot released.
--   needs_review  outcome unknown (timeout/crash mid-call): the mailbox may
--                 or may not exist at the provider, so the slot stays held
--                 until a human resolves it (same reasoning as
--                 mail_send_jobs' "outcome unknown" above).
--   deleting      a delete call is in flight; still counts until confirmed.
--   deleted       the provider confirmed deletion. Slot released.
--   discarded     a failed attempt staff dismissed. Kept for history.
-- Counted against the allowance: provisioning, active, needs_review,
-- deleting, and reserved while its lease is live.
--
-- idempotency_key (UNIQUE, NULLs allowed) makes a repeated create request
-- return the existing row instead of reserving a second slot or calling
-- the provider twice. The partial unique index on address means one live
-- record per address at a time (a failed row is retried in place).
-- No password column, by design.
--
-- Webmail bridge (confirmed requirement, NOT built yet): client mailboxes
-- will eventually be read/sent through ClientKeeper's own webmail (the
-- mail_* block above), not the provider's bundled webmail. Room is left
-- for that here; no sync logic exists yet:
--   inbound_source      how new mail for this mailbox will reach our
--                       webmail. Provider-hosted (Z.com) mailboxes need a
--                       polling sync against the provider API (Z.com has no
--                       generic new-mail push); 'cloudflare_email_routing'
--                       is the existing mail-worker path.
--   provider_service_id / provider_mailbox_id
--                       the provider's own opaque ids for this mailbox
--                       (Z.com's service_id and email_id). Plain TEXT, not
--                       assumed to be UUIDs.
--   mail_account_id     the mail_accounts row this mailbox is bridged to,
--                       once the bridge exists (outbound will then use that
--                       row's smtp_profile against the provider's SMTP host,
--                       since Z.com's API has no send endpoint). NULL today.
CREATE TABLE IF NOT EXISTS email_mailboxes (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES email_services(id),
  domain_id TEXT NOT NULL REFERENCES email_domains(id),
  local_part TEXT NOT NULL,
  address TEXT NOT NULL,                     -- local_part@domain, lowercased
  is_primary INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'provisioning', 'active', 'failed', 'needs_review', 'deleting', 'deleted', 'discarded')),
  inbound_source TEXT NOT NULL DEFAULT 'zcom_poll_sync' CHECK (inbound_source IN ('cloudflare_email_routing', 'zcom_poll_sync')),
  provider_service_id TEXT,
  provider_mailbox_id TEXT,
  mail_account_id TEXT REFERENCES mail_accounts(id),
  failure_code TEXT,                         -- normalized provider error code of the last failure
  last_error TEXT,                           -- redacted, human-readable
  idempotency_key TEXT UNIQUE,
  reserved_until TEXT,
  created_by TEXT,                           -- users.id or clients.id, see created_by_type
  created_by_type TEXT NOT NULL DEFAULT 'staff' CHECK (created_by_type IN ('staff', 'client', 'system')),
  provisioned_at TEXT,
  deleted_at TEXT,
  last_synced_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_mailboxes_service_status ON email_mailboxes(service_id, status);
CREATE INDEX IF NOT EXISTS idx_email_mailboxes_domain_id ON email_mailboxes(domain_id);
CREATE INDEX IF NOT EXISTS idx_email_mailboxes_mail_account_id ON email_mailboxes(mail_account_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_mailboxes_live_address ON email_mailboxes(address) WHERE status NOT IN ('deleted', 'discarded');
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_mailboxes_live_primary ON email_mailboxes(service_id) WHERE is_primary = 1 AND status NOT IN ('failed', 'deleted', 'discarded');

-- One row per provider operation attempt (create, delete, sync, ...):
-- outcome, normalized error code, whether it is safe to retry. Never holds
-- a password, token, or raw request body. mailbox_id has no REFERENCES so
-- the log reads the same whatever happens to the mailbox row later.
CREATE TABLE IF NOT EXISTS email_provisioning_logs (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES email_services(id),
  mailbox_id TEXT,
  provider TEXT NOT NULL,
  operation TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'unknown')),
  error_code TEXT,
  error_message TEXT,
  retryable INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  details_json TEXT,                         -- normalized, redacted (e.g. reconciliation discrepancies)
  actor_type TEXT NOT NULL CHECK (actor_type IN ('staff', 'client', 'system')),
  actor_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_provisioning_logs_service ON email_provisioning_logs(service_id, created_at);
CREATE INDEX IF NOT EXISTS idx_email_provisioning_logs_outcome ON email_provisioning_logs(outcome, created_at);

-- Security-relevant actions on a service (plan/entitlement/domain/status
-- changes, mailbox create/delete requests, resolutions). A dedicated table
-- rather than the shared audit_log because these need to be listed per
-- service and must record client actors (actor_type) once the client-
-- facing module exists; audit_log.actor_id assumes a staff user.
CREATE TABLE IF NOT EXISTS email_audit_logs (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES email_services(id),
  mailbox_id TEXT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('staff', 'client', 'system')),
  actor_id TEXT,
  action TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_audit_logs_service ON email_audit_logs(service_id, created_at);

-- Migration [2026-11-25], email services: every object in this block is
-- new, so it is applied by re-running this whole file against the shared
-- database (everything else is IF NOT EXISTS / INSERT OR IGNORE):
--   npx wrangler d1 execute <database-name> --remote --file=./d1/schema.sql
-- Run it BEFORE deploying ClientKeeper's Email Services module, whose
-- routes query these tables unconditionally.

-- One-time, token-gated links that let a client ask for a mailbox on a
-- specific email service without logging in to anything [2026-11-26].
-- Staff generate one in ClientKeeper (EmailServiceDetailPage, "Mailbox
-- request links") and send it by hand (chat, email); the client opens
-- www.altasme.com/mailbox-request/:slug?t=... on the marketing site
-- (altaventureswebsite's functions/api/public/mailbox-request/*), picks a
-- name, and that creates the same client-requested 'reserved' row
-- requestMailboxByClient creates (reserved_until NULL, created_by_type
-- 'client', created_by = the service's client_id), which staff then
-- fulfill or decline exactly as before. clienthub's own app is not
-- involved.
--
-- Same slug + access_token design as proposals/questionnaires/
-- service_agreements: the slug is readable and predictable, the
-- access_token is the real gate, compared in constant time by the public
-- route, and a bad token, a revoked link and a used link all answer the
-- same 404 so a stranger can't tell which.
--
-- service_id IS the authorization: a link can only ever reserve against
-- its own service, checked inside the single INSERT that reserves the
-- slot (the link's own status = 'open' is in that same statement too, so
-- two submissions of one link can't both get in). A link is single-use:
-- 'open' -> 'used' in the same batch as the reservation, with
-- used_mailbox_id pointing at the email_mailboxes row it created, so
-- staff can trace a link straight to its request. 'revoked' is a staff
-- action, refused once the link has been used. Not touched when staff
-- later fulfill or decline that request: the link's job ended when the
-- request was made.
CREATE TABLE IF NOT EXISTS mail_request_links (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES email_services(id),
  slug TEXT NOT NULL UNIQUE,
  access_token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'used', 'revoked')),
  created_by TEXT REFERENCES users(id),
  used_at TEXT,
  used_mailbox_id TEXT,                      -- email_mailboxes.id; no REFERENCES, same reasoning as email_provisioning_logs.mailbox_id
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mail_request_links_service_id ON mail_request_links(service_id);
CREATE INDEX IF NOT EXISTS idx_mail_request_links_slug ON mail_request_links(slug);

-- Migration [2026-11-26], mailbox request links: a brand-new table, so
-- re-running this whole file is enough (everything else is IF NOT EXISTS
-- / INSERT OR IGNORE and a no-op on the existing tables):
--   npx wrangler d1 execute <database-name> --remote --file=./d1/schema.sql
-- or run just the three statements above. Run it BEFORE deploying the
-- ClientKeeper request-link routes and the marketing site's
-- /mailbox-request page: both query this table unconditionally and fail
-- with "no such table" until it has run.

-- =====================================================================
-- Webmail Connect: single sign-on from a client's OWN admin panel into
-- ClientKeeper's webmail [2026-11-27]
--
-- Forward-looking: no client admin panel uses this yet. A future
-- Altaventures-built admin panel installs @altasme/webmail-connect (its
-- own repo), and its logged-in users open the mailboxes they've been
-- assigned inside mail.altasme.com without ever typing a mailbox
-- password. Nothing here touches the webmail tables' own rows: it only
-- decides WHO (an outside panel's user) may open WHICH existing
-- mail_accounts row, and how that person gets a session.
--
-- The identity is the MAILBOX (mail_accounts), never the panel's user.
-- A panel user is an opaque `external_user_id` that the integration
-- assigns; it is only unique WITHIN one integration and is never a
-- webmail account of its own. Many panel users may share one mailbox;
-- one panel user may have many mailboxes.
--
-- Three layers of authorization, all checked server-side on every
-- request by ClientKeeper (functions/_lib/mailConnect/*):
--   1. the integration itself: a row below, status 'active', proven by a
--      bearer secret whose SHA-256 is stored here (never the secret);
--   2. which mailboxes that integration may hand out at all (the tenant
--      boundary): its own client's hosted mailboxes (email_mailboxes ->
--      email_services.client_id), plus any mailbox Altaventures staff
--      explicitly attached in mail_client_integration_mailboxes;
--   3. which of those this particular panel user was granted, with which
--      permissions (mail_external_mailbox_access, set by the client's own
--      Super Admin through the integration's API).
-- A grant that falls outside layer 2 later (service suspended, mailbox
-- deleted, staff detached it) stops working on the next request; it is
-- not deleted, so it comes back if the mailbox does.
--
-- No mailbox password is involved anywhere in this block. Writers:
-- ClientKeeper only (staff routes for the first two tables, the
-- integration's bearer-authenticated API for the last two).
-- =====================================================================

-- One registered client admin panel. client_id is the Altaventures client
-- whose panel this is. secret_hash = lowercase hex SHA-256 of the full
-- API secret (wmc_<id>_<64 hex>); the secret is shown to staff once at
-- creation/rotation and can never be retrieved again. Rotating replaces
-- the hash, so the old secret stops working immediately. 'disabled'
-- refuses the secret, every pending launch code and every live session
-- on their next use.
CREATE TABLE IF NOT EXISTS mail_client_integrations (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  name TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mail_client_integrations_client_id ON mail_client_integrations(client_id);

-- Mailboxes Altaventures staff explicitly allow an integration to grant,
-- on top of its own client's hosted mailboxes. Exists because some real
-- mailboxes have no email_mailboxes row and must not get one: e.g.
-- Altaventures' own altasme.com mailboxes, which would otherwise become
-- eligible for the mailbox-password login (ClientKeeper CLAUDE.md §37).
-- Staff-only writes; an integration can never add to this list itself.
CREATE TABLE IF NOT EXISTS mail_client_integration_mailboxes (
  integration_id TEXT NOT NULL REFERENCES mail_client_integrations(id),
  mail_account_id TEXT NOT NULL REFERENCES mail_accounts(id),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (integration_id, mail_account_id)
);

-- Which panel user may open which mailbox, with what permissions.
-- Revoking deletes the row. can_read = 0 grants nothing at all (a grant
-- must at least allow reading to be usable). is_default picks the
-- mailbox opened first when a user has several; at most one per user
-- (partial unique index below).
-- granted_by is free text: whatever external_user_id the integration said
-- made the change. Altaventures does NOT verify that person's real-world
-- identity or role, only that the call carried that integration's valid
-- secret. That is the deliberate trust boundary: inside its own tenant,
-- the integration (the client's own panel) is the authority on its users.
CREATE TABLE IF NOT EXISTS mail_external_mailbox_access (
  id TEXT PRIMARY KEY,
  integration_id TEXT NOT NULL REFERENCES mail_client_integrations(id),
  external_user_id TEXT NOT NULL,
  mail_account_id TEXT NOT NULL REFERENCES mail_accounts(id),
  can_read INTEGER NOT NULL DEFAULT 1,
  can_send INTEGER NOT NULL DEFAULT 0,
  can_delete INTEGER NOT NULL DEFAULT 0,
  can_manage_settings INTEGER NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0,
  granted_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (integration_id, external_user_id, mail_account_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_external_mailbox_access_default ON mail_external_mailbox_access(integration_id, external_user_id) WHERE is_default = 1;
CREATE INDEX IF NOT EXISTS idx_mail_external_mailbox_access_account ON mail_external_mailbox_access(mail_account_id);

-- Short-lived, single-use codes that carry a panel user from their panel
-- into webmail. The integration's backend asks for one (bearer secret),
-- the browser is sent to mail.altasme.com/api/mail-connect/exchange?code=,
-- and that route claims it with ONE conditional UPDATE (status 'pending'
-- and not expired -> 'used'), so a code can never be redeemed twice, even
-- concurrently. expires_at is ~60 s after issue: the code is consumed by a
-- redirect a second later, never typed. `code` is the raw value (same
-- convention as mail_request_links.access_token), compared in constant
-- time; it is also the whole credential, so it's 256 bits of randomness.
-- return_url is the integration's own "back to the panel" URL (absolute
-- http/https; its host is the integration's business, not ours).
CREATE TABLE IF NOT EXISTS mail_launch_codes (
  id TEXT PRIMARY KEY,
  integration_id TEXT NOT NULL REFERENCES mail_client_integrations(id),
  external_user_id TEXT NOT NULL,
  return_url TEXT,
  code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'used', 'expired')),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mail_launch_codes_integration ON mail_launch_codes(integration_id, created_at);

-- Migration [2026-11-27], Webmail Connect: four brand-new tables, so
-- re-running this whole file is enough (everything else is IF NOT EXISTS
-- / INSERT OR IGNORE and a no-op on the existing tables):
--   npx wrangler d1 execute <database-name> --remote --file=./d1/schema.sql
-- or run just the statements in this block. Run it BEFORE deploying
-- ClientKeeper's /api/mail-connect/* and /api/app/mail-integrations/*
-- routes: they query these tables unconditionally and fail with "no such
-- table" until it has run. No ALTER TABLE is needed.
