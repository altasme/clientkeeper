import { CATEGORY_META, formatDate, isValidHttpsUrl } from "../lib/announcementMeta";
import type { AnnouncementCategory } from "../lib/api";

// "As a café owner will see it" -- mirrors the Owner Panel's What's New card
// (mycafe-pos-system src/routes/ownerpanel/whats-new.tsx). Text is rendered as
// text (React escapes it); only a valid https link becomes a button.
export default function AnnouncementPreview({
  title,
  body,
  category,
  pinned,
  linkUrl,
  linkLabel,
  publishedAt,
}: {
  title: string;
  body: string;
  category: AnnouncementCategory;
  pinned: boolean;
  linkUrl: string | null;
  linkLabel: string | null;
  publishedAt: string | null;
}) {
  const meta = CATEGORY_META[category];
  const href = linkUrl && isValidHttpsUrl(linkUrl) ? linkUrl : null;
  return (
    <div className="rounded-xl border border-mycafe/40 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className={`rounded-full px-2 py-0.5 font-semibold ${meta.className}`}>{meta.label}</span>
        {pinned && <span className="rounded-full border border-ink/20 px-2 py-0.5 font-semibold text-ink/70">Pinned</span>}
        <span className="rounded-full bg-mycafe px-2 py-0.5 font-semibold text-white">New</span>
        <span className="ml-auto text-ink/50">{publishedAt ? formatDate(publishedAt) : "Today"}</span>
      </div>
      <h3 className="mt-3 break-words text-lg font-bold leading-snug text-ink">{title.trim() || "Your title appears here"}</h3>
      <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-ink/80">{body.trim() || "Your message appears here."}</p>
      {href && (
        <span className="mt-3 inline-flex h-10 items-center rounded-md bg-mycafe px-4 text-sm font-semibold text-white">
          {linkLabel?.trim() || "Learn more"} &#8599;
        </span>
      )}
    </div>
  );
}
