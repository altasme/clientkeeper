// Webmail environment + policy configuration.
//
// Secrets (set as Cloudflare Pages / Worker secrets in the dashboard or via
// `wrangler secret put`, NEVER committed, NEVER returned by any API route,
// never logged): MAIL_SMTP_PASSWORD and MAIL_SMTP_PROFILES_JSON. Same
// "server-side env only" discipline as RESEND_API_KEY in functions/_lib/email.ts,
// whose SendEmailEnv interface this mirrors.
//
//   MAIL_SMTP_HOST        e.g. smtp.example.com
//   MAIL_SMTP_PORT        465 (implicit TLS, default) or 587 (STARTTLS)
//   MAIL_SMTP_SECURITY    optional: "tls" | "starttls" (defaults from the port)
//   MAIL_SMTP_USERNAME    the SMTP login
//   MAIL_SMTP_PASSWORD    the SMTP password / app password (secret)
//   MAIL_SMTP_EHLO_NAME   optional EHLO hostname (defaults to the sending domain)
//   MAIL_SMTP_PROFILES_JSON optional secret, for identities that need their
//                         own SMTP login: {"<profile>": {"host","port","security","username","password"}}
//                         referenced by mail_accounts.smtp_profile.
//
// Bindings: DB (the shared D1 database), MAIL_ATTACHMENTS (private R2 bucket).

import type { SmtpConfig, SmtpSecurity } from "./smtp";

export interface MailEnv {
  DB?: D1Database;
  MAIL_ATTACHMENTS?: R2Bucket;
  MAIL_SMTP_HOST?: string;
  MAIL_SMTP_PORT?: string;
  MAIL_SMTP_SECURITY?: string;
  MAIL_SMTP_USERNAME?: string;
  MAIL_SMTP_PASSWORD?: string;
  MAIL_SMTP_EHLO_NAME?: string;
  MAIL_SMTP_PROFILES_JSON?: string;
}

function securityFor(port: number, explicit?: string): SmtpSecurity {
  if (explicit === "tls" || explicit === "starttls" || explicit === "none") return explicit;
  return port === 465 ? "tls" : "starttls";
}

/** Resolves SMTP settings for an identity. Returns null when not configured. */
export function resolveSmtpConfig(env: MailEnv, profile: string | null, fromEmail: string): SmtpConfig | null {
  const ehloDefault = env.MAIL_SMTP_EHLO_NAME || fromEmail.split("@")[1] || "localhost";
  if (profile) {
    if (!env.MAIL_SMTP_PROFILES_JSON) return null;
    try {
      const all = JSON.parse(env.MAIL_SMTP_PROFILES_JSON) as Record<string, Record<string, unknown>>;
      const p = all[profile];
      if (!p || typeof p.host !== "string" || typeof p.username !== "string" || typeof p.password !== "string") return null;
      const port = Number(p.port) || 465;
      return {
        host: p.host,
        port,
        security: securityFor(port, typeof p.security === "string" ? p.security : undefined),
        username: p.username,
        password: p.password,
        clientName: ehloDefault,
      };
    } catch {
      return null;
    }
  }
  if (!env.MAIL_SMTP_HOST || !env.MAIL_SMTP_USERNAME || !env.MAIL_SMTP_PASSWORD) return null;
  const port = Number(env.MAIL_SMTP_PORT) || 465;
  return {
    host: env.MAIL_SMTP_HOST,
    port,
    security: securityFor(port, env.MAIL_SMTP_SECURITY),
    username: env.MAIL_SMTP_USERNAME,
    password: env.MAIL_SMTP_PASSWORD,
    clientName: ehloDefault,
  };
}

/** Status only -- safe to return to the browser (no host, user or password). */
export function smtpStatus(env: MailEnv, profile: string | null): "configured" | "not_configured" {
  return resolveSmtpConfig(env, profile, "x@localhost") ? "configured" : "not_configured";
}

// ---------- business-wide policy (mail_settings) ----------

export type RemoteImagePolicy = "block" | "allow" | "never";

export interface MailPolicy {
  maxAttachmentBytes: number;
  maxAttachmentCount: number;
  maxTotalAttachmentBytes: number;
  maxRecipients: number;
  sendsPerHourPerUser: number;
  remoteImagePolicy: RemoteImagePolicy;
}

const MB = 1024 * 1024;

export const DEFAULT_POLICY: MailPolicy = {
  maxAttachmentBytes: 20 * MB,
  maxAttachmentCount: 10,
  maxTotalAttachmentBytes: 25 * MB,
  maxRecipients: 50,
  sendsPerHourPerUser: 100,
  remoteImagePolicy: "block",
};

