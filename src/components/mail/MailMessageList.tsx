// Conversation list with multi-select + bulk actions, load-more
// pagination, and loading / empty / error states.

import type { ReactNode } from "react";
import type { Label, MessageAction, ThreadRow } from "../../lib/mailApi";
import { formatListDate, shortName } from "../../lib/mailUtils";

interface Props {
  folder: string;
  threads: ThreadRow[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  selected: Set<string>;
  activeThreadId: string | null;
  labels: Label[];
  density: "comfortable" | "compact";
  showAccount: boolean;
  accountEmail: (id: string) => string;
  highlight: string;
  emptyText: string;
  onSelectToggle: (threadId: string) => void;
  onSelectAll: (all: boolean) => void;
  onOpen: (row: ThreadRow) => void;
  onBulk: (action: MessageAction, labelId?: string) => void;
  onStar: (row: ThreadRow) => void;
  onLoadMore: () => void;
  onRetry: () => void;
  onRefresh: () => void;
  refreshing: boolean;
}

function Highlight({ text, term }: { text: string; term: string }): ReactNode {
  const words = term.split(/\s+/).filter((w) => w.length > 1).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words.length) return text;
  const parts = text.split(new RegExp(`(${words.join("|")})`, "gi"));
  return parts.map((p, i) => (i % 2 === 1 ? <mark key={i} className="rounded bg-amber-200/70 px-0.5 text-inherit">{p}</mark> : p));
}

