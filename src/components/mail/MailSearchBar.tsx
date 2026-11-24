import { useEffect, useState } from "react";
import type { ListFilters } from "../../lib/mailApi";

export default function MailSearchBar({ value, onChange }: { value: ListFilters; onChange: (f: ListFilters) => void }) {
  const [q, setQ] = useState(value.q ?? "");
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ListFilters>(value);
  useEffect(() => {
    setQ(value.q ?? "");
    setDraft(value);
  }, [value]);
  const active = Object.entries(value).some(([k, v]) => k !== "q" && v);
  const hasAny = !!value.q || active;

  return (
    <div className="relative min-w-0 flex-1">
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          onChange({ ...value, q: q.trim() || undefined });
        }}
        className="flex min-w-0 items-center gap-1 rounded-full bg-paper-alt px-3 ring-1 ring-ink/10 focus-within:ring-brand-blue"
      >
        <span aria-hidden="true" className="text-ink/60">🔍</span>
        <input type="search" aria-label="Search mail" placeholder="Search mail" value={q} onChange={(e) => setQ(e.target.value)} className="min-w-0 flex-1 bg-transparent py-2 text-sm focus:outline-none" />
        {hasAny && (
          <button type="button" onClick={() => onChange({})} className="shrink-0 text-xs font-semibold text-brand-blue">Clear</button>
        )}
        <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className={`shrink-0 rounded-full px-2 py-1 text-xs font-semibold ${active ? "bg-brand-blue text-white" : "text-ink/70 hover:bg-ink/5"}`}>
          Filters
        </button>
      </form>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-2 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-ink/10 bg-white p-4 shadow-xl">
          <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <label className="flex flex-col gap-1 sm:col-span-2">
              <span className="text-xs font-semibold text-ink/60">From</span>
              <input value={draft.from ?? ""} onChange={(e) => setDraft({ ...draft, from: e.target.value })} className="rounded-lg border border-ink/15 px-2 py-1.5" />
            </label>
            <label className="flex flex-col gap-1 sm:col-span-2">
              <span className="text-xs font-semibold text-ink/60">To / Cc</span>
              <input value={draft.to ?? ""} onChange={(e) => setDraft({ ...draft, to: e.target.value })} className="rounded-lg border border-ink/15 px-2 py-1.5" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-ink/60">After</span>
              <input type="date" value={draft.dateFrom ?? ""} onChange={(e) => setDraft({ ...draft, dateFrom: e.target.value })} className="rounded-lg border border-ink/15 px-2 py-1.5" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-ink/60">Before</span>
              <input type="date" value={draft.dateTo ?? ""} onChange={(e) => setDraft({ ...draft, dateTo: e.target.value })} className="rounded-lg border border-ink/15 px-2 py-1.5" />
            </label>
            {(
              [
                ["unread", "Unread only"],
                ["starred", "Starred"],
                ["hasAttachments", "Has attachments"],
              ] as const
            ).map(([k, l]) => (
              <label key={k} className="flex items-center gap-2">
                <input type="checkbox" checked={!!draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.checked })} className="accent-brand-blue" />
                {l}
              </label>
            ))}
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={() => setOpen(false)} className="rounded-full px-3 py-1.5 text-sm text-ink/70">Cancel</button>
            <button
              type="button"
              onClick={() => {
                onChange({ ...draft, q: q.trim() || undefined });
                setOpen(false);
              }}
              className="rounded-full bg-brand-blue px-4 py-1.5 text-sm font-semibold text-white"
            >
              Search
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
