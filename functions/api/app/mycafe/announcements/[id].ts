// Cloudflare Pages Function: GET/PATCH/DELETE /api/app/mycafe/announcements/:id
//
// GET is open to any staff role. PATCH (edit, publish, unpublish, archive, pin)
// and DELETE (a never-published draft only -- MyCafe refuses anything else) are
// owner/admin only, and each is audited.
import { deleteMyCafeAnnouncement, getMyCafeAnnouncement, updateMyCafeAnnouncement } from "../../../../_lib/mycafe";
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

type Ctx = Parameters<PagesFunction<AnnouncementsEnv, "id", { staffUser: StaffUser }>>[0];
const idOf = (params: Ctx["params"]) => (Array.isArray(params.id) ? params.id[0]! : params.id);

export const onRequestGet: PagesFunction<AnnouncementsEnv, "id", { staffUser: StaffUser }> = async ({ env, params }) => {
  const notConfigured = checkConfigured(env);
  if (notConfigured) return notConfigured;
  try {
    return jsonResponse(200, await getMyCafeAnnouncement(env, idOf(params)));
  } catch (err) {
    return mapError(err);
  }
};

export const onRequestPatch: PagesFunction<AnnouncementsEnv, "id", { staffUser: StaffUser }> = async ({ env, params, request, data }) => {
  const notConfigured = checkConfigured(env);
  if (notConfigured) return notConfigured;
  const forbidden = requireAdmin(data.staffUser);
  if (forbidden) return forbidden;

  const body = await readJsonBody(request);
  if (body === null) return jsonResponse(400, { error: "Request body must be valid JSON" });
  const fields = pickAnnouncementFields(body);

  try {
    const updated = await updateMyCafeAnnouncement(env, idOf(params), fields);
    const action =
      fields.status === "published"
        ? "mycafe_announcement_published"
        : fields.status === "archived"
          ? "mycafe_announcement_archived"
          : fields.status === "draft"
            ? "mycafe_announcement_unpublished"
            : "mycafe_announcement_updated";
    await audit(env, data.staffUser, action, updated.id, { title: updated.title, status: updated.status, changed: Object.keys(fields) });
    return jsonResponse(200, updated);
  } catch (err) {
    return mapError(err);
  }
};

export const onRequestDelete: PagesFunction<AnnouncementsEnv, "id", { staffUser: StaffUser }> = async ({ env, params, data }) => {
  const notConfigured = checkConfigured(env);
  if (notConfigured) return notConfigured;
  const forbidden = requireAdmin(data.staffUser);
  if (forbidden) return forbidden;

  try {
    const id = idOf(params);
    const existing = await getMyCafeAnnouncement(env, id);
    await deleteMyCafeAnnouncement(env, id);
    await audit(env, data.staffUser, "mycafe_announcement_deleted", id, { title: existing.title });
    return jsonResponse(200, { deleted: true });
  } catch (err) {
    return mapError(err);
  }
};
