// Cloudflare Pages Function: GET/POST /api/app/mycafe/announcements
//
// The "What's New" feed shown in every MyCafe cafe's Owner Panel. List is open
// to any staff role; creating a post is owner/admin only (it reaches every cafe
// once published). Stored in MyCafe's own database via its admin API.
import { createMyCafeAnnouncement, listMyCafeAnnouncements } from "../../../../_lib/mycafe";
import {
  audit,
  checkConfigured,
  jsonResponse,
  mapError,
  pickAnnouncementFields,
  readJsonBody,
  requireAdmin,
  type AnnouncementsEnv,
} from "../../../../_lib/mycafeAnnouncements";
import type { StaffUser } from "../../../../_lib/roles";

export const onRequestGet: PagesFunction<AnnouncementsEnv, string, { staffUser: StaffUser }> = async ({ env, request }) => {
  const notConfigured = checkConfigured(env);
  if (notConfigured) return notConfigured;
  const status = new URL(request.url).searchParams.get("status")?.trim() || undefined;
  try {
    return jsonResponse(200, { announcements: await listMyCafeAnnouncements(env, status) });
  } catch (err) {
    return mapError(err);
  }
};

export const onRequestPost: PagesFunction<AnnouncementsEnv, string, { staffUser: StaffUser }> = async ({ env, request, data }) => {
  const notConfigured = checkConfigured(env);
  if (notConfigured) return notConfigured;
  const forbidden = requireAdmin(data.staffUser);
  if (forbidden) return forbidden;

  const body = await readJsonBody(request);
  if (body === null) return jsonResponse(400, { error: "Request body must be valid JSON" });

  try {
    const created = await createMyCafeAnnouncement(env, {
      ...pickAnnouncementFields(body),
      author: data.staffUser.full_name || data.staffUser.email,
    });
    await audit(env, data.staffUser, created.status === "published" ? "mycafe_announcement_published" : "mycafe_announcement_created", created.id, {
      title: created.title,
      status: created.status,
    });
    return jsonResponse(201, created);
  } catch (err) {
    return mapError(err);
  }
};
