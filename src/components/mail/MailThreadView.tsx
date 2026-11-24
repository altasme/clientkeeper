// Reading pane: conversation header + toolbar, then every message in the
// thread (collapsible; unread and the newest expanded by default), each
// with an expandable full-header details section, sanitized body,
// attachments, and -- for outbound mail -- honest send status + Retry.

import { useEffect, useState } from "react";
import { ApiError } from "../../lib/api";
import { mailApi, type AttachmentInfo, type Label, type MessageAction, type MessageDetail } from "../../lib/mailApi";
import { copyText, displayAddr, formatBytes, formatFullDate, initials, SEND_STATUS_LABEL } from "../../lib/mailUtils";
import MailAttachmentPreview, { PREVIEWABLE } from "./MailAttachmentPreview";
import MailHtmlBody from "./MailHtmlBody";

interface Props {
  threadId: string;
  context: string;
  labels: Label[];
  canSendFrom: (accountId: string) => boolean;
  accountEmail: (accountId: string) => string;
  showAccount: boolean;
  onBack: () => void;
  onCompose: (mode: "reply" | "reply_all" | "forward", message: MessageDetail) => void;
  onChanged: (opts?: { closeThread?: boolean }) => void;
  onToast: (text: string, tone?: "info" | "error" | "success") => void;
  refreshKey: number;
}

function DetailsTable({ m }: { m: MessageDetail }) {
  const rows: [string, string | null][] = [
    ["From", displayAddr(m.from)],
    ["To", m.to.map(displayAddr).join(", ") || null],
    ["Cc", m.cc.map(displayAddr).join(", ") || null],
    ["Bcc", m.bcc.map(displayAddr).join(", ") || null],
    ["Reply-To", m.replyTo],
    ["Date", formatFullDate(m.date)],
    ["Message-ID", m.messageIdHeader],
    ["In-Reply-To", m.inReplyTo],
    ["References", m.references],
    ["Authentication", m.authResults],
  ];
  return (
    <dl className="mt-2 grid grid-cols-1 gap-x-3 gap-y-1 rounded-lg bg-paper-alt p-3 text-xs sm:grid-cols-[7rem_minmax(0,1fr)]">
      {rows
        .filter(([, v]) => v)
        .map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="font-semibold text-ink/60">{k}</dt>
            <dd className="min-w-0 break-all text-ink/80">{v}</dd>
          </div>
        ))}
    </dl>
  );
}

