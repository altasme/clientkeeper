import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  ApiError,
  deleteMyCafeAnnouncement,
  fetchMyCafeAnnouncements,
  isMyCafeAdmin,
  updateMyCafeAnnouncement,
  type AnnouncementStatus,
  type MyCafeAnnouncement,
} from "../lib/api";
import { CATEGORY_META, STATUS_META, formatDate } from "../lib/announcementMeta";
import { useMe } from "../lib/MeContext";

const FILTERS: { value: "" | AnnouncementStatus; label: string }[] = [
  { value: "", label: "All" },
  { value: "published", label: "Published" },
  { value: "draft", label: "Drafts" },
  { value: "archived", label: "Archived" },
];

// The announcement manager: what we post here shows up in every café's Owner
// Panel under "What's New". Anyone on staff can read the list; creating, editing,
// publishing and deleting is owner/admin only (the server enforces it; this page
// just hides the buttons).
export default function MyCafeAnnouncementsPage() {
  const { staffUser } = useMe();
  const canManage = isMyCafeAdmin(staffUser);
  const [filter, setFilter] = useState<"" | AnnouncementStatus>("");
  const [items, setItems] = useState<MyCafeAnnouncement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetchMyCafeAnnouncements(filter || undefined)
      .then((rows) => {
        setItems(rows);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load announcements."))
      .finally(() => setLoading(false));
  }, [filter]);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (item: MyCafeAnnouncement, run: () => Promise<unknown>) => {
    setBusyId(item.id);
    setError(null);
    try {
      await run();
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setBusyId(null);
    }
  };

  const setStatus = (item: MyCafeAnnouncement, status: AnnouncementStatus, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    void act(item, () => updateMyCafeAnnouncement(item.id, { status }));
  };

  const remove = (item: MyCafeAnnouncement) => {
    if (!window.confirm(`Delete the draft "${item.title}"? This can't be undone.`)) return;
    void act(item, () => deleteMyCafeAnnouncement(item.id));
  };

  const btn = "rounded-full border border-ink/15 px-3 py-2 text-xs font-semibold text-ink/70 hover:bg-paper-alt disabled:opacity-50 sm:py-1.5";

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-mycafe-dark">Announcements</h1>
          <p className="mt-1 text-sm text-ink/50">Post what's new. Published posts appear in every café's Owner Panel under &ldquo;What's New&rdquo;.</p>
        </div>
        {canManage && (
          <Link
            to="/mycafe/announcements/new"
            className="w-full rounded-full bg-mycafe px-4 py-2.5 text-center text-sm font-semibold text-white transition hover:bg-mycafe-dark sm:w-auto"
          >
            + New announcement
          </Link>
        )}
      </div>

      <div className="-mx-4 mt-5 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:px-0" role="tablist" aria-label="Filter by status">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            role="tab"
            aria-selected={filter === f.value}
            onClick={() => setFilter(f.value)}
            className={`whitespace-nowrap rounded-full px-4 py-2 text-sm font-semibold ${
              filter === f.value ? "bg-mycafe text-white" : "border border-ink/15 bg-white text-ink/70 hover:bg-paper-alt"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {loading && <p className="mt-4 text-sm text-ink/50">Loading&hellip;</p>}
      {!loading && items.length === 0 && !error && (
        <p className="mt-4 rounded-xl border border-ink/10 bg-white p-6 text-center text-sm text-ink/40">
          {filter ? "Nothing here." : "No announcements yet."}
          {canManage && !filter ? " Write the first one." : ""}
        </p>
      )}

      <ul className="mt-4 space-y-3">
        {items.map((a) => {
          const category = CATEGORY_META[a.category];
          const status = STATUS_META[a.status];
          const busy = busyId === a.id;
          return (
            <li key={a.id} className="rounded-xl border border-ink/10 bg-white p-4">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className={`rounded-full px-2 py-0.5 font-semibold ${status.className}`}>{status.label}</span>
                <span className={`rounded-full px-2 py-0.5 font-semibold ${category.className}`}>{category.label}</span>
                {a.pinned && <span className="rounded-full border border-ink/20 px-2 py-0.5 font-semibold text-ink/70">Pinned</span>}
              </div>
              <h2 className="mt-2 break-words text-base font-bold text-ink">{a.title}</h2>
              <p className="mt-1 line-clamp-2 whitespace-pre-line break-words text-sm text-ink/60">{a.body}</p>
              <p className="mt-2 text-xs text-ink/40">
                {a.status === "published" || a.publishedAt ? `Published ${formatDate(a.publishedAt)} · ` : `Created ${formatDate(a.createdAt)} · `}
                {a.author ? `by ${a.author} · ` : ""}
                {a.status === "draft" ? "not visible to cafés" : `read by ${a.readByCafes} café${a.readByCafes === 1 ? "" : "s"}`}
              </p>
              {canManage && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <Link to={`/mycafe/announcements/${a.id}`} className={btn}>
                    Edit
                  </Link>
                  {a.status !== "published" && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setStatus(a, "published", `Publish "${a.title}"? It will appear in every café's Owner Panel.`)}
                      className="rounded-full bg-mycafe px-3 py-2 text-xs font-semibold text-white hover:bg-mycafe-dark disabled:opacity-50 sm:py-1.5"
                    >
                      Publish
                    </button>
                  )}
                  {a.status === "published" && (
                    <button type="button" disabled={busy} onClick={() => setStatus(a, "draft", `Unpublish "${a.title}"? Cafés will stop seeing it.`)} className={btn}>
                      Unpublish
                    </button>
                  )}
                  {a.status !== "archived" && a.publishedAt && (
                    <button type="button" disabled={busy} onClick={() => setStatus(a, "archived", `Archive "${a.title}"? It is hidden from cafés but kept for the record.`)} className={btn}>
                      Archive
                    </button>
                  )}
                  {a.status === "draft" && !a.publishedAt && (
                    <button type="button" disabled={busy} onClick={() => remove(a)} className="rounded-full border border-red-200 px-3 py-2 text-xs font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50 sm:py-1.5">
                      Delete
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
