// /mail/connect -- where a user of a client's OWN admin panel lands after
// clicking "Mail" there (Webmail Connect, CLAUDE.md §38). Rendered OUTSIDE
// MeProvider (no staff bootstrap) and talks ONLY to /api/mail-connect
// through lib/connectMailApi.ts.
//
// What it shows, from the live grants /me returns:
//   - zero usable grants -> "No email account has been assigned to your
//     profile..." (or "temporarily unavailable" when grants exist but every
//     mailbox is suspended/removed), never a broken redirect;
//   - one mailbox -> opened directly, no switcher;
//   - several -> the default (else the first) opens, with a switcher limited
//     to exactly those mailboxes. The switcher is the staff MailSidebar's
//     pattern (a <select> of addresses when there's more than one, a plain
//     address when there's one, selection kept in the URL), minus the staff
//     "All mailboxes (unified)" option: permissions differ per mailbox here,
//     so every view is one mailbox.
//   - "Back to <panel>" is a link the person chooses, never an automatic
//     redirect.
// The mailbox workspace is the same component as /mail/client.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ApiError } from "../lib/api";
import { connectMailApi, safeReturnUrl, type ConnectSession } from "../lib/connectMailApi";
import OwnerMailWorkspace from "../components/mail/OwnerMailWorkspace";
import RichTextEditor from "../components/RichTextEditor";

type State = { kind: "loading" } | { kind: "signed_out"; reason: "link" | "ended" } | { kind: "error" } | { kind: "ready"; session: ConnectSession };

function Notice(props: { title: string; body: string; back?: { url: string; name: string } | null }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-paper-alt p-6">
      <div className="max-w-md rounded-2xl border border-ink/10 bg-white p-6 text-center">
        <h1 className="text-lg font-bold text-brand-navy">{props.title}</h1>
        <p className="mt-2 text-sm text-ink/70">{props.body}</p>
        {props.back && (
          <a href={props.back.url} className="mt-4 inline-block rounded-full bg-brand-blue px-4 py-2 text-sm font-semibold text-white">
            Back to {props.back.name}
          </a>
        )}
      </div>
    </div>
  );
}