// Hard ceilings an admin can't raise past (Workers memory / typical SMTP
// provider message-size limits; a 25 MB attachment set is ~34 MB once
// base64-encoded on the wire).
export const POLICY_LIMITS = {
  maxAttachmentBytes: [1 * MB, 25 * MB],
  maxAttachmentCount: [1, 20],
  maxTotalAttachmentBytes: [1 * MB, 30 * MB],
  maxRecipients: [1, 100],
  sendsPerHourPerUser: [1, 1000],
} as const;

export function validatePolicyPatch(patch: Record<string, unknown>): { ok: true; values: Partial<MailPolicy> } | { ok: false; error: string } {
  const values: Partial<MailPolicy> = {};
  for (const key of Object.keys(POLICY_LIMITS) as (keyof typeof POLICY_LIMITS)[]) {
    if (patch[key] === undefined) continue;
    const n = Number(patch[key]);
    const [min, max] = POLICY_LIMITS[key];
    if (!Number.isInteger(n) || n < min || n > max) return { ok: false, error: `${key} must be a whole number between ${min} and ${max}.` };
    values[key] = n;
  }
  if (patch.remoteImagePolicy !== undefined) {
    if (patch.remoteImagePolicy !== "block" && patch.remoteImagePolicy !== "allow" && patch.remoteImagePolicy !== "never") {
      return { ok: false, error: "remoteImagePolicy must be block, allow or never." };
    }
    values.remoteImagePolicy = patch.remoteImagePolicy;
  }
  return { ok: true, values };
}

export async function loadPolicy(db: D1Database): Promise<MailPolicy> {
  const policy: MailPolicy = { ...DEFAULT_POLICY };
  try {
    const rows = await db.prepare(`SELECT key, value FROM mail_settings`).all<{ key: string; value: string }>();
    const raw: Record<string, unknown> = {};
    for (const r of rows.results) {
      try {
        raw[r.key] = JSON.parse(r.value);
      } catch {
        /* ignore malformed */
      }
    }
    const v = validatePolicyPatch(raw);
    if (v.ok) Object.assign(policy, v.values);
  } catch {
    /* table missing -> defaults */
  }
  return policy;
}

// ---------- per-user preferences (mail_user_settings) ----------

export interface MailUserSettings {
  defaultAccountId: string | null;
  defaultFolder: "inbox" | "starred" | "sent" | "drafts" | "archive";
  sortOrder: "newest" | "oldest";
  density: "comfortable" | "compact";
  readingPane: "right" | "full";
  refreshIntervalSec: number;
  notifyNewMail: boolean;
  sound: boolean;
  desktopNotifications: boolean;
  unreadBadge: boolean;
  composerFormat: "rich" | "plain";
  autosave: boolean;
}

export const DEFAULT_USER_SETTINGS: MailUserSettings = {
  defaultAccountId: null,
  defaultFolder: "inbox",
  sortOrder: "newest",
  density: "comfortable",
  readingPane: "right",
  refreshIntervalSec: 45,
  notifyNewMail: true,
  sound: false,
  desktopNotifications: false,
  unreadBadge: true,
  composerFormat: "rich",
  autosave: true,
};

const ENUMS: Partial<Record<keyof MailUserSettings, readonly string[]>> = {
  defaultFolder: ["inbox", "starred", "sent", "drafts", "archive"],
  sortOrder: ["newest", "oldest"],
  density: ["comfortable", "compact"],
  readingPane: ["right", "full"],
  composerFormat: ["rich", "plain"],
};
const BOOLS: (keyof MailUserSettings)[] = ["notifyNewMail", "sound", "desktopNotifications", "unreadBadge", "autosave"];

/** Whitelists + validates a user-settings object; unknown keys are dropped. */
export function sanitizeUserSettings(input: Record<string, unknown>, base: MailUserSettings = DEFAULT_USER_SETTINGS): MailUserSettings {
  const out: MailUserSettings = { ...base };
  for (const [key, allowed] of Object.entries(ENUMS) as [keyof MailUserSettings, readonly string[]][]) {
    const v = input[key];
    if (typeof v === "string" && allowed.includes(v)) (out as unknown as Record<string, unknown>)[key] = v;
  }
  for (const key of BOOLS) {
    if (typeof input[key] === "boolean") (out as unknown as Record<string, unknown>)[key] = input[key];
  }
  if (input.refreshIntervalSec !== undefined) {
    const n = Number(input.refreshIntervalSec);
    if (Number.isFinite(n)) out.refreshIntervalSec = Math.min(300, Math.max(30, Math.round(n)));
  }
  if (input.defaultAccountId === null || typeof input.defaultAccountId === "string") {
    out.defaultAccountId = (input.defaultAccountId as string | null) || null;
  }
  return out;
}
