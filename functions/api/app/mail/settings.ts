// GET   /api/app/mail/settings -> { user, policy, isAdmin }
// PATCH /api/app/mail/settings -> { user?: {...}, policy?: {...} }
// `user` = the caller's own preferences; `policy` = business-wide limits
// (owner/admin only). Both are whitelisted/validated in config.ts.

import { isMailAdmin } from "../../../_lib/mail/access";
import { DEFAULT_USER_SETTINGS, loadPolicy, sanitizeUserSettings, validatePolicyPatch, type MailUserSettings } from "../../../_lib/mail/config";
import { logMailEvent } from "../../../_lib/mail/events";
import { errorResponse, jsonResponse, nowIso, readJsonBody } from "../../../_lib/mail/http";
import { mailHandler } from "../../../_lib/mail/route";

async function loadUserSettings(db: D1Database, userId: string): Promise<MailUserSettings> {
  const row = await db.prepare(`SELECT settings_json FROM mail_user_settings WHERE user_id = ?`).bind(userId).first<{ settings_json: string }>();
  if (!row) return { ...DEFAULT_USER_SETTINGS };
  try {
    return sanitizeUserSettings(JSON.parse(row.settings_json) as Record<string, unknown>);
  } catch {
    return { ...DEFAULT_USER_SETTINGS };
  }
}

export const onRequestGet = mailHandler(async ({ db, user, access }) => {
  const settings = await loadUserSettings(db, user.id);
  if (settings.defaultAccountId && !access.has(settings.defaultAccountId)) settings.defaultAccountId = null;
  return jsonResponse(200, { user: settings, policy: await loadPolicy(db), isAdmin: isMailAdmin(user) });
});

export const onRequestPatch = mailHandler(async ({ ctx, db, user, access }) => {
  const body = await readJsonBody(ctx.request);
  if (!body) return errorResponse(400, "Invalid request body");
  const now = nowIso();
  if (body.user && typeof body.user === "object") {
    const current = await loadUserSettings(db, user.id);
    const next = sanitizeUserSettings(body.user as Record<string, unknown>, current);
    if (next.defaultAccountId && !access.has(next.defaultAccountId)) return errorResponse(400, "Default mailbox must be one you can access.");
    await db
      .prepare(`INSERT INTO mail_user_settings (user_id, settings_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at`)
      .bind(user.id, JSON.stringify(next), now)
      .run();
  }
  if (body.policy && typeof body.policy === "object") {
    if (!isMailAdmin(user)) return errorResponse(403, "Only an owner or admin can change mail policy.");
    const v = validatePolicyPatch(body.policy as Record<string, unknown>);
    if (!v.ok) return errorResponse(400, v.error);
    const entries = Object.entries(v.values);
    if (entries.length) {
      await db.batch(
        entries.map(([key, value]) =>
          db
            .prepare(`INSERT INTO mail_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
            .bind(key, JSON.stringify(value), user.id, now)
        )
      );
      await logMailEvent(db, { type: "policy_updated", data: v.values, actorId: user.id });
    }
  }
  const settings = await loadUserSettings(db, user.id);
  return jsonResponse(200, { user: settings, policy: await loadPolicy(db), isAdmin: isMailAdmin(user) });
});
