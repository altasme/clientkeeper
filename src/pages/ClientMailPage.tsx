// /mail/client -- a client's own mailbox (CLAUDE.md §36). Rendered OUTSIDE
// MeProvider (no staff auth bootstrap) and talks ONLY to /api/mail-client
// through lib/clientMailApi.ts.
//
// Reuses only presentational mail components that hold no data-fetching or
// staff assumptions: MailHtmlBody (sandboxed body iframe), RecipientInput,
// RichTextEditor and Toasts. The staff MailThreadView/MailComposer/
// MailMessageList are NOT reused: they call the staff mailApi directly
// (bulk actions, labels, drafts, uploads, retry) or expose staff-only
// actions, none of which exist for a mailbox owner.
//
// Deliberately absent (server has no such routes for mailbox owners):
// drafts/autosave, attachment upload, labels, settings, signatures editing,
// permanent delete. A forward doesn't carry the original's attachments.

import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError } from "../lib/api";
import { clientMailApi, type ClientFolder, type ClientMailbox, type ClientThread, type ComposeMode, type ComposePrefill } from "../lib/clientMailApi";
import { newIdempotencyKey, type Addr, type MessageDetail, type ThreadRow } from "../lib/mailApi";
import { displayAddr, formatBytes, formatFullDate, formatListDate, shortName } from "../lib/mailUtils";
import MailHtmlBody from "../components/mail/MailHtmlBody";
import RecipientInput from "../components/mail/RecipientInput";
import RichTextEditor from "../components/RichTextEditor";
import { ToastStack, useToasts } from "../components/mail/Toasts";

const FOLDERS: { id: ClientFolder; label: string }[] = [
  { id: "inbox", label: "Inbox" },
  { id: "starred", label: "Starred" },
  { id: "sent", label: "Sent" },
  { id: "archive", label: "Archive" },
  { id: "junk", label: "Junk" },
  { id: "trash", label: "Trash" },
];

function errText(err: unknown, fallback: string) {
  return err instanceof ApiError ? err.message : fallback;
}

