import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ApiError,
  createMyCafeAnnouncement,
  fetchMyCafeAnnouncement,
  isMyCafeAdmin,
  updateMyCafeAnnouncement,
  type AnnouncementCategory,
  type AnnouncementStatus,
  type MyCafeAnnouncement,
} from "../lib/api";
import { CATEGORY_OPTIONS, LIMITS, STATUS_META, isValidHttpsUrl } from "../lib/announcementMeta";
import AnnouncementPreview from "../components/AnnouncementPreview";
import { useMe } from "../lib/MeContext";

// Create (/mycafe/announcements/new) or edit (/mycafe/announcements/:id) one post,
// with a live preview of what café owners will see. Owner/admin only.
export default function MyCafeAnnouncementEditorPage() {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();
  const { staffUser } = useMe();
  const canManage = isMyCafeAdmin(staffUser);

  const [existing, setExisting] = useState<MyCafeAnnouncement | null>(null);
  const [loading, setLoading] = useState(!isNew);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [category, setCategory] = useState<AnnouncementCategory>("new_feature");
  const [pinned, setPinned] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkLabel, setLinkLabel] = useState("");

  useEffect(() => {
    if (!id) return;
    fetchMyCafeAnnouncement(id)
      .then((a) => {
        setExisting(a);
        setTitle(a.title);
        setBody(a.body);
        setCategory(a.category);
        setPinned(a.pinned);
        setLinkUrl(a.linkUrl ?? "");
        setLinkLabel(a.linkLabel ?? "");
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load this announcement."))
      .finally(() => setLoading(false));
  }, [id]);

  if (!canManage) {
    return (
      <div>
        <Link to="/mycafe/announcements" className="text-xs font-semibold text-mycafe hover:underline">
          &larr; Back to announcements
        </Link>
        <p className="mt-4 text-sm text-ink/60">Only owner/admin can write or edit MyCafe announcements.</p>
      </div>
    );
  }
  if (loading) return <p className="text-sm text-ink/50">Loading&hellip;</p>;
  if (!isNew && !existing) return <p className="text-sm text-red-600">{error ?? "Announcement not found."}</p>;

  const url = linkUrl.trim();
  const urlProblem = url && !isValidHttpsUrl(url) ? "Must be a full https:// address" : null;
  const labelWithoutUrl = !url && linkLabel.trim() ? "Add a link address, or clear the label" : null;
  const ready = title.trim().length > 0 && body.trim().length > 0 && !urlProblem && !labelWithoutUrl;
  const current: AnnouncementStatus = existing?.status ?? "draft";

  const save = async (nextStatus: AnnouncementStatus | null) => {
    if (!ready || saving) return;
    if (nextStatus === "published" && !window.confirm("Publish this? It will appear in every café's Owner Panel right away.")) return;
    setSaving(true);
    setError(null);
    const fields = {
      title: title.trim(),
      body: body.trim(),
      category,
      pinned,
      linkUrl: url || null,
      linkLabel: url ? linkLabel.trim() || null : null,
      ...(nextStatus ? { status: nextStatus } : {}),
    };
    try {
      if (isNew) await createMyCafeAnnouncement({ ...fields, status: nextStatus ?? "draft" });
      else await updateMyCafeAnnouncement(id!, fields);
      navigate("/mycafe/announcements");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save.");
      setSaving(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void save(null);
  };

  const field = "mt-1 w-full rounded-lg border border-ink/15 px-3 py-2.5 text-base outline-none focus:border-mycafe sm:text-sm";
  const counter = (n: number, max: number) => <span className={`text-xs ${n > max ? "text-red-600" : "text-ink/40"}`}>{n}/{max}</span>;

  return (
    <div>
      <Link to="/mycafe/announcements" className="text-xs font-semibold text-mycafe hover:underline">
        &larr; Back to announcements
      </Link>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-bold text-mycafe-dark">{isNew ? "New announcement" : "Edit announcement"}</h1>
        {!isNew && <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_META[current].className}`}>{STATUS_META[current].label}</span>}
      </div>
      {!isNew && current === "published" && (
        <p className="mt-1 text-xs text-ink/50">This post is live &mdash; saving changes updates it for every café immediately.</p>
      )}

      <div className="mt-5 grid gap-6 lg:grid-cols-2">
        <form onSubmit={onSubmit} className="space-y-4">
          <label className="block text-sm font-semibold text-ink">
            <span className="flex items-center justify-between">
              Title {counter(title.length, LIMITS.title)}
            </span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={LIMITS.title + 20} className={field} placeholder="Pay Later is here" />
          </label>

          <label className="block text-sm font-semibold text-ink">
            Category
            <select value={category} onChange={(e) => setCategory(e.target.value as AnnouncementCategory)} className={field}>
              {CATEGORY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block text-sm font-semibold text-ink">
            <span className="flex items-center justify-between">
              Message {counter(body.length, LIMITS.body)}
            </span>
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={8} className={`${field} resize-y`} placeholder="What changed, and what the owner should do about it." />
            <span className="mt-1 block text-xs font-normal text-ink/40">Plain text. Line breaks are kept; HTML is shown as typed, not rendered.</span>
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm font-semibold text-ink">
              Link (optional)
              <input value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} inputMode="url" className={field} placeholder="https://…" />
              {urlProblem && <span className="mt-1 block text-xs font-normal text-red-600">{urlProblem}</span>}
            </label>
            <label className="block text-sm font-semibold text-ink">
              Link button text
              <input value={linkLabel} onChange={(e) => setLinkLabel(e.target.value)} maxLength={LIMITS.linkLabel} className={field} placeholder="Learn more" />
              {labelWithoutUrl && <span className="mt-1 block text-xs font-normal text-red-600">{labelWithoutUrl}</span>}
            </label>
          </div>

          <label className="flex items-center gap-3 text-sm font-semibold text-ink">
            <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} className="h-5 w-5 rounded border-ink/30" />
            Pin to the top
          </label>

          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

          <div className="flex flex-col gap-2 sm:flex-row">
            {current === "published" ? (
              <button type="submit" disabled={!ready || saving} className="rounded-full bg-mycafe px-5 py-3 text-sm font-semibold text-white hover:bg-mycafe-dark disabled:opacity-50 sm:py-2.5">
                {saving ? "Saving…" : "Save changes"}
              </button>
            ) : (
              <>
                <button type="button" onClick={() => void save("published")} disabled={!ready || saving} className="rounded-full bg-mycafe px-5 py-3 text-sm font-semibold text-white hover:bg-mycafe-dark disabled:opacity-50 sm:py-2.5">
                  {saving ? "Saving…" : "Publish now"}
                </button>
                <button type="submit" disabled={!ready || saving} className="rounded-full border border-ink/20 px-5 py-3 text-sm font-semibold text-ink/70 hover:bg-paper-alt disabled:opacity-50 sm:py-2.5">
                  Save as draft
                </button>
              </>
            )}
            <Link to="/mycafe/announcements" className="rounded-full px-5 py-3 text-center text-sm font-semibold text-ink/50 hover:text-ink sm:py-2.5">
              Cancel
            </Link>
          </div>
        </form>

        <div className="lg:sticky lg:top-24 lg:self-start">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink/40">Preview &mdash; as café owners will see it</p>
          <AnnouncementPreview
            title={title}
            body={body}
            category={category}
            pinned={pinned}
            linkUrl={url || null}
            linkLabel={linkLabel || null}
            publishedAt={existing?.publishedAt ?? null}
          />
        </div>
      </div>
    </div>
  );
}