export default function MailConnectPage() {
  const [params, setParams] = useSearchParams();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [signatureOpen, setSignatureOpen] = useState(false);

  const load = useCallback(() => {
    connectMailApi
      .me()
      .then((s) => setState(s ? { kind: "ready", session: s } : { kind: "signed_out", reason: params.get("error") === "link" ? "link" : "ended" }))
      .catch(() => setState({ kind: "error" }));
    // Only the initial load reads ?error=; later reloads don't need it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(load, [load]);

  const handleAuth = useCallback((err: unknown) => {
    if (err instanceof ApiError && err.status === 401) {
      setState({ kind: "signed_out", reason: "ended" });
      return true;
    }
    // A mailbox that was revoked mid-session answers 404: re-read the live grants.
    if (err instanceof ApiError && err.status === 404 && err.message === "Mailbox not found.") {
      load();
      return true;
    }
    return false;
  }, [load]);

  const session = state.kind === "ready" ? state.session : null;
  const requested = params.get("mailbox");
  const current = useMemo(() => {
    if (!session || !session.mailboxes.length) return null;
    return session.mailboxes.find((m) => m.id === requested) ?? session.mailboxes.find((m) => m.isDefault) ?? session.mailboxes[0]!;
  }, [session, requested]);
  const api = useMemo(() => (current ? connectMailApi.forMailbox(current.id) : null), [current]);

  if (state.kind === "loading") return <div className="flex min-h-screen items-center justify-center text-sm text-ink/50">Loading…</div>;
  if (state.kind === "error") return <Notice title="Mail is unavailable right now" body="We couldn't load your mailbox. Please try again in a moment." />;
  if (state.kind === "signed_out") {
    return state.reason === "link" ? (
      <Notice title="This sign-in link is invalid or has expired" body="Go back to your admin panel and click Mail again to open your mailbox." />
    ) : (
      <Notice title="You're signed out of Mail" body="Go back to your admin panel and click Mail to open your mailbox again." />
    );
  }

  const s = state.session;
  const back = safeReturnUrl(s.returnUrl);
  const backLink = back ? { url: back, name: s.integrationName } : null;
  if (!current || !api) {
    return s.unavailableCount > 0 ? (
      <Notice title="Email is temporarily unavailable" body="The email service for your assigned mailbox is currently unavailable. Please contact your administrator." back={backLink} />
    ) : (
      <Notice title="No email account assigned" body="No email account has been assigned to your profile. Please contact your administrator." back={backLink} />
    );
  }

  const signOut = async () => {
    await connectMailApi.logout().catch(() => undefined);
    setState({ kind: "signed_out", reason: "ended" });
  };

  const headerTitle =
    s.mailboxes.length > 1 ? (
      <label className="block max-w-xs">
        <span className="sr-only">Mailbox</span>
        <select value={current.id} onChange={(e) => setParams({ mailbox: e.target.value }, { replace: true })} className="w-full rounded-lg border border-ink/15 bg-white px-2 py-1.5 text-sm font-semibold text-brand-navy">
          {s.mailboxes.map((m) => (
            <option key={m.id} value={m.id}>
              {m.emailAddress}
            </option>
          ))}
        </select>
      </label>
    ) : (
      <>
        <p className="truncate text-sm font-bold text-brand-navy">{current.displayName}</p>
        <p className="truncate text-xs text-ink/60">{current.emailAddress}</p>
      </>
    );

  return (
    <>
      <OwnerMailWorkspace
        key={current.id}
        api={api}
        mailbox={current}
        headerTitle={headerTitle}
        headerActions={
          <>
            {current.canManageSettings && (
              <button type="button" onClick={() => setSignatureOpen(true)} className="hidden rounded-full px-3 py-2 text-sm font-semibold text-ink/70 hover:bg-paper-alt sm:inline-block">
                Signature
              </button>
            )}
            {backLink && (
              <a href={backLink.url} className="hidden rounded-full px-3 py-2 text-sm font-semibold text-brand-blue hover:bg-paper-alt sm:inline-block">
                ← Back to {backLink.name}
              </a>
            )}
          </>
        }
        onSignOut={signOut}
        onAuthError={handleAuth}
      />
      {signatureOpen && <SignatureDialog mailboxId={current.id} address={current.emailAddress} onClose={() => setSignatureOpen(false)} onAuthError={handleAuth} />}
    </>
  );
}

function SignatureDialog(props: { mailboxId: string; address: string; onClose: () => void; onAuthError: (err: unknown) => boolean }) {
  const [name, setName] = useState("Signature");
  const [html, setHtml] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await connectMailApi.createSignature(props.mailboxId, { name, bodyHtml: html, useForNew: true, useForReply: true });
      props.onClose();
    } catch (err) {
      if (!props.onAuthError(err)) setError(err instanceof ApiError ? err.message : "Couldn't save the signature.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/30 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label="Signature">
      <div className="w-full max-w-xl space-y-3 bg-white p-4 shadow-xl sm:rounded-2xl">
        <p className="text-sm font-bold text-brand-navy">New signature for {props.address}</p>
        <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Signature name" className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm outline-none focus:border-brand-blue" />
        <RichTextEditor value={html} onChange={setHtml} toolbar="mail" minHeightClass="min-h-[8rem]" />
        <p className="text-xs text-ink/60">Used automatically on new messages and replies from this mailbox.</p>
        {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <div className="flex gap-2">
          <button type="button" onClick={save} disabled={saving || !name.trim()} className="rounded-full bg-brand-blue px-5 py-2 text-sm font-semibold text-white disabled:opacity-60">
            {saving ? "Saving…" : "Save"}
          </button>
          <button type="button" onClick={props.onClose} className="rounded-full px-3 py-2 text-sm text-ink/70 hover:bg-paper-alt">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