export default function ClientMailPage() {
  const navigate = useNavigate();
  const { toasts, push, dismiss } = useToasts();
  const [mailbox, setMailbox] = useState<ClientMailbox | null>(null);
  const [folder, setFolder] = useState<ClientFolder>("inbox");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [threads, setThreads] = useState<ThreadRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [composer, setComposer] = useState<ComposePrefill | null>(null);
  const [nonce, setNonce] = useState(0);

  const toLogin = useCallback(() => navigate("/mail/client-login", { replace: true }), [navigate]);
  const handleAuth = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) {
        toLogin();
        return true;
      }
      return false;
    },
    [toLogin]
  );

  useEffect(() => {
    clientMailApi
      .me()
      .then((m) => (m ? setMailbox(m) : toLogin()))
      .catch(() => setListError("Couldn't load your mailbox."));
  }, [toLogin]);

  const load = useCallback(
    async (offset: number) => {
      setLoading(true);
      setListError(null);
      try {
        const r = await clientMailApi.list(folder, search, offset);
        setThreads((prev) => (offset ? [...prev, ...r.threads] : r.threads));
        setHasMore(r.hasMore);
      } catch (err) {
        if (!handleAuth(err)) setListError(errText(err, "Couldn't load messages."));
      } finally {
        setLoading(false);
      }
    },
    [folder, search, handleAuth]
  );

  useEffect(() => {
    if (mailbox) void load(0);
  }, [mailbox, load, nonce]);

  const refresh = () => setNonce((n) => n + 1);

  const openCompose = async (mode: ComposeMode, source?: MessageDetail) => {
    if (composer) return push("Finish or close the message you're writing first.");
    try {
      setComposer(await clientMailApi.prefill(mode, source?.id));
    } catch (err) {
      if (!handleAuth(err)) push(errText(err, "Couldn't start a new message."), "error");
    }
  };

  const signOut = async () => {
    await clientMailApi.logout().catch(() => undefined);
    toLogin();
  };

  if (!mailbox) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-ink/50">{listError ?? "Loading…"}</div>;
  }

  return (
    <div className="flex h-screen min-h-0 flex-col bg-paper-alt">
      <header className="flex shrink-0 items-center gap-3 border-b border-ink/10 bg-white px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold text-brand-navy">{mailbox.displayName}</p>
          <p className="truncate text-xs text-ink/60">{mailbox.emailAddress}</p>
        </div>
        {mailbox.canSend && (
          <button type="button" onClick={() => openCompose("new")} className="rounded-full bg-brand-blue px-4 py-2 text-sm font-semibold text-white">
            Compose
          </button>
        )}
        <button type="button" onClick={signOut} className="rounded-full px-3 py-2 text-sm font-semibold text-ink/70 hover:bg-paper-alt">
          Sign out
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-ink/10 bg-white px-2 py-2 md:w-48 md:flex-col md:border-b-0 md:border-r md:px-3 md:py-4" aria-label="Folders">
          {FOLDERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => {
                setFolder(f.id);
                setSearch("");
                setQuery("");
                setOpenId(null);
              }}
              className={`shrink-0 rounded-lg px-3 py-1.5 text-left text-sm font-semibold ${folder === f.id && !search ? "bg-brand-blue/10 text-brand-blue" : "text-ink/70 hover:bg-paper-alt"}`}
            >
              {f.label}
            </button>
          ))}
        </nav>

        <section className={`flex min-h-0 min-w-0 flex-col bg-white md:w-[24rem] md:border-r md:border-ink/10 ${openId ? "hidden md:flex" : "flex flex-1 md:flex-none"}`}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setSearch(query.trim());
              setOpenId(null);
            }}
            className="flex shrink-0 gap-2 border-b border-ink/10 p-2"
          >
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search mail" aria-label="Search mail" className="min-w-0 flex-1 rounded-lg border border-ink/15 px-3 py-1.5 text-sm outline-none focus:border-brand-blue" />
            {search ? (
              <button type="button" onClick={() => { setSearch(""); setQuery(""); }} className="rounded-lg px-3 text-sm font-semibold text-ink/70 hover:bg-paper-alt">
                Clear
              </button>
            ) : (
              <button type="button" onClick={refresh} className="rounded-lg px-3 text-sm font-semibold text-ink/70 hover:bg-paper-alt">
                Refresh
              </button>
            )}
          </form>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {listError && <p className="p-4 text-sm text-red-700">{listError}</p>}
            {!listError && !loading && threads.length === 0 && <p className="p-6 text-center text-sm text-ink/50">{search ? "No messages match your search." : "Nothing here."}</p>}
            <ul>
              {threads.map((t) => (
                <li key={t.threadId}>
                  <button
                    type="button"
                    onClick={() => setOpenId(t.threadId)}
                    className={`flex w-full min-w-0 flex-col gap-0.5 border-b border-ink/5 px-4 py-3 text-left hover:bg-brand-blue/5 ${openId === t.threadId ? "bg-brand-blue/5" : ""}`}
                  >
                    <span className="flex items-baseline gap-2">
                      <span className={`min-w-0 flex-1 truncate text-sm ${t.unreadCount ? "font-bold text-ink" : "text-ink/80"}`}>
                        {t.latest.direction === "outbound" ? `To: ${t.latest.to.map(shortName).join(", ")}` : shortName(t.latest.from)}
                        {t.threadMessageCount > 1 && <span className="ml-1 text-xs text-ink/50">({t.threadMessageCount})</span>}
                      </span>
                      {t.isStarred && <span className="text-amber-500" aria-label="Starred">★</span>}
                      <span className="shrink-0 text-xs text-ink/50">{formatListDate(t.latestAt)}</span>
                    </span>
                    <span className={`truncate text-sm ${t.unreadCount ? "font-semibold text-ink" : "text-ink/80"}`}>{t.latest.subject || "(no subject)"}</span>
                    <span className="truncate text-xs text-ink/50">{t.latest.snippet}</span>
                  </button>
                </li>
              ))}
            </ul>
            {hasMore && (
              <button type="button" disabled={loading} onClick={() => load(threads.length)} className="w-full py-3 text-sm font-semibold text-brand-blue">
                {loading ? "Loading…" : "Load more"}
              </button>
            )}
          </div>
        </section>

        <main className={`min-h-0 min-w-0 flex-1 overflow-y-auto ${openId ? "block" : "hidden md:block"}`}>
          {openId ? (
            <ThreadPane
              key={openId}
              threadId={openId}
              folder={folder}
              canSend={mailbox.canSend}
              onClose={() => setOpenId(null)}
              onChanged={refresh}
              onCompose={openCompose}
              onAuthError={handleAuth}
              push={push}
            />
          ) : (
            <p className="p-10 text-center text-sm text-ink/40">Select a conversation to read it.</p>
          )}
        </main>
      </div>

      {composer && (
        <Composer
          prefill={composer}
          fromAddress={mailbox.emailAddress}
          onClose={() => setComposer(null)}
          onSent={(r) => {
            setComposer(null);
            refresh();
            if (r.status === "sent") push("Accepted by the mail server.", "success");
            else if (r.status === "failed") push(r.error ? `Sending failed: ${r.error}` : "Sending failed.", "error");
            else push("Your message is queued and will be retried shortly.");
          }}
          onAuthError={handleAuth}
        />
      )}
      <ToastStack toasts={toasts} dismiss={dismiss} />
    </div>
  );
}

