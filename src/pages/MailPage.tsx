// /mail -- the webmail workspace (CLAUDE.md §32). Its own full-screen shell
// (like the MyCafe workspace), because a three-pane mail client needs the
// width the main sidebar would take.
//
// All view state (mailbox, folder, label, search, open conversation) lives
// in the URL, so Back/Forward work and returning from a conversation keeps
// the search results. Desktop: sidebar | list | reading pane. Below lg:
// one pane at a time (list or conversation) with a drawer sidebar.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ApiError } from "../lib/api";
import { mailApi, type Counts, type Draft, type DraftSummary, type FolderId, type Identity, type Label, type ListFilters, type MailPolicy, type MailUserSettings, type MessageAction, type MessageDetail, type SendResult, type ThreadRow } from "../lib/mailApi";
import { formatListDate } from "../lib/mailUtils";
import MailComposer from "../components/mail/MailComposer";
import MailLabelManager from "../components/mail/MailLabelManager";
import MailMessageList from "../components/mail/MailMessageList";
import MailSearchBar from "../components/mail/MailSearchBar";
import MailSettings from "../components/mail/MailSettings";
import MailSidebar from "../components/mail/MailSidebar";
import MailThreadView from "../components/mail/MailThreadView";
import { ToastStack, useToasts } from "../components/mail/Toasts";

const OPEN_DRAFT_KEY = "ck-mail-open-draft";
const FILTER_KEYS = ["q", "from", "to", "dateFrom", "dateTo", "unread", "starred", "hasAttachments"] as const;

function beep() {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.08, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.25);
  } catch {
    /* audio unavailable */
  }
}