export default function MailMessageList(p: Props) {
  const allSelected = p.threads.length > 0 && p.threads.every((t) => p.selected.has(t.threadId));
  const selCount = p.selected.size;
  const btn = "rounded-lg px-2.5 py-1.5 text-xs font-semibold text-ink/70 hover:bg-paper-alt hover:text-ink";
  const pad = p.density === "compact" ? "py-1.5" : "py-3";

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-ink/10 px-2 py-1.5">
        <input type="checkbox" aria-label={allSelected ? "Deselect all" : "Select all"} checked={allSelected} onChange={(e) => p.onSelectAll(e.target.checked)} className="mx-2 h-4 w-4 accent-brand-blue" />
        {selCount > 0 ? (
          <>
            <span className="mr-1 text-xs text-ink/60">{selCount} selected</span>
            <button type="button" className={btn} onClick={() => p.onBulk("markRead")}>Read</button>
            <button type="button" className={btn} onClick={() => p.onBulk("markUnread")}>Unread</button>
            <button type="button" className={btn} onClick={() => p.onBulk("star")}>Star</button>
            <button type="button" className={btn} onClick={() => p.onBulk("unstar")}>Unstar</button>
            {p.folder === "trash" ? (
              <>
                <button type="button" className={btn} onClick={() => p.onBulk("restore")}>Restore</button>
                <button type="button" className={`${btn} text-red-700`} onClick={() => p.onBulk("deleteForever")}>Delete forever</button>
              </>
            ) : (
              <>
                {p.folder === "junk" ? (
                  <button type="button" className={btn} onClick={() => p.onBulk("notJunk")}>Not junk</button>
                ) : (
                  <button type="button" className={btn} onClick={() => p.onBulk("junk")}>Junk</button>
                )}
                {p.folder === "archive" ? (
                  <button type="button" className={btn} onClick={() => p.onBulk("moveToInbox")}>To Inbox</button>
                ) : (
                  <button type="button" className={btn} onClick={() => p.onBulk("archive")}>Archive</button>
                )}
                <button type="button" className={btn} onClick={() => p.onBulk("trash")}>Delete</button>
              </>
            )}
            {p.labels.length > 0 && (
              <select
                aria-label="Apply label"
                value=""
                onChange={(e) => {
                  if (e.target.value) p.onBulk("applyLabel", e.target.value);
                }}
                className="rounded-lg border border-ink/15 bg-white px-2 py-1 text-xs"
              >
                <option value="">Apply label…</option>
                {p.labels.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            )}
          </>
        ) : (
          <button type="button" className={btn} onClick={p.onRefresh} disabled={p.refreshing} aria-label="Refresh">
            {p.refreshing ? "Refreshing…" : "↻ Refresh"}
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {p.error ? (
          <div className="p-6 text-sm">
            <p className="text-red-700">{p.error}</p>
            <button type="button" onClick={p.onRetry} className="mt-2 font-semibold text-brand-blue hover:underline">Try again</button>
          </div>
        ) : p.loading && !p.threads.length ? (
          <ul aria-label="Loading messages">
            {Array.from({ length: 6 }).map((_, i) => (
              <li key={i} className="flex animate-pulse gap-3 border-b border-ink/5 px-4 py-4">
                <span className="h-4 w-28 rounded bg-ink/10" />
                <span className="h-4 flex-1 rounded bg-ink/5" />
              </li>
            ))}
          </ul>
        ) : !p.threads.length ? (
          <p className="p-10 text-center text-sm text-ink/60">{p.emptyText}</p>
        ) : (
          <ul>
            {p.threads.map((t) => {
              const m = t.latest;
              const unread = t.unreadCount > 0;
              const active = p.activeThreadId === t.threadId;
              const isOutbound = m.direction === "outbound";
              const who = isOutbound ? `To: ${[...m.to, ...m.cc].map(shortName).join(", ") || "(no recipients)"}` : m.from.name || m.from.email;
              const rowLabels = p.labels.filter((l) => t.labelIds.includes(l.id));
              return (
                <li key={t.threadId} className={`group flex min-w-0 items-start gap-2 border-b border-ink/5 px-2 ${pad} ${active ? "bg-brand-blue/10" : unread ? "bg-white" : "bg-paper-alt/50"} hover:bg-brand-blue/5`}>
                  <input type="checkbox" aria-label={`Select conversation ${m.subject || "(no subject)"}`} checked={p.selected.has(t.threadId)} onChange={() => p.onSelectToggle(t.threadId)} className="mx-2 mt-1 h-4 w-4 shrink-0 accent-brand-blue" />
                  <button type="button" aria-label={t.isStarred ? "Unstar" : "Star"} aria-pressed={t.isStarred} onClick={() => p.onStar(t)} className={`mt-0.5 shrink-0 text-base leading-none ${t.isStarred ? "text-amber-500" : "text-ink/25 hover:text-ink/60"}`}>
                    {t.isStarred ? "★" : "☆"}
                  </button>
                  <button type="button" onClick={() => p.onOpen(t)} className="min-w-0 flex-1 text-left">
                    <div className="flex min-w-0 items-baseline gap-2">
                      {unread && <span className="h-2 w-2 shrink-0 rounded-full bg-brand-blue" aria-label="Unread" />}
                      <span className={`min-w-0 flex-1 truncate text-sm ${unread ? "font-bold text-ink" : "text-ink/80"}`} title={isOutbound ? undefined : m.from.email}>
                        <Highlight text={who} term={p.highlight} />
                        {t.threadMessageCount > 1 && <span className="ml-1 text-xs font-normal text-ink/60">({t.threadMessageCount})</span>}
                      </span>
                      {t.hasAttachments && <span className="shrink-0 text-xs text-ink/60" aria-label="Has attachments">📎</span>}
                      <span className={`shrink-0 text-xs ${unread ? "font-semibold text-ink" : "text-ink/60"}`}>{formatListDate(t.latestAt)}</span>
                    </div>
                    <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
                      {t.failedSend && <span className="shrink-0 rounded bg-red-100 px-1.5 text-[10px] font-bold uppercase text-red-700">Failed</span>}
                      {t.pendingSend && !t.failedSend && <span className="shrink-0 rounded bg-amber-100 px-1.5 text-[10px] font-bold uppercase text-amber-800">Sending</span>}
                      {p.showAccount && <span className="shrink-0 rounded bg-ink/5 px-1.5 text-[10px] font-semibold text-ink/60">{p.accountEmail(m.accountId).split("@")[0]}</span>}
                      {rowLabels.map((l) => (
                        <span key={l.id} className="shrink-0 rounded px-1.5 text-[10px] font-semibold text-white" style={{ backgroundColor: l.color }}>{l.name}</span>
                      ))}
                      <span className={`min-w-0 truncate text-sm ${unread ? "font-semibold text-ink" : "text-ink/80"}`}>
                        <Highlight text={m.subject || "(no subject)"} term={p.highlight} />
                      </span>
                    </div>
                    {p.density === "comfortable" && (
                      <p className="mt-0.5 truncate text-xs text-ink/60">
                        <Highlight text={m.snippet} term={p.highlight} />
                      </p>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {p.hasMore && (
          <div className="p-4 text-center">
            <button type="button" onClick={p.onLoadMore} disabled={p.loading} className="rounded-full border border-ink/15 px-4 py-2 text-sm font-semibold text-ink/70 hover:bg-paper-alt disabled:opacity-50">
              {p.loading ? "Loading…" : "Load more"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