export function detailsText(m: MessageDetail): string {
  return [
    `From: ${displayAddr(m.from)}`,
    `To: ${m.to.map(displayAddr).join(", ")}`,
    m.cc.length ? `Cc: ${m.cc.map(displayAddr).join(", ")}` : "",
    m.replyTo ? `Reply-To: ${m.replyTo}` : "",
    `Date: ${formatFullDate(m.date)}`,
    `Subject: ${m.subject}`,
    m.messageIdHeader ? `Message-ID: ${m.messageIdHeader}` : "",
    m.inReplyTo ? `In-Reply-To: ${m.inReplyTo}` : "",
    m.references ? `References: ${m.references}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function MessageItem({
  m,
  expanded,
  onToggle,
  labels,
  props,
  onRemoteImages,
  onPreview,
  reload,
}: {
  m: MessageDetail;
  expanded: boolean;
  onToggle: () => void;
  labels: Label[];
  props: Props;
  onRemoteImages: () => void;
  onPreview: (a: AttachmentInfo) => void;
  reload: () => void;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const msgLabels = labels.filter((l) => m.labelIds.includes(l.id));
  const canSend = props.canSendFrom(m.accountId);

  const act = async (action: MessageAction, msg?: string) => {
    try {
      await mailApi.bulk([m.id], action);
      if (msg) props.onToast(msg, "success");
      props.onChanged();
      reload();
    } catch (err) {
      props.onToast(err instanceof ApiError ? err.message : "Action failed.", "error");
    }
  };

  const retry = async () => {
    setRetrying(true);
    try {
      const r = await mailApi.retrySend(m.id);
      props.onToast(r.status === "sent" ? "Accepted by the mail server." : r.status === "retry_scheduled" ? "Still failing; another retry is scheduled." : `Send failed: ${r.error ?? "unknown error"}`, r.status === "sent" ? "success" : "error");
      reload();
      props.onChanged();
    } catch (err) {
      props.onToast(err instanceof ApiError ? err.message : "Retry failed.", "error");
    } finally {
      setRetrying(false);
    }
  };

  if (!expanded) {
    return (
      <button type="button" onClick={onToggle} className="flex w-full min-w-0 items-center gap-3 border-b border-ink/10 px-4 py-3 text-left hover:bg-paper-alt">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-blue/10 text-xs font-bold text-brand-navy">{initials(m.from)}</span>
        <span className={`w-32 shrink-0 truncate text-sm ${m.isRead ? "text-ink/70" : "font-bold text-ink"}`}>{m.from.name || m.from.email}</span>
        <span className="min-w-0 flex-1 truncate text-sm text-ink/60">{m.snippet}</span>
        <span className="shrink-0 text-xs text-ink/60">{formatFullDate(m.date)}</span>
      </button>
    );
  }

  return (
    <article className="border-b border-ink/10 px-4 py-4">
      <div className="flex min-w-0 items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-gradient text-sm font-bold text-white">{initials(m.from)}</span>
        <div className="min-w-0 flex-1">
          <button type="button" onClick={onToggle} className="block w-full min-w-0 text-left">
            <p className="truncate text-sm">
              <span className="font-semibold text-ink">{m.from.name || m.from.email}</span>{" "}
              {m.from.name && <span className="text-ink/60">&lt;{m.from.email}&gt;</span>}
            </p>
          </button>
          <p className="truncate text-xs text-ink/60">
            to {[...m.to, ...m.cc].map((a) => a.name || a.email).join(", ") || "(undisclosed)"}
            {props.showAccount && <> · via {props.accountEmail(m.accountId)}</>}
          </p>
          <button type="button" onClick={() => setShowDetails((s) => !s)} className="text-xs font-semibold text-brand-blue hover:underline" aria-expanded={showDetails}>
            {showDetails ? "Hide details" : "Show details"}
          </button>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="text-xs text-ink/60">{formatFullDate(m.date)}</span>
          <button type="button" aria-label={m.isStarred ? "Unstar" : "Star"} aria-pressed={m.isStarred} onClick={() => void act(m.isStarred ? "unstar" : "star")} className={`text-lg leading-none ${m.isStarred ? "text-amber-500" : "text-ink/30 hover:text-ink/60"}`}>
            {m.isStarred ? "★" : "☆"}
          </button>
        </div>
      </div>
      {showDetails && <DetailsTable m={m} />}

      {msgLabels.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {msgLabels.map((l) => (
            <span key={l.id} className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold text-white" style={{ backgroundColor: l.color }}>
              {l.name}
              <button type="button" aria-label={`Remove label ${l.name}`} onClick={() => mailApi.bulk([m.id], "removeLabel", l.id).then(() => { props.onChanged(); reload(); })} className="text-white/80 hover:text-white">
                &times;
              </button>
            </span>
          ))}
        </div>
      )}

      {m.direction === "outbound" && m.sendJob && m.sendJob.status !== "sent" && (
        <div className={`mt-3 flex flex-wrap items-center gap-2 rounded-lg px-3 py-2 text-xs ${m.sendJob.status === "failed" ? "bg-red-50 text-red-800" : "bg-amber-50 text-amber-900"}`}>
          <span className="font-semibold">{SEND_STATUS_LABEL[m.sendJob.status] ?? m.sendJob.status}</span>
          {m.sendJob.status === "retry_scheduled" && m.sendJob.nextRetryAt && <span>· next attempt {formatFullDate(m.sendJob.nextRetryAt)}</span>}
          <span>· {m.sendJob.attempts} attempt{m.sendJob.attempts === 1 ? "" : "s"}</span>
          {m.sendJob.lastError && <span className="w-full break-words">{m.sendJob.lastError}</span>}
          {(m.sendJob.status === "failed" || m.sendJob.status === "retry_scheduled") && canSend && (
            <button type="button" disabled={retrying} onClick={() => void retry()} className="rounded-full bg-white px-3 py-1 font-semibold text-brand-navy ring-1 ring-ink/15 disabled:opacity-50">
              {retrying ? "Retrying…" : "Retry now"}
            </button>
          )}
        </div>
      )}
      {m.direction === "outbound" && m.sendJob?.status === "sent" && <p className="mt-2 text-[11px] text-ink/60">Accepted by the mail server (delivery to the recipient's inbox isn't confirmed by SMTP).</p>}

      {m.remoteImagesBlocked > 0 && !m.remoteImagesShown && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-paper-alt px-3 py-2 text-xs text-ink/70">
          <span>{m.remoteImagesBlocked} remote image{m.remoteImagesBlocked === 1 ? " was" : "s were"} blocked to protect your privacy (they can track when you open an email).</span>
          {m.remoteImagePolicy === "block" && (
            <button type="button" onClick={onRemoteImages} className="font-semibold text-brand-blue hover:underline">
              Load remote images
            </button>
          )}
        </div>
      )}

      <div className="mt-3 min-w-0">
        <MailHtmlBody html={m.bodyHtml} text={m.bodyText} remoteAllowed={m.remoteImagesShown} />
      </div>

      {m.attachments.length > 0 && (
        <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {m.attachments.map((a) => (
            <li key={a.id} className="flex min-w-0 items-center gap-2 rounded-lg border border-ink/10 px-3 py-2 text-xs">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold text-ink">{a.filename}</span>
                <span className="text-ink/60">{a.available ? formatBytes(a.size) : "Not available (failed to store on arrival)"}</span>
              </span>
              {a.available && PREVIEWABLE.has(a.mimeType) && (
                <button type="button" onClick={() => onPreview(a)} className="shrink-0 font-semibold text-brand-blue hover:underline">
                  Preview
                </button>
              )}
              {a.available && (
                <a href={mailApi.downloadUrl(a.id)} className="shrink-0 font-semibold text-brand-blue hover:underline">
                  Download
                </a>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        {canSend && (
          <>
            <button type="button" onClick={() => props.onCompose("reply", m)} className="rounded-full border border-ink/15 px-4 py-1.5 text-sm font-semibold text-ink/80 hover:bg-paper-alt">↩ Reply</button>
            <button type="button" onClick={() => props.onCompose("reply_all", m)} className="rounded-full border border-ink/15 px-4 py-1.5 text-sm font-semibold text-ink/80 hover:bg-paper-alt">↩↩ Reply all</button>
            <button type="button" onClick={() => props.onCompose("forward", m)} className="rounded-full border border-ink/15 px-4 py-1.5 text-sm font-semibold text-ink/80 hover:bg-paper-alt">↪ Forward</button>
          </>
        )}
        <button type="button" onClick={() => void act(m.isRead ? "markUnread" : "markRead")} className="rounded-full px-3 py-1.5 text-sm text-ink/70 hover:bg-paper-alt">
          Mark {m.isRead ? "unread" : "read"}
        </button>
        <button type="button" onClick={() => copyText(m.from.email).then((ok) => props.onToast(ok ? "Sender email copied." : "Couldn't copy.", ok ? "success" : "error"))} className="rounded-full px-3 py-1.5 text-sm text-ink/70 hover:bg-paper-alt">
          Copy sender
        </button>
        <button type="button" onClick={() => copyText(detailsText(m)).then((ok) => props.onToast(ok ? "Message details copied." : "Couldn't copy.", ok ? "success" : "error"))} className="rounded-full px-3 py-1.5 text-sm text-ink/70 hover:bg-paper-alt">
          Copy details
        </button>
        {m.direction === "inbound" && (
          <a href={mailApi.rawUrl(m.id)} className="rounded-full px-3 py-1.5 text-sm text-ink/70 hover:bg-paper-alt">
            Download original
          </a>
        )}
      </div>
    </article>
  );
}

export default function MailThreadView(props: Props) {
  const { threadId, context, labels, onBack, onChanged, onToast, refreshKey } = props;
  const [data, setData] = useState<{ subject: string; accountId: string; messages: MessageDetail[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [remote, setRemote] = useState(false);
  const [preview, setPreview] = useState<AttachmentInfo | null>(null);
  const [labelMenu, setLabelMenu] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    setRemote(false);
    setData(null);
  }, [threadId]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    mailApi
      .thread(threadId, context, remote)
      .then(async (t) => {
        if (cancelled) return;
        setData(t);
        setExpanded((prev) => {
          if (prev.size && t.messages.some((m) => prev.has(m.id))) return prev;
          const s = new Set(t.messages.filter((m) => !m.isRead).map((m) => m.id));
          const last = t.messages[t.messages.length - 1];
          if (last) s.add(last.id);
          return s;
        });
        const unread = t.messages.filter((m) => !m.isRead).map((m) => m.id);
        if (unread.length) {
          await mailApi.bulk(unread, "markRead").catch(() => undefined);
          onChanged();
        }
      })
      .catch((err) => !cancelled && setError(err instanceof ApiError ? err.message : "Couldn't load this conversation."));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, context, remote, nonce, refreshKey]);

  const ids = data?.messages.map((m) => m.id) ?? [];
  const latest = data?.messages[data.messages.length - 1];
  const allStarred = !!data?.messages.length && data.messages.every((m) => m.isStarred);
  const threadLabels = labels.filter((l) => l.accountId === data?.accountId);

  const threadAction = async (action: MessageAction, msg: string, close = false, labelId?: string) => {
    if (!ids.length) return;
    if (action === "deleteForever" && !window.confirm("Permanently delete this conversation? This can't be undone.")) return;
    try {
      await mailApi.bulk(ids, action, labelId);
      onToast(msg, "success");
      onChanged({ closeThread: close });
      if (!close) setNonce((n) => n + 1);
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : "Action failed.", "error");
    }
  };

  const btn = "rounded-lg px-2.5 py-1.5 text-sm text-ink/70 hover:bg-paper-alt hover:text-ink";

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <div className="sticky top-0 z-10 flex shrink-0 flex-wrap items-center gap-1 border-b border-ink/10 bg-white px-2 py-1.5">
        <button type="button" onClick={onBack} className={`${btn} font-semibold`} aria-label="Back to list">
          ← <span className="hidden sm:inline">Back</span>
        </button>
        <span className="mx-1 h-5 w-px bg-ink/10" />
        {context === "trash" ? (
          <>
            <button type="button" className={btn} onClick={() => void threadAction("restore", "Restored.", true)}>Restore</button>
            <button type="button" className={`${btn} text-red-700`} onClick={() => void threadAction("deleteForever", "Deleted forever.", true)}>Delete forever</button>
          </>
        ) : (
          <>
            {context === "archive" ? (
              <button type="button" className={btn} onClick={() => void threadAction("moveToInbox", "Moved to Inbox.", true)}>Move to Inbox</button>
            ) : (
              <button type="button" className={btn} onClick={() => void threadAction("archive", "Archived.", true)}>Archive</button>
            )}
            {context === "junk" ? (
              <button type="button" className={btn} onClick={() => void threadAction("notJunk", "Moved out of Junk.", true)}>Not junk</button>
            ) : (
              latest?.direction === "inbound" && <button type="button" className={btn} onClick={() => void threadAction("junk", "Moved to Junk.", true)}>Junk</button>
            )}
            <button type="button" className={btn} onClick={() => void threadAction("trash", "Moved to Trash.", true)}>Delete</button>
          </>
        )}
        <button type="button" className={btn} onClick={() => void threadAction("markUnread", "Marked unread.", true)}>Mark unread</button>
        <button type="button" className={btn} aria-pressed={allStarred} onClick={() => void threadAction(allStarred ? "unstar" : "star", allStarred ? "Unstarred." : "Starred.")}>
          {allStarred ? "★ Unstar" : "☆ Star"}
        </button>
        <div className="relative">
          <button type="button" className={btn} aria-expanded={labelMenu} onClick={() => setLabelMenu((s) => !s)}>Label ▾</button>
          {labelMenu && (
            <div className="absolute left-0 top-full z-20 mt-1 w-56 rounded-xl border border-ink/10 bg-white p-1 shadow-lg">
              {threadLabels.length === 0 && <p className="px-3 py-2 text-xs text-ink/60">No labels in this mailbox yet. Create one from the sidebar.</p>}
              {threadLabels.map((l) => {
                const applied = data?.messages.some((m) => m.labelIds.includes(l.id));
                return (
                  <button
                    key={l.id}
                    type="button"
                    onClick={() => {
                      setLabelMenu(false);
                      void threadAction(applied ? "removeLabel" : "applyLabel", applied ? `Removed "${l.name}".` : `Labeled "${l.name}".`, false, l.id);
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-paper-alt"
                  >
                    <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: l.color }} />
                    <span className="min-w-0 flex-1 truncate">{l.name}</span>
                    {applied && <span className="text-brand-blue">✓</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <p className="p-6 text-sm text-red-700">{error}</p>
        ) : !data ? (
          <p className="p-6 text-sm text-ink/60">Loading conversation…</p>
        ) : data.messages.length === 0 ? (
          <p className="p-6 text-sm text-ink/60">This conversation has no messages in this folder any more.</p>
        ) : (
          <>
            <h2 className="break-words px-4 pb-2 pt-4 text-lg font-bold text-brand-navy">{data.subject || "(no subject)"}</h2>
            {data.messages.map((m) => (
              <MessageItem
                key={m.id}
                m={m}
                labels={labels}
                props={props}
                expanded={expanded.has(m.id)}
                onToggle={() => setExpanded((s) => {
                  const n = new Set(s);
                  if (n.has(m.id)) n.delete(m.id);
                  else n.add(m.id);
                  return n;
                })}
                onRemoteImages={() => setRemote(true)}
                onPreview={setPreview}
                reload={() => setNonce((n) => n + 1)}
              />
            ))}
          </>
        )}
      </div>
      {preview && <MailAttachmentPreview attachment={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}
