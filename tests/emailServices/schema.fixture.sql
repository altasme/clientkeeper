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
