// The composer: From identity, recipient chips, subject, rich (or plain)
// body, attachments, autosave, send. Floating panel on desktop (minimize /
// maximize), full-screen with sticky controls on mobile.
//
// Draft safety (spec §9): every draft exists in D1 from the moment the
// composer opens (POST /drafts). Edits autosave ~1.5 s after typing stops
// (and immediately on close), with an optimistic-concurrency `version` so
// a second tab can't silently overwrite this one (409 -> the user chooses).
// Every keystroke is also mirrored to localStorage, so a failed save or a
// crash never loses typed content; the backup is offered back on reopen.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import RichTextEditor from "../RichTextEditor";
import { ApiError } from "../../lib/api";
import { mailApi, newIdempotencyKey, type Addr, type AttachmentInfo, type Draft, type Identity, type MailPolicy, type SendResult } from "../../lib/mailApi";
import { formatBytes, htmlToPlainText, isValidEmail, plainTextToHtml } from "../../lib/mailUtils";
import RecipientInput from "./RecipientInput";

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error" | "conflict";

interface Props {
  draft: Draft;
  identities: Identity[];
  policy: MailPolicy;
  format: "rich" | "plain";
  autosave: boolean;
  onClose: (result?: { sent?: SendResult; discarded?: boolean }) => void;
  onToast: (text: string, tone?: "info" | "error" | "success") => void;
}

const backupKey = (id: string) => `ck-mail-draft-backup:${id}`;

interface Fields {
  accountId: string;
  to: Addr[];
  cc: Addr[];
  bcc: Addr[];
  subject: string;
  bodyHtml: string;
}

function readBackup(id: string): (Fields & { savedAt: number }) | null {
  try {
    const raw = localStorage.getItem(backupKey(id));
    return raw ? (JSON.parse(raw) as Fields & { savedAt: number }) : null;
  } catch {
    return null;
  }
}

function swapSignature(html: string, signatureHtml: string): string {
  const doc = new DOMParser().parseFromString(`<div id="root">${html}</div>`, "text/html");
  const root = doc.getElementById("root")!;
  const existing = root.querySelector("[data-mail-signature]");
  const block = signatureHtml ? `<div data-mail-signature="1"><br>-- <br>${signatureHtml}</div>` : "";
  if (existing) {
    if (block) existing.outerHTML = block;
    else existing.remove();
  } else if (block) {
    const quote = root.querySelector("blockquote");
    if (quote?.previousElementSibling) quote.previousElementSibling.insertAdjacentHTML("beforebegin", block);
    else root.insertAdjacentHTML("beforeend", block);
  }
  return root.innerHTML;
}