export default function MailPage() {
  const [params, setParams] = useSearchParams();
  const { toasts, push, dismiss } = useToasts();
  const [identities, setIdentities] = useState<Identity[] | null>(null);
  const [settings, setSettings] = useState<MailUserSettings | null>(null);
  const [policy, setPolicy] = useState<MailPolicy | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [labels, setLabels] = useState<Label[]>([]);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [threads, setThreads] = useState<ThreadRow[]>([]);
  const [drafts, setDrafts] = useState<DraftSummary[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [composer, setComposer] = useState<Draft | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const sinceRef = useRef<string | null>(null);
  const notified = useRef(new Set<string>());

  const accountId = params.get("account") || settings?.defaultAccountId || "all";
  const folder = (params.get("folder") || settings?.defaultFolder || "inbox") as FolderId;
  const labelId = params.get("label");
  const threadId = params.get("thread");
  const filters: ListFilters = useMemo(() => {
    const f: ListFilters = {};
    for (const k of FILTER_KEYS) {
      const v = params.get(k);
      if (!v) continue;
      if (k === "unread" || k === "starred" || k === "hasAttachments") f[k] = v === "1";
      else f[k] = v;
    }
    return f;
  }, [params]);
  const searching = Object.values(filters).some(Boolean);
  const filterKey = JSON.stringify(filters);

  const setView = useCallback(
    (patch: Record<string, string | null>, replace = false) => {
      const next = new URLSearchParams(params);
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === "") next.delete(k);
        else next.set(k, v);
      }
      setParams(next, { replace });
    },
    [params, setParams]
  );

  // --- boot
  const loadIdentities = useCallback(() => {
    mailApi.identities().then((r) => setIdentities(r.identities)).catch((err) => setBootError(err instanceof ApiError ? err.message : "Couldn't load your mailboxes."));
  }, []);
  const loadSettings = useCallback(() => {
    mailApi.settings().then((r) => {
      setSettings(r.user);
      setPolicy(r.policy);
    }).catch((err) => setBootError(err instanceof ApiError ? err.message : "Couldn't load mail settings."));
  }, []);
  useEffect(() => {
    loadIdentities();
    loadSettings();
  }, [loadIdentities, loadSettings]);

  // Reopen a composer that was open before a page refresh.
  useEffect(() => {
    let id: string | null = null;
    try {
      id = sessionStorage.getItem(OPEN_DRAFT_KEY);
    } catch {
      /* ignore */
    }
    if (id) mailApi.draft(id).then(setComposer).catch(() => sessionStorage.removeItem(OPEN_DRAFT_KEY));
  }, []);
  useEffect(() => {
    try {
      if (composer) sessionStorage.setItem(OPEN_DRAFT_KEY, composer.id);
      else sessionStorage.removeItem(OPEN_DRAFT_KEY);
    } catch {
      /* ignore */
    }
  }, [composer]);

  const ready = !!identities && !!settings;
  const accountEmail = useCallback((id: string) => identities?.find((i) => i.id === id)?.emailAddress ?? "", [identities]);
  const sendable = useMemo(() => (identities ?? []).filter((i) => i.canSend && i.outboundEnabled && i.isActive), [identities]);
  const scopedLabels = useMemo(() => (accountId === "all" ? labels : labels.filter((l) => l.accountId === accountId)), [labels, accountId]);

  const loadLabels = useCallback(() => {
    if (!ready) return;
    mailApi.labels("all").then((r) => setLabels(r.labels)).catch(() => undefined);
  }, [ready]);
  useEffect(loadLabels, [loadLabels]);

  const loadCounts = useCallback(async () => {
    if (!ready) return;
    try {
      const c = await mailApi.counts(accountId, sinceRef.current ?? undefined);
      setCounts(c);
      const fresh = c.newMessages.filter((m) => !notified.current.has(m.id));
      if (sinceRef.current && fresh.length) {
        fresh.forEach((m) => notified.current.add(m.id));
        const first = fresh[0]!;
        const who = first.fromName || first.fromEmail;
        if (settings?.notifyNewMail) {
          push(fresh.length === 1 ? `New mail from ${who}: ${first.subject || "(no subject)"}` : `${fresh.length} new messages`, "info", {
            label: "Open",
            run: () => setView({ folder: "inbox", label: null, thread: first.threadId }),
          });
        }
        if (settings?.sound) beep();
        if (settings?.desktopNotifications && "Notification" in window && Notification.permission === "granted" && document.visibilityState === "hidden") {
          try {
            new Notification(`New mail from ${who}`, { body: first.subject || "(no subject)", tag: first.id });
          } catch {
            /* ignore */
          }
        }
        if (folder === "inbox" && !selected.size) setRefreshKey((k) => k + 1);
      }
      sinceRef.current = c.serverTime;
    } catch {
      /* transient; next poll retries */
    }
  }, [ready, accountId, settings, push, setView, folder, selected.size]);

  // --- list
  const loadList = useCallback(
    async (offset = 0) => {
      if (!ready) return;
      setLoading(true);
      setListError(null);
      try {
        if (folder === "drafts" && !searching) {
          const r = await mailApi.drafts(accountId);
          setDrafts(r.drafts);
          setThreads([]);
          setHasMore(false);
        } else {
          const r = await mailApi.list({ accountId, folder: labelId ? "all" : folder, labelId, sort: settings?.sortOrder, offset, ...filters });
          setThreads((prev) => (offset ? [...prev, ...r.threads] : r.threads));
          setHasMore(r.hasMore);
        }
      } catch (err) {
        setListError(err instanceof ApiError ? err.message : "Couldn't load messages.");
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ready, accountId, folder, labelId, filterKey, settings?.sortOrder]
  );

  useEffect(() => {
    setSelected(new Set());
    void loadList(0);
  }, [loadList, refreshKey]);
  useEffect(() => {
    void loadCounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, accountId, refreshKey]);

  // --- polling (slower when the tab is hidden; manual refresh always available)
  useEffect(() => {
    if (!ready || !settings) return;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const interval = settings.refreshIntervalSec * 1000 * (document.visibilityState === "hidden" ? 4 : 1);
      timer = setTimeout(async () => {
        await loadCounts();
        tick();
      }, interval);
    };
    tick();
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        clearTimeout(timer);
        void loadCounts();
        tick();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [ready, settings, loadCounts]);

  // --- unread badge in tab title
  useEffect(() => {
    const ids = identities?.map((i) => i.id) ?? [];
    const unread = ids.reduce((s, id) => s + (counts?.accounts[id]?.inbox?.unread ?? 0), 0);
    document.title = settings?.unreadBadge && unread ? `(${unread}) Mail · ClientKeeper` : "Mail · ClientKeeper";
    return () => {
      document.title = "ClientKeeper";
    };
  }, [counts, identities, settings?.unreadBadge]);

  const refreshAll = useCallback(
    (opts?: { closeThread?: boolean }) => {
      if (opts?.closeThread) setView({ thread: null });
      setRefreshKey((k) => k + 1);
    },
    [setView]
  );

  const manualRefresh = async () => {
    setRefreshing(true);
    await Promise.all([loadList(0), loadCounts()]);
    setRefreshing(false);
  };

  // --- actions
  const bulk = async (action: MessageAction, label?: string) => {
    const rows = threads.filter((t) => selected.has(t.threadId));
    const ids = rows.flatMap((t) => t.messageIds);
    if (!ids.length) return;
    if (action === "deleteForever" && !window.confirm(`Permanently delete ${rows.length} conversation${rows.length > 1 ? "s" : ""}? This can't be undone.`)) return;
    try {
      const r = await mailApi.bulk(ids, action, label);
      push(`${r.affected} message${r.affected === 1 ? "" : "s"} updated.`, "success");
      if (rows.some((t) => t.threadId === threadId) && ["archive", "trash", "junk", "notJunk", "restore", "deleteForever", "moveToInbox"].includes(action)) setView({ thread: null });
      refreshAll();
    } catch (err) {
      push(err instanceof ApiError ? err.message : "Action failed.", "error");
    }
  };

  const toggleStar = async (row: ThreadRow) => {
    try {
      await mailApi.bulk(row.messageIds, row.isStarred ? "unstar" : "star");
      setThreads((ts) => ts.map((t) => (t.threadId === row.threadId ? { ...t, isStarred: !t.isStarred } : t)));
      void loadCounts();
    } catch (err) {
      push(err instanceof ApiError ? err.message : "Couldn't update star.", "error");
    }
  };

  const openCompose = async (mode: Draft["composeMode"], source?: MessageDetail) => {
    if (!sendable.length) return push("You don't have send access to any mailbox.", "error");
    if (composer) return push("Finish or close the message you're writing first.", "info");
    const preferred = source?.accountId ?? (accountId !== "all" ? accountId : settings?.defaultAccountId ?? "");
    const from = sendable.find((i) => i.id === preferred) ?? sendable[0]!;
    try {
      setComposer(await mailApi.createDraft({ accountId: from.id, mode, sourceMessageId: source?.id }));
    } catch (err) {
      push(err instanceof ApiError ? err.message : "Couldn't start a message.", "error");
    }
  };

  const onComposerClose = (result?: { sent?: SendResult; discarded?: boolean }) => {
    setComposer(null);
    const s = result?.sent;
    if (s) {
      if (s.status === "sent") push("Message accepted by the mail server.", "success");
      else if (s.status === "retry_scheduled") push(`Couldn't send yet (${s.error ?? "temporary problem"}). It will retry automatically.`, "info");
      else if (s.status === "failed") push(`Send failed: ${s.error ?? "unknown error"}. Open it in Sent to retry.`, "error", { label: "View", run: () => setView({ folder: "sent", label: null, thread: s.threadId }) });
      else push("Message queued.", "info");
    } else if (result?.discarded) push("Draft discarded.", "info");
    refreshAll();
  };

  // --- render
  if (bootError) return <div className="flex min-h-screen items-center justify-center p-6 text-sm text-red-700">{bootError}</div>;
  if (!identities || !settings || !policy) return <div className="flex min-h-screen items-center justify-center text-sm text-ink/60">Loading mail…</div>;

  const readingRight = settings.readingPane === "right";
  const showThread = !!threadId;
  const folderLabel = labelId ? labels.find((l) => l.id === labelId)?.name ?? "Label" : folder[0]!.toUpperCase() + folder.slice(1);
  const emptyText = searching ? "No messages match your search." : folder === "inbox" ? "Your inbox is empty." : `Nothing in ${folderLabel}.`;

  const sidebar = (
    <MailSidebar
      identities={identities}
      accountId={accountId}
      folder={folder}
      labelId={labelId}
      labels={scopedLabels}
      counts={counts}
      canCompose={sendable.length > 0}
      onAccount={(id) => { setView({ account: id, thread: null, label: null }); setDrawer(false); }}
      onFolder={(f) => { setView({ folder: f, label: null, thread: null }); setDrawer(false); }}
      onLabel={(id) => { setView({ label: id, thread: null }); setDrawer(false); }}
      onCompose={() => { setDrawer(false); void openCompose("new"); }}
      onManageLabels={() => setLabelsOpen(true)}
      onSettings={() => { setDrawer(false); setSettingsOpen(true); }}
    />
  );

  const listPane =
    folder === "drafts" && !searching ? (
      <div className="flex h-full min-h-0 flex-col bg-white">
        <div className="border-b border-ink/10 px-4 py-2.5 text-xs text-ink/60">Your drafts (only you can see them)</div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {listError ? <p className="p-6 text-sm text-red-700">{listError}</p> : loading && !drafts.length ? <p className="p-6 text-sm text-ink/60">Loading…</p> : drafts.length === 0 ? <p className="p-10 text-center text-sm text-ink/60">No drafts.</p> : (
            <ul>
              {drafts.map((d) => (
                <li key={d.id}>
                  <button type="button" onClick={() => (composer ? push("Finish or close the message you're writing first.") : mailApi.draft(d.id).then(setComposer).catch((err) => push(err instanceof ApiError ? err.message : "Couldn't open draft.", "error")))} className="flex w-full min-w-0 flex-col gap-0.5 border-b border-ink/5 px-4 py-3 text-left hover:bg-brand-blue/5">
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="shrink-0 text-xs font-bold uppercase text-red-700">Draft</span>
                      <span className="min-w-0 flex-1 truncate text-sm text-ink/80">{d.to.map((a) => a.name || a.email).join(", ") || "(no recipients)"}</span>
                      {d.attachmentCount > 0 && <span className="text-xs">📎</span>}
                      <span className="shrink-0 text-xs text-ink/60">{formatListDate(d.updatedAt)}</span>
                    </span>
                    <span className="truncate text-sm font-medium">{d.subject || "(no subject)"}</span>
                    <span className="truncate text-xs text-ink/60">{d.snippet}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    ) : (
      <MailMessageList
        folder={labelId ? "all" : folder}
        threads={threads}
        loading={loading}
        error={listError}
        hasMore={hasMore}
        selected={selected}
        activeThreadId={threadId}
        labels={scopedLabels}
        density={settings.density}
        showAccount={accountId === "all" && identities.length > 1}
        accountEmail={accountEmail}
        highlight={filters.q ?? ""}
        emptyText={emptyText}
        onSelectToggle={(id) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; })}
        onSelectAll={(all) => setSelected(all ? new Set(threads.map((t) => t.threadId)) : new Set())}
        onOpen={(row) => setView({ thread: row.threadId })}
        onBulk={(a, l) => void bulk(a, l)}
        onStar={(row) => void toggleStar(row)}
        onLoadMore={() => void loadList(threads.length)}
        onRetry={() => void loadList(0)}
        onRefresh={() => void manualRefresh()}
        refreshing={refreshing}
      />
    );

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-paper-alt">
      <header className="flex shrink-0 items-center gap-2 border-b border-ink/10 bg-white px-3 py-2">
        <button type="button" onClick={() => setDrawer(true)} aria-label="Open mail folders" className="rounded-lg border border-ink/15 p-2 text-ink/70 md:hidden">☰</button>
        <Link to="/" className="hidden shrink-0 text-xs font-semibold text-brand-blue hover:underline sm:inline">← ClientKeeper</Link>
        <h1 className="shrink-0 text-base font-bold text-brand-navy">Mail</h1>
        {identities.length > 0 && <MailSearchBar value={filters} onChange={(f) => setView({ ...Object.fromEntries(FILTER_KEYS.map((k) => [k, null])), ...Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v === true ? "1" : v ? String(v) : null])), thread: null })} />}
      </header>

      {identities.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="max-w-md rounded-2xl border border-ink/10 bg-white p-6 text-center">
            <h2 className="text-lg font-bold text-brand-navy">No mailbox access yet</h2>
            <p className="mt-2 text-sm text-ink/60">Mailbox access is granted per person. Ask an owner or admin to give you access in Mail settings → Mailboxes & access.</p>
            <button type="button" onClick={() => setSettingsOpen(true)} className="mt-4 rounded-full bg-brand-blue px-5 py-2 text-sm font-semibold text-white">Open mail settings</button>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {drawer && <div className="fixed inset-0 z-40 bg-black/40 md:hidden" onClick={() => setDrawer(false)} aria-hidden="true" />}
          <aside className={`fixed inset-y-0 left-0 z-50 w-72 -translate-x-full border-r border-ink/10 bg-white transition-transform duration-200 md:static md:z-auto md:w-60 md:shrink-0 md:translate-x-0 ${drawer ? "translate-x-0" : ""}`}>
            {sidebar}
          </aside>
          <main className="flex min-h-0 min-w-0 flex-1">
            <section aria-label={`${folderLabel} messages`} className={`min-h-0 min-w-0 border-r border-ink/10 ${showThread ? (readingRight ? "hidden lg:block lg:w-[400px] lg:shrink-0 xl:w-[460px]" : "hidden") : readingRight ? "flex-1 lg:w-[400px] lg:flex-none lg:shrink-0 xl:w-[460px]" : "flex-1"}`}>
              {listPane}
            </section>
            <section aria-label="Conversation" className={`min-h-0 min-w-0 flex-1 ${showThread ? "block" : readingRight ? "hidden lg:block" : "hidden"}`}>
              {showThread ? (
                <MailThreadView
                  threadId={threadId!}
                  context={labelId ? "inbox" : folder}
                  labels={labels}
                  canSendFrom={(id) => !!identities.find((i) => i.id === id)?.canSend}
                  accountEmail={accountEmail}
                  showAccount={identities.length > 1}
                  onBack={() => setView({ thread: null })}
                  onCompose={(mode, m) => void openCompose(mode, m)}
                  onChanged={(o) => { void loadCounts(); if (o?.closeThread) refreshAll(o); else void loadList(0); }}
                  onToast={push}
                  refreshKey={refreshKey}
                />
              ) : (
                <div className="flex h-full items-center justify-center bg-white text-sm text-ink/60">Select a conversation to read it.</div>
              )}
            </section>
          </main>
        </div>
      )}

      {!composer && sendable.length > 0 && !showThread && (
        <button type="button" onClick={() => void openCompose("new")} aria-label="Compose" className="fixed bottom-5 right-5 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-brand-blue text-2xl text-white shadow-xl md:hidden" style={{ marginBottom: "env(safe-area-inset-bottom)" }}>
          ✎
        </button>
      )}

      {composer && <MailComposer key={composer.id} draft={composer} identities={identities} policy={policy} format={settings.composerFormat} autosave={settings.autosave} onClose={onComposerClose} onToast={push} />}
      <MailLabelManager open={labelsOpen} onClose={() => setLabelsOpen(false)} identities={identities} labels={labels} defaultAccountId={accountId} onChanged={() => { loadLabels(); void loadCounts(); }} />
      {settingsOpen && <MailSettings identities={identities} onClose={() => setSettingsOpen(false)} onChanged={() => { loadIdentities(); loadSettings(); }} />}
      <ToastStack toasts={toasts} dismiss={dismiss} />
    </div>
  );
}
