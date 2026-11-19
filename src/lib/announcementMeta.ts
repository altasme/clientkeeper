import type { AnnouncementCategory, AnnouncementStatus } from "./api";

// One place for how a category/status looks, shared by the manager list, the
// editor and the "as owners will see it" preview.
export const CATEGORY_META: Record<AnnouncementCategory, { label: string; className: string }> = {
  new_feature: { label: "New feature", className: "bg-emerald-100 text-emerald-800" },
  improvement: { label: "Improvement", className: "bg-sky-100 text-sky-800" },
  fix: { label: "Fix", className: "bg-violet-100 text-violet-800" },
  announcement: { label: "Announcement", className: "bg-amber-100 text-amber-900" },
  maintenance: { label: "Maintenance", className: "bg-red-100 text-red-800" },
};

export const CATEGORY_OPTIONS = Object.entries(CATEGORY_META).map(([value, meta]) => ({
  value: value as AnnouncementCategory,
  label: meta.label,
}));

export const STATUS_META: Record<AnnouncementStatus, { label: string; className: string }> = {
  draft: { label: "Draft", className: "bg-ink/10 text-ink/60" },
  published: { label: "Published", className: "bg-green-100 text-green-700" },
  archived: { label: "Archived", className: "bg-amber-100 text-amber-800" },
};

export const LIMITS = { title: 120, body: 5000, linkUrl: 500, linkLabel: 60 } as const;

// The same check MyCafe applies: a real https address with a dotted host.
export function isValidHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.includes(".");
  } catch {
    return false;
  }
}

export function formatDate(iso: string | null): string {
  if (!iso) return "—";
  // MyCafe sends "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker.
  const normalised = /[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso.replace(" ", "T")}Z`;
  return new Date(normalised).toLocaleDateString("en-PH", { timeZone: "Asia/Manila", year: "numeric", month: "short", day: "numeric" });
}