function ThreadPane(props: {
  threadId: string;
  folder: ClientFolder;
  canSend: boolean;
  onClose: () => void;
  onChanged: () => void;
  onCompose: (mode: ComposeMode, source: MessageDetail) => void;
  onAuthError: (err: unknown) => boolean;
  push: (text: string, tone?: "info" | "error" | "success") => void;
}) {
  const { threadId, folder, onAuthError, onChanged, push } = props;
  const [thread, setThread] = useState<ClientThread | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [remote, setRemote] = useState(false);

  const load = useCallback(async () => {
    try {
      const t = await clientMailApi.thread(threadId, folder, remote);
      setThread(t);
      const unread = t.messages.filter((m) => !m.isRead);
      if (unread.length) {
        await Promise.all(unread.map((m) => clientMailApi.setFlags(m.id, { isRead: true }).catch(() => undefined)));
        onChanged();
      }
    } catch (err) {
      if (!onAuthError(err)) setError(errText(err, "Couldn't open this conversation."));
    }
  }, [threadId, folder, remote, onAuthError, onChanged]);

  useEffect(() => {
    void load();
    // onChanged changes identity on every list refresh; reload only when the conversation itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, folder, remote]);

  const act = async (fn: () => Promise<unknown>, done: string, closeAfter = false) => {
    try {
      await fn();
      push(done, "success");
      onChanged();
      if (closeAfter) props.onClose();
      else await load();
    } catch (err) {
      if (!onAuthError(err)) push(errText(err, "That didn't work. Please try again."), "error");
    }
  };

  if (error) return <p className="p-6 text-sm text-red-700">{error}</p>;
  if (!thread) return <p className="p-6 text-sm text-ink/50">Loading…</p>;
  const last = thread.messages[thread.messages.length - 1];
  const blocked = thread.messages.some((m) => m.remoteImagesBlocked > 0 && !m.remoteImagesShown && m.remoteImagePolicy === "block");

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-6">
      <div className="flex items-start gap-2">
        <button type="button" onClick={props.onClose} className="rounded-full px-2 py-1 text-sm font-semibold text-ink/70 hover:bg-white md:hidden">
          ← Back
        </button>
        <h2 className="min-w-0 flex-1 break-words text-lg font-bold text-brand-navy">{thread.subject || "(no subject)"}</h2>
      </div>
      {blocked && (
        <button type="button" onClick={() => setRemote(true)} className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-left text-sm text-amber-900">
          Remote images are hidden to protect your privacy. Load remote images
        </button>
      )}
      <div className="mt-4 space-y-4">
        {thread.messages.map((m) => (
          <article key={m.id} className="rounded-2xl border border-ink/10 bg-white p-4">
            <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="font-semibold text-ink">{displayAddr(m.from)}</span>
              <span className="ml-auto text-xs text-ink/50">{formatFullDate(m.date)}</span>
              <span className="w-full truncate text-xs text-ink/60">To: {m.to.map(displayAddr).join(", ")}{m.cc.length ? ` · Cc: ${m.cc.map(displayAddr).join(", ")}` : ""}</span>
            </header>
            {m.direction === "outbound" && m.sendJob && m.sendJob.status !== "sent" && (
              <p className="mt-2 rounded-lg bg-amber-50 px-3 py-1.5 text-xs text-amber-900">
                {m.sendJob.status === "failed" ? `Not sent: ${m.sendJob.lastError ?? "the mail server refused it."}` : "Waiting to be accepted by the mail server…"}
              </p>
            )}
            <div className="mt-3">
              <MailHtmlBody html={m.bodyHtml} text={m.bodyText} remoteAllowed={m.remoteImagesShown} />
            </div>
            {m.attachments.length > 0 && (
              <ul className="mt-3 flex flex-wrap gap-2">
                {m.attachments.map((a) => (
                  <li key={a.id}>
                    {a.available ? (
                      <a href={clientMailApi.downloadUrl(a.id)} className="inline-block rounded-lg border border-ink/10 px-3 py-1.5 text-xs font-semibold text-brand-blue hover:bg-paper-alt">
                        {a.filename} · {formatBytes(a.size)}
                      </a>
                    ) : (
                      <span className="inline-block rounded-lg border border-ink/10 px-3 py-1.5 text-xs text-ink/50">{a.filename} (unavailable)</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-3 flex flex-wrap gap-1 border-t border-ink/5 pt-3">
              <button type="button" onClick={() => act(() => clientMailApi.setFlags(m.id, { isStarred: !m.isStarred }), m.isStarred ? "Unstarred." : "Starred.")} className="rounded-full px-3 py-1.5 text-sm text-ink/70 hover:bg-paper-alt">
                {m.isStarred ? "★ Unstar" : "☆ Star"}
              </button>
              {m.folder !== "archive" && m.folder !== "trash" && (
                <button type="button" onClick={() => act(() => clientMailApi.move(m.id, "archive"), "Archived.", thread.messages.length === 1)} className="rounded-full px-3 py-1.5 text-sm text-ink/70 hover:bg-paper-alt">
                  Archive
                </button>
              )}
              {m.direction === "inbound" && m.folder !== "junk" && (
                <button type="button" onClick={() => act(() => clientMailApi.move(m.id, "junk"), "Moved to Junk.", thread.messages.length === 1)} className="rounded-full px-3 py-1.5 text-sm text-ink/70 hover:bg-paper-alt">
                  Junk
                </button>
              )}
              {m.folder !== "trash" ? (
                <button type="button" onClick={() => act(() => clientMailApi.move(m.id, "trash"), "Moved to Trash.", thread.messages.length === 1)} className="rounded-full px-3 py-1.5 text-sm text-red-700 hover:bg-red-50">
                  Delete
                </button>
              ) : null}
              {(m.folder === "archive" || m.folder === "junk" || m.folder === "trash") && (
                <button type="button" onClick={() => act(() => clientMailApi.move(m.id, "inbox"), "Moved back.", thread.messages.length === 1)} className="rounded-full px-3 py-1.5 text-sm text-ink/70 hover:bg-paper-alt">
                  {m.folder === "archive" ? "Move to Inbox" : "Restore"}
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
      {props.canSend && last && (
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" onClick={() => props.onCompose("reply", last)} className="rounded-full border border-ink/15 bg-white px-4 py-2 text-sm font-semibold text-ink">
            Reply
          </button>
          <button type="button" onClick={() => props.onCompose("reply_all", last)} className="rounded-full border border-ink/15 bg-white px-4 py-2 text-sm font-semibold text-ink">
            Reply all
          </button>
          <button type="button" onClick={() => props.onCompose("forward", last)} className="rounded-full border border-ink/15 bg-white px-4 py-2 text-sm font-semibold text-ink">
            Forward
          </button>
        </div>
      )}
    </div>
  );
}

function Composer(props: {
  prefill: ComposePrefill;
  fromAddress: string;
  onClose: () => void;
  onSent: (r: { status: string; error: string | null }) => void;
  onAuthError: (err: unknown) => boolean;
}) {
  const { prefill } = props;
  const [to, setTo] = useState<Addr[]>(prefill.to);
  const [cc, setCc] = useState<Addr[]>(prefill.cc);
  const [bcc, setBcc] = useState<Addr[]>([]);
  const [showCc, setShowCc] = useState(prefill.cc.length > 0);
  const [subject, setSubject] = useState(prefill.subject);
  const [html, setHtml] = useState(prefill.bodyHtml);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One key per compose session: a double-click or a retried request maps to the same send.
  const [idempotencyKey] = useState(() => newIdempotencyKey());

  const send = async () => {
    if (sending) return;
    if (![...to, ...cc, ...bcc].length) return setError("Add at least one recipient.");
    setSending(true);
    setError(null);
    try {
      const r = await clientMailApi.send({ mode: prefill.mode, to, cc, bcc, subject, html, idempotencyKey, sourceMessageId: prefill.sourceMessageId });
      props.onSent(r);
    } catch (err) {
      if (!props.onAuthError(err)) setError(errText(err, "Couldn't send. Please try again."));
    } finally {
      setSending(false);
    }
  };

  const discard = () => {
    if (window.confirm("Discard this message? It isn't saved anywhere.")) props.onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/30 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label="New message">
      <div className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden bg-white shadow-xl sm:rounded-2xl">
        <div className="flex shrink-0 items-center border-b border-ink/10 px-4 py-2.5">
          <p className="flex-1 text-sm font-bold text-brand-navy">{prefill.mode === "new" ? "New message" : prefill.mode === "forward" ? "Forward" : "Reply"}</p>
          <button type="button" onClick={discard} className="rounded-full px-3 py-1 text-sm text-ink/60 hover:bg-paper-alt" aria-label="Close">
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
          <p className="text-xs text-ink/60">From: {props.fromAddress}</p>
          <RecipientInput label="To" value={to} onChange={setTo} autoFocus={!to.length} />
          {showCc ? (
            <>
              <RecipientInput label="Cc" value={cc} onChange={setCc} />
              <RecipientInput label="Bcc" value={bcc} onChange={setBcc} />
            </>
          ) : (
            <button type="button" onClick={() => setShowCc(true)} className="text-xs font-semibold text-brand-blue">
              Add Cc / Bcc
            </button>
          )}
          <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" aria-label="Subject" className="w-full border-b border-ink/10 py-2 text-sm outline-none focus:border-brand-blue" />
          <RichTextEditor value={html} onChange={setHtml} toolbar="mail" minHeightClass="min-h-[12rem]" />
          {prefill.mode === "forward" && <p className="text-xs text-ink/50">Attachments from the original message aren't included when forwarding from here.</p>}
          {error && (
            <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
              {error}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2 border-t border-ink/10 px-4 py-3">
          <button type="button" onClick={send} disabled={sending} className="rounded-full bg-brand-blue px-5 py-2 text-sm font-semibold text-white disabled:opacity-60">
            {sending ? "Sending…" : "Send"}
          </button>
          <button type="button" onClick={discard} className="rounded-full px-3 py-2 text-sm text-ink/70 hover:bg-paper-alt">
            Discard
          </button>
        </div>
      </div>
    </div>
  );
}