export default function MailComposer({ draft, identities, policy, format, autosave, onClose, onToast }: Props) {
  const sendable = identities.filter((i) => i.canSend && i.outboundEnabled && i.isActive);
  const [fields, setFields] = useState<Fields>({ accountId: draft.accountId, to: draft.to, cc: draft.cc, bcc: draft.bcc, subject: draft.subject, bodyHtml: draft.bodyHtml });
  const [plainText, setPlainText] = useState(() => htmlToPlainText(draft.bodyHtml));
  const [attachments, setAttachments] = useState<AttachmentInfo[]>(draft.attachments);
  const [uploads, setUploads] = useState<{ name: string; error?: string }[]>([]);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [showCc, setShowCc] = useState(draft.cc.length > 0);
  const [showBcc, setShowBcc] = useState(draft.bcc.length > 0);
  const [view, setView] = useState<"normal" | "min" | "max">("normal");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backup, setBackup] = useState(() => {
    const b = readBackup(draft.id);
    return b && b.savedAt > Date.parse(draft.updatedAt) && (b.bodyHtml !== draft.bodyHtml || b.subject !== draft.subject) ? b : null;
  });

  const versionRef = useRef(draft.version);
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;
  const savingRef = useRef<Promise<boolean> | null>(null);
  const dirtyRef = useRef(false);
  const idempotencyKey = useRef(newIdempotencyKey());
  const fileInput = useRef<HTMLInputElement>(null);
  const editorWrap = useRef<HTMLDivElement>(null);
  const caretPlaced = useRef(false);
  const pointerDown = useRef(false);

  // The body starts with an empty paragraph, then the signature, then (for
  // replies/forwards) the quoted original. On the first focus, put the caret
  // in that leading paragraph -- otherwise a click on the empty area lands
  // after the signature and the user ends up typing inside it.
  const placeCaretAtTop = () => {
    if (caretPlaced.current) return;
    caretPlaced.current = true;
    const editable = editorWrap.current?.querySelector<HTMLElement>("[contenteditable]");
    const first = editable?.firstElementChild;
    if (!editable || !first || first.hasAttribute("data-mail-signature")) return;
    const range = document.createRange();
    range.selectNodeContents(first);
    range.collapse(true);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  };
  useEffect(() => {
    if (draft.composeMode === "reply" || draft.composeMode === "reply_all") {
      const editable = editorWrap.current?.querySelector<HTMLElement>("[contenteditable]");
      if (editable) {
        editable.focus();
        placeCaretAtTop();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const currentHtml = useCallback((f: Fields) => (format === "plain" ? plainTextToHtml(plainTextRef.current) : f.bodyHtml), [format]);
  const plainTextRef = useRef(plainText);
  plainTextRef.current = plainText;

  const saveNow = useCallback(async (): Promise<boolean> => {
    if (savingRef.current) await savingRef.current;
    if (!dirtyRef.current) return true;
    const f = fieldsRef.current;
    dirtyRef.current = false;
    setSaveState("saving");
    const p = mailApi
      .saveDraft(draft.id, { version: versionRef.current, accountId: f.accountId, to: f.to, cc: f.cc, bcc: f.bcc, subject: f.subject, bodyHtml: currentHtml(f) })
      .then((saved) => {
        versionRef.current = saved.version;
        try {
          localStorage.removeItem(backupKey(draft.id));
        } catch {
          /* storage unavailable */
        }
        setSaveState(dirtyRef.current ? "dirty" : "saved");
        return true;
      })
      .catch((err) => {
        dirtyRef.current = true;
        if (err instanceof ApiError && err.status === 409) {
          setSaveState("conflict");
          const v = err.body?.currentVersion;
          if (typeof v === "number") pendingVersion.current = v;
        } else {
          setSaveState("error");
        }
        return false;
      })
      .finally(() => {
        savingRef.current = null;
      });
    savingRef.current = p;
    return p;
  }, [draft.id, currentHtml]);
  const pendingVersion = useRef<number | null>(null);

  // Mark dirty + local backup on every change; debounce the server save.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    dirtyRef.current = true;
    setSaveState((s) => (s === "conflict" ? s : "dirty"));
    try {
      localStorage.setItem(backupKey(draft.id), JSON.stringify({ ...fields, bodyHtml: currentHtml(fields), savedAt: Date.now() }));
    } catch {
      /* storage unavailable: server autosave still runs */
    }
    if (!autosave) return;
    const t = setTimeout(() => {
      if (saveStateRef.current !== "conflict") void saveNow();
    }, 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields, plainText]);
  const saveStateRef = useRef(saveState);
  saveStateRef.current = saveState;

  // Save when the tab is hidden / page is being closed.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden" && dirtyRef.current) void saveNow();
    };
    const onUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        void saveNow();
        e.preventDefault();
      }
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("beforeunload", onUnload);
    };
  }, [saveNow]);

  const update = (patch: Partial<Fields>) => setFields((f) => ({ ...f, ...patch }));

  const changeIdentity = (accountId: string) => {
    const ident = identities.find((i) => i.id === accountId);
    const isReply = draft.composeMode === "reply" || draft.composeMode === "reply_all";
    const sig = ident?.signatures.find((s) => (isReply ? s.useForReply : s.useForNew));
    update({ accountId, bodyHtml: swapSignature(fields.bodyHtml, sig?.bodyHtml ?? "") });
  };

  const resolveConflict = async (keepMine: boolean) => {
    if (keepMine) {
      if (pendingVersion.current !== null) versionRef.current = pendingVersion.current;
      dirtyRef.current = true;
      setSaveState("dirty");
      await saveNow();
    } else {
      const fresh = await mailApi.draft(draft.id);
      versionRef.current = fresh.version;
      dirtyRef.current = false;
      firstRender.current = true;
      setFields({ accountId: fresh.accountId, to: fresh.to, cc: fresh.cc, bcc: fresh.bcc, subject: fresh.subject, bodyHtml: fresh.bodyHtml });
      setPlainText(htmlToPlainText(fresh.bodyHtml));
      setAttachments(fresh.attachments);
      setSaveState("saved");
    }
  };

  const totalBytes = attachments.reduce((s, a) => s + a.size, 0);
  const onFiles = async (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      if (attachments.length + 1 > policy.maxAttachmentCount) {
        setUploads((u) => [...u, { name: file.name, error: `At most ${policy.maxAttachmentCount} attachments.` }]);
        break;
      }
      if (file.size > policy.maxAttachmentBytes) {
        setUploads((u) => [...u, { name: file.name, error: `Larger than ${formatBytes(policy.maxAttachmentBytes)}.` }]);
        continue;
      }
      setUploads((u) => [...u, { name: file.name }]);
      try {
        const att = await mailApi.upload(draft.id, file);
        setAttachments((a) => [...a, att]);
        setUploads((u) => u.filter((x) => x.name !== file.name || x.error));
      } catch (err) {
        const msg = err instanceof ApiError ? err.message : "Upload failed.";
        setUploads((u) => u.map((x) => (x.name === file.name && !x.error ? { ...x, error: msg } : x)));
      }
    }
    if (fileInput.current) fileInput.current.value = "";
  };

  const removeAttachment = async (id: string) => {
    try {
      await mailApi.removeAttachment(id);
      setAttachments((a) => a.filter((x) => x.id !== id));
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : "Couldn't remove attachment.", "error");
    }
  };

  const allRecipients = useMemo(() => [...fields.to, ...fields.cc, ...fields.bcc], [fields.to, fields.cc, fields.bcc]);
  const invalid = allRecipients.filter((r) => !isValidEmail(r.email));

  const send = async () => {
    setError(null);
    if (!allRecipients.length) return setError("Add at least one recipient.");
    if (invalid.length) return setError(`Fix the invalid address${invalid.length > 1 ? "es" : ""}: ${invalid.map((r) => r.email).join(", ")}`);
    if (allRecipients.length > policy.maxRecipients) return setError(`At most ${policy.maxRecipients} recipients per message.`);
    if (uploads.some((u) => !u.error)) return setError("Wait for attachments to finish uploading.");
    if (!fields.subject.trim() && !window.confirm("Send this message without a subject?")) return;
    setSending(true);
    try {
      dirtyRef.current = true;
      const ok = await saveNow();
      if (!ok) {
        setError("Couldn't save the latest changes before sending. Check your connection and try again.");
        return;
      }
      const result = await mailApi.sendDraft(draft.id, idempotencyKey.current);
      try {
        localStorage.removeItem(backupKey(draft.id));
      } catch {
        /* ignore */
      }
      onClose({ sent: result });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't send. Your draft is saved.");
    } finally {
      setSending(false);
    }
  };

  const close = async () => {
    await saveNow();
    onClose();
  };

  const discard = async () => {
    if (!window.confirm("Discard this draft? This can't be undone.")) return;
    try {
      await mailApi.deleteDraft(draft.id);
      try {
        localStorage.removeItem(backupKey(draft.id));
      } catch {
        /* ignore */
      }
      onClose({ discarded: true });
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : "Couldn't discard the draft.", "error");
    }
  };

  const statusText: Record<SaveState, string> = { idle: "", dirty: autosave ? "Unsaved…" : "Unsaved changes", saving: "Saving…", saved: "Saved", error: "Unable to save", conflict: "Changed elsewhere" };
  const title = fields.subject.trim() || (draft.composeMode === "forward" ? "Forward" : draft.composeMode === "new" ? "New message" : "Reply");

  const frame =
    view === "min"
      ? "fixed bottom-0 right-4 z-[60] w-72 rounded-t-xl shadow-2xl"
      : view === "max"
        ? "fixed inset-0 z-[60] md:inset-6 md:rounded-xl shadow-2xl"
        : "fixed inset-0 z-[60] md:inset-auto md:bottom-0 md:right-4 md:h-[min(640px,90vh)] md:w-[600px] md:rounded-t-xl shadow-2xl";

  return (
    <section role="dialog" aria-label={title} className={`${frame} flex flex-col overflow-hidden border border-ink/15 bg-white`} onKeyDown={(e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void send();
      }
    }}>
      <header className="flex shrink-0 items-center gap-2 bg-brand-navy-deep px-3 py-2 text-white">
        <button type="button" onClick={() => setView(view === "min" ? "normal" : "min")} className="min-w-0 flex-1 truncate text-left text-sm font-semibold">
          {title}
        </button>
        <span className={`hidden text-[11px] sm:inline ${saveState === "error" || saveState === "conflict" ? "text-red-300" : "text-white/60"}`} aria-live="polite">
          {statusText[saveState]}
        </span>
        <button type="button" aria-label={view === "min" ? "Restore" : "Minimize"} onClick={() => setView(view === "min" ? "normal" : "min")} className="hidden rounded px-1.5 text-white/70 hover:bg-white/10 md:inline">
          {view === "min" ? "▴" : "▁"}
        </button>
        <button type="button" aria-label={view === "max" ? "Exit full screen" : "Full screen"} onClick={() => setView(view === "max" ? "normal" : "max")} className="hidden rounded px-1.5 text-white/70 hover:bg-white/10 md:inline">
          {view === "max" ? "⤡" : "⤢"}
        </button>
        <button type="button" aria-label="Save and close" onClick={close} className="rounded px-1.5 text-lg leading-none text-white/80 hover:bg-white/10">
          &times;
        </button>
      </header>

      {view !== "min" && (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {backup && (
              <div className="flex flex-wrap items-center gap-2 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                <span className="flex-1">Unsaved changes from an earlier session were found on this device.</span>
                <button type="button" className="font-semibold underline" onClick={() => {
                  setFields({ accountId: backup.accountId, to: backup.to, cc: backup.cc, bcc: backup.bcc, subject: backup.subject, bodyHtml: backup.bodyHtml });
                  setPlainText(htmlToPlainText(backup.bodyHtml));
                  setBackup(null);
                }}>
                  Restore them
                </button>
                <button type="button" className="underline" onClick={() => setBackup(null)}>
                  Ignore
                </button>
              </div>
            )}
            {saveState === "conflict" && (
              <div className="flex flex-wrap items-center gap-2 bg-red-50 px-3 py-2 text-xs text-red-800">
                <span className="flex-1">This draft was changed in another tab or device.</span>
                <button type="button" className="font-semibold underline" onClick={() => void resolveConflict(true)}>Keep this version</button>
                <button type="button" className="underline" onClick={() => void resolveConflict(false)}>Load the other version</button>
              </div>
            )}
            {saveState === "error" && (
              <div className="flex items-center gap-2 bg-red-50 px-3 py-2 text-xs text-red-800">
                <span className="flex-1">Unable to save. Your text is kept on this device.</span>
                <button type="button" className="font-semibold underline" onClick={() => { dirtyRef.current = true; void saveNow(); }}>Retry save</button>
              </div>
            )}

            <div className="flex items-center gap-2 border-b border-ink/10 px-3 py-1.5">
              <label htmlFor={`from-${draft.id}`} className="w-10 shrink-0 text-xs font-semibold text-ink/60">From</label>
              <select id={`from-${draft.id}`} value={fields.accountId} onChange={(e) => changeIdentity(e.target.value)} className="min-w-0 flex-1 bg-transparent py-1 text-sm focus:outline-none">
                {sendable.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.displayName} &lt;{i.emailAddress}&gt;{i.smtpStatus !== "configured" ? " (sending not configured)" : ""}
                  </option>
                ))}
              </select>
              <div className="flex shrink-0 gap-2 text-xs font-semibold text-brand-blue">
                {!showCc && <button type="button" onClick={() => setShowCc(true)}>Cc</button>}
                {!showBcc && <button type="button" onClick={() => setShowBcc(true)}>Bcc</button>}
              </div>
            </div>
            <RecipientInput label="To" value={fields.to} onChange={(to) => update({ to })} autoFocus={draft.composeMode === "new" || draft.composeMode === "forward"} />
            {showCc && <RecipientInput label="Cc" value={fields.cc} onChange={(cc) => update({ cc })} />}
            {showBcc && <RecipientInput label="Bcc" value={fields.bcc} onChange={(bcc) => update({ bcc })} />}
            <div className="border-b border-ink/10 px-3">
              <input aria-label="Subject" placeholder="Subject" value={fields.subject} maxLength={900} onChange={(e) => update({ subject: e.target.value })} className="w-full bg-transparent py-2 text-sm font-medium focus:outline-none" />
            </div>

            <div
              className="p-2"
              ref={editorWrap}
              // Pointer: wait for the click to finish setting its own
              // selection, then move the caret. Keyboard (Tab) focus: move now.
              onPointerDown={() => (pointerDown.current = true)}
              onPointerUp={(e) => {
                pointerDown.current = false;
                if ((e.target as HTMLElement).closest("[contenteditable]")) placeCaretAtTop();
              }}
              onFocus={(e) => {
                if (!pointerDown.current && (e.target as HTMLElement).isContentEditable) placeCaretAtTop();
              }}
            >
              {format === "plain" ? (
                <textarea aria-label="Message" value={plainText} onChange={(e) => setPlainText(e.target.value)} className="min-h-[260px] w-full resize-y rounded-lg border border-ink/15 p-3 text-sm focus:outline-none" />
              ) : (
                <RichTextEditor value={fields.bodyHtml} onChange={(bodyHtml) => update({ bodyHtml })} toolbar="mail" minHeightClass="min-h-[240px]" placeholder="Write your message" />
              )}
            </div>

            {(attachments.length > 0 || uploads.length > 0) && (
              <ul className="space-y-1 px-3 pb-3">
                {attachments.map((a) => (
                  <li key={a.id} className="flex items-center gap-2 rounded-lg bg-paper-alt px-3 py-1.5 text-xs">
                    <span className="min-w-0 flex-1 truncate font-medium">{a.filename}</span>
                    <span className="shrink-0 text-ink/60">{formatBytes(a.size)}</span>
                    <button type="button" aria-label={`Remove ${a.filename}`} onClick={() => void removeAttachment(a.id)} className="shrink-0 text-ink/60 hover:text-red-700">&times;</button>
                  </li>
                ))}
                {uploads.map((u, i) => (
                  <li key={`${u.name}-${i}`} className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs ${u.error ? "bg-red-50 text-red-800" : "bg-paper-alt text-ink/60"}`}>
                    <span className="min-w-0 flex-1 truncate">{u.name}</span>
                    <span className="shrink-0">{u.error ?? "Uploading…"}</span>
                    {u.error && <button type="button" aria-label="Dismiss" onClick={() => setUploads((x) => x.filter((_, j) => j !== i))}>&times;</button>}
                  </li>
                ))}
                <li className="px-1 text-[11px] text-ink/60">{formatBytes(totalBytes)} of {formatBytes(policy.maxTotalAttachmentBytes)}</li>
              </ul>
            )}
            {error && <p role="alert" className="px-3 pb-3 text-sm text-red-700">{error}</p>}
          </div>

          <footer className="flex shrink-0 items-center gap-2 border-t border-ink/10 bg-white px-3 py-2" style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}>
            <button type="button" onClick={() => void send()} disabled={sending || !sendable.length} className="rounded-full bg-brand-blue px-5 py-2 text-sm font-semibold text-white hover:bg-[#0b57cc] disabled:opacity-50">
              {sending ? "Sending…" : "Send"}
            </button>
            <input ref={fileInput} type="file" multiple className="hidden" onChange={(e) => void onFiles(e.target.files)} />
            <button type="button" onClick={() => fileInput.current?.click()} className="rounded-full border border-ink/15 px-3 py-2 text-sm text-ink/70 hover:bg-paper-alt" aria-label="Attach files">
              📎 <span className="hidden sm:inline">Attach</span>
            </button>
            <button type="button" onClick={() => { dirtyRef.current = true; void saveNow(); }} className="rounded-full border border-ink/15 px-3 py-2 text-sm text-ink/70 hover:bg-paper-alt">
              Save
            </button>
            <span className="ml-auto text-[11px] text-ink/60 sm:hidden" aria-live="polite">{statusText[saveState]}</span>
            <button type="button" onClick={() => void discard()} className="rounded-full px-3 py-2 text-sm text-red-700 hover:bg-red-50 sm:ml-auto">
              Discard
            </button>
          </footer>
        </>
      )}
    </section>
  );
}
