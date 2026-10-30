import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  fetchProposalDetail,
  updateProposalDraft,
  publishProposal,
  revokeProposal,
  fetchQuestionnaires,
  type ProposalDetail,
  type ProposalStatus,
  type QuestionnaireListRow,
} from "../lib/api";
import RichTextEditor from "../components/RichTextEditor";

const STATUS_STYLES: Record<ProposalStatus, string> = {
  draft: "bg-ink/10 text-ink/60",
  published: "bg-blue-100 text-blue-700",
  sent: "bg-blue-100 text-blue-700",
  signed: "bg-green-100 text-green-700",
  declined: "bg-red-100 text-red-700",
  expired: "bg-ink/10 text-ink/60",
  revoked: "bg-red-100 text-red-700",
};

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl border border-ink/10 bg-white p-5">
      <h2 className="text-sm font-bold uppercase tracking-wide text-ink/50">{title}</h2>
      <div className="mt-3">{children}</div>
    </div>
  );
}

export default function ProposalEditorPage() {
  // [2026-10-15] Flat route (/proposals/:proposalId) -- a proposal can
  // now belong to a client or a lead (CLAUDE.md §25), so there's no
  // single parent id to carry in the URL anymore. Which parent it has
  // (proposal.clientId / proposal.leadId) comes back from the detail
  // fetch itself and drives the "back to..." link and the
  // questionnaire-link card below.
  const { proposalId } = useParams<{ proposalId: string }>();
  const [proposal, setProposal] = useState<ProposalDetail | null>(null);
  const [questionnaires, setQuestionnaires] = useState<QuestionnaireListRow[]>([]);
  const [title, setTitle] = useState("");
  const [contentHtml, setContentHtml] = useState("");
  const [questionnaireId, setQuestionnaireId] = useState<string>("");
  // [2026-10-29] Payment-request fields, CLAUDE.md §27 -- shown on the
  // public payment screen the client lands on right after signing.
  const [paymentEnabled, setPaymentEnabled] = useState(true);
  const [paymentAmountLabel, setPaymentAmountLabel] = useState("");
  const [paymentGcashNumber, setPaymentGcashNumber] = useState("");
  const [paymentGcashAccountName, setPaymentGcashAccountName] = useState("");
  const [paymentBankNote, setPaymentBankNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);
  const [preview, setPreview] = useState(false);

  const load = () => {
    if (!proposalId) return;
    fetchProposalDetail(proposalId)
      .then((p) => {
        setProposal(p);
        setTitle(p.title);
        setContentHtml(p.contentHtml);
        setQuestionnaireId(p.questionnaireId ?? "");
        setPaymentEnabled(p.paymentEnabled);
        setPaymentAmountLabel(p.paymentAmountLabel);
        setPaymentGcashNumber(p.paymentGcashNumber);
        setPaymentGcashAccountName(p.paymentGcashAccountName);
        setPaymentBankNote(p.paymentBankNote);
        // Questionnaires are always client-scoped (schema.sql's
        // questionnaires.client_id stays NOT NULL) -- a lead-backed
        // proposal has nothing valid to list here.
        if (p.clientId) fetchQuestionnaires(p.clientId).then(setQuestionnaires).catch(() => {});
      })
      .catch((err) => setError(err.message));
  };

  useEffect(load, [proposalId]);

  // Editing is always allowed, even once signed -- publishing a revision
  // of a signed proposal resets status to "published" and preserves the
  // original signature as a historical record (see publish.ts), rather
  // than editing being blocked outright.
  const signed = proposal?.status === "signed";

  const handleSave = async () => {
    if (!proposalId) return;
    setSaving(true);
    setError(null);
    try {
      await updateProposalDraft(proposalId, {
        title,
        contentHtml,
        questionnaireId: questionnaireId || null,
        paymentEnabled,
        paymentAmountLabel,
        paymentGcashNumber,
        paymentGcashAccountName,
        paymentBankNote,
      });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the draft.");
    } finally {
      setSaving(false);
    }
  };

  const handlePublish = async () => {
    if (!proposalId) return;
    setPublishing(true);
    setError(null);
    try {
      await handleSave();
      await publishProposal(proposalId);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't publish.");
    } finally {
      setPublishing(false);
    }
  };

  const handleRevoke = async () => {
    if (!proposalId) return;
    try {
      await revokeProposal(proposalId);
      setConfirmingRevoke(false);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't revoke.");
    }
  };

  const handleCopy = () => {
    if (!proposal) return;
    navigator.clipboard.writeText(proposal.publicUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  // Proposal content is free-form rich text (no fixed layout like the WSA
  // PDFs), so there's no pdf-lib template to overlay. A real print-to-PDF
  // document (window.print(), browser "Save as PDF") is the pragmatic
  // "downloadable signed copy" here -- it renders the exact signed content
  // and signature evidence as a clean, self-contained standalone document,
  // without needing a server-side HTML-to-PDF rendering pipeline Cloudflare
  // Pages Functions can't run (no Node/Chromium in the Workers runtime).
  const handleDownloadSignedCopy = () => {
    if (!proposal || !proposal.signature) return;
    const sig = proposal.signature;
    const win = window.open("", "_blank");
    if (!win) return;
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    win.document.write(`<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${esc(proposal.title)} - Signed Copy</title>
<style>
  body { font-family: -apple-system, Segoe UI, Arial, sans-serif; color: #0a0f1c; max-width: 720px; margin: 2rem auto; padding: 0 1.5rem; }
  h1 { color: #02256f; font-size: 1.6rem; }
  .meta { color: #5b6479; font-size: 0.85rem; margin-bottom: 1.5rem; }
  .content h2 { color: #02256f; font-size: 1.2rem; margin: 1rem 0 0.5rem; }
  .content h3 { color: #02256f; font-size: 1.05rem; margin: 0.85rem 0 0.4rem; }
  .content p { margin: 0.5rem 0; line-height: 1.6; }
  .content ul, .content ol { padding-left: 1.5rem; margin: 0.5rem 0; }
  .content table { border-collapse: collapse; width: 100%; margin: 0.75rem 0; }
  .content table td, .content table th { border: 1px solid #d8dce6; padding: 0.4rem 0.6rem; }
  .sig-block { margin-top: 2.5rem; padding-top: 1.5rem; border-top: 1px solid #d8dce6; }
  .sig-block img { height: 70px; border: 1px solid #d8dce6; border-radius: 6px; padding: 8px; background: #fff; }
  .sig-meta { font-size: 0.8rem; color: #5b6479; margin-top: 0.5rem; }
  @media print { body { margin: 0.5rem auto; } }
</style>
</head>
<body>
  <h1>${esc(proposal.title)}</h1>
  <p class="meta">Signed copy &mdash; generated ${esc(new Date().toLocaleString())}</p>
  <div class="content">${proposal.contentHtml}</div>
  <div class="sig-block">
    <p><strong>Accepted and signed by:</strong> ${esc(sig.signerName)}${sig.signerTitle ? `, ${esc(sig.signerTitle)}` : ""}</p>
    <img src="${sig.signatureDataUrl}" alt="Signature" />
    <p class="sig-meta">Signed on ${esc(new Date(sig.signedAt).toLocaleString())}${sig.ipAddress ? ` from IP ${esc(sig.ipAddress)}` : ""}</p>
  </div>
</body>
</html>`);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 300);
  };

  if (error && !proposal) return <p className="text-sm text-red-600">{error}</p>;
  if (!proposal) return <p className="text-sm text-ink/50">Loading&hellip;</p>;

  return (
    <div className="max-w-3xl">
      {proposal.clientId ? (
        <Link to={`/clients/${proposal.clientId}`} className="text-xs font-semibold text-ink/50 hover:text-ink">
          &larr; Back to client
        </Link>
      ) : proposal.leadId ? (
        <Link to={`/leads/${proposal.leadId}`} className="text-xs font-semibold text-ink/50 hover:text-ink">
          &larr; Back to lead
        </Link>
      ) : (
        <Link to="/leads" className="text-xs font-semibold text-ink/50 hover:text-ink">
          &larr; Back to leads
        </Link>
      )}

      {!proposal.clientId && !proposal.leadId && (
        // [2026-10-16] A standalone proposal (CLAUDE.md §26) has no lead
        // or client to show a "back to..." link for -- this banner is
        // what tells staff where the prospect info it was created with
        // actually went, and what happens to it on signing.
        <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900">
          <p className="font-semibold">Standalone proposal, no client yet.</p>
          <p className="mt-1">
            {proposal.prospectFullName} &middot; {proposal.prospectBusinessName}
            {proposal.prospectEmail ? ` · ${proposal.prospectEmail}` : ""}
            {proposal.prospectPhone ? ` · ${proposal.prospectPhone}` : ""}
          </p>
          <p className="mt-1 text-blue-700">
            {proposal.prospectEmail
              ? "A real client record is created automatically from this info the moment the prospect signs."
              : "No email was collected for this prospect, so no client record will be created when they sign -- this proposal stays unlinked."}
          </p>
        </div>
      )}

      <div className="mt-2 flex items-start justify-between gap-3">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-transparent bg-transparent text-2xl font-bold text-brand-navy outline-none focus:border-ink/15 focus:bg-white"
        />
        <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide ${STATUS_STYLES[proposal.status]}`}>{proposal.status}</span>
      </div>

      {error && <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="mt-4 grid gap-4">
        {proposal.status !== "draft" && (
          <Card title="Public Link">
            <p className="break-all text-sm text-brand-blue">{proposal.publicUrl}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" onClick={handleCopy} className="rounded-full bg-brand-blue px-4 py-1.5 text-xs font-semibold text-white hover:bg-[#0b57cc]">
                {copied ? "Copied!" : "Copy Link"}
              </button>
              <a href={proposal.publicUrl} target="_blank" rel="noreferrer" className="rounded-full border border-ink/15 px-4 py-1.5 text-xs font-semibold text-brand-navy hover:border-brand-blue hover:text-brand-blue">
                View as Client
              </a>
              {proposal.status !== "revoked" && (
                <button type="button" onClick={() => setConfirmingRevoke(true)} className="rounded-full border border-red-200 px-4 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50">
                  Revoke Link
                </button>
              )}
            </div>
            {confirmingRevoke && (
              <div className="mt-2 rounded-lg border border-red-200 bg-red-50 p-3">
                <p className="text-sm text-red-700">Revoke this proposal's link? The client will no longer be able to view or sign it.</p>
                <div className="mt-2 flex gap-2">
                  <button type="button" onClick={handleRevoke} className="rounded-full bg-red-600 px-3 py-1 text-xs font-semibold text-white hover:bg-red-700">
                    Yes, Revoke
                  </button>
                  <button type="button" onClick={() => setConfirmingRevoke(false)} className="text-xs text-ink/50 hover:text-ink">
                    Never mind
                  </button>
                </div>
              </div>
            )}
          </Card>
        )}

        {proposal.signature && (
          <Card title="Signature">
            <p className="text-sm text-ink/70">
              Signed by <span className="font-semibold text-brand-navy">{proposal.signature.signerName}</span>
              {proposal.signature.signerTitle ? `, ${proposal.signature.signerTitle}` : ""} on {new Date(proposal.signature.signedAt).toLocaleString()}
            </p>
            <img src={proposal.signature.signatureDataUrl} alt="Client signature" className="mt-2 h-20 w-auto rounded border border-ink/10 bg-white p-2" />
            {proposal.signature.ipAddress && <p className="mt-1 text-xs text-ink/40">IP: {proposal.signature.ipAddress}</p>}
            <button
              type="button"
              onClick={handleDownloadSignedCopy}
              className="mt-3 rounded-full border border-ink/15 px-4 py-1.5 text-xs font-semibold text-brand-navy hover:border-brand-blue hover:text-brand-blue"
            >
              Download Signed Copy
            </button>
            {signed && (
              <p className="mt-2 text-xs text-amber-700">
                This record stays exactly as accepted. Editing and publishing a revision below resets status to "Published" and the client must sign again &mdash; it will not alter this signature.
              </p>
            )}
            {proposal.paymentMarkedPaidAt && (
              <p className="mt-2 rounded-lg bg-green-50 px-3 py-2 text-xs font-semibold text-green-800">
                Client marked this as paid on {new Date(proposal.paymentMarkedPaidAt).toLocaleString()}. This is the client's own claim, not a confirmed
                payment &mdash; verify against the actual GCash/bank transfer before treating the project as funded.
              </p>
            )}
          </Card>
        )}

        <Card title="Payment Request">
          <label className="flex items-center gap-2 text-sm font-semibold text-brand-navy">
            <input type="checkbox" checked={paymentEnabled} onChange={(e) => setPaymentEnabled(e.target.checked)} className="h-4 w-4 rounded border-ink/30" />
            Request payment after signing
          </label>
          <p className="mt-1 text-xs text-ink/50">
            When on, the client lands on a payment screen immediately after signing &mdash; the signature is recorded either way, even if they never pay.
          </p>

          {paymentEnabled && (
            <div className="mt-4 grid gap-3">
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink/50">Amount</label>
                <input
                  type="text"
                  value={paymentAmountLabel}
                  onChange={(e) => setPaymentAmountLabel(e.target.value)}
                  placeholder="e.g. ₱25,000"
                  className="w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm"
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink/50">GCash Number</label>
                  <input
                    type="text"
                    value={paymentGcashNumber}
                    onChange={(e) => setPaymentGcashNumber(e.target.value)}
                    className="w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink/50">GCash Account Name</label>
                  <input
                    type="text"
                    value={paymentGcashAccountName}
                    onChange={(e) => setPaymentGcashAccountName(e.target.value)}
                    className="w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm"
                  />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink/50">Bank Transfer Note</label>
                <input
                  type="text"
                  value={paymentBankNote}
                  onChange={(e) => setPaymentBankNote(e.target.value)}
                  placeholder="Bank transfer available upon request."
                  className="w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm"
                />
              </div>
              <p className="text-xs text-ink/50">
                Changes here save with "Save Draft" below and take effect immediately &mdash; no need to publish a new version or ask the client to sign
                again.
              </p>
            </div>
          )}
        </Card>

        {proposal.clientId ? (
          <Card title="Send to Questionnaire After Signing">
            <select
              value={questionnaireId}
              onChange={(e) => setQuestionnaireId(e.target.value)}
              className="w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm"
            >
              <option value="">No questionnaire linked yet</option>
              {questionnaires.map((q) => (
                <option key={q.id} value={q.id}>
                  {q.title} ({q.status})
                </option>
              ))}
            </select>
            <p className="mt-2 text-xs text-ink/50">
              Once this client has a published questionnaire, link it here so a client who signs this proposal is redirected straight to it.
            </p>
          </Card>
        ) : (
          // A lead-backed or standalone proposal has no client yet, and
          // every questionnaire belongs to a client (CLAUDE.md §25/§26)
          // -- there is nothing valid to link here until this prospect
          // becomes a real client (manually, for a lead, or
          // automatically on signing, for a standalone proposal -- but
          // [2026-10-29] only if an email was collected; email is now
          // optional at creation, and sign.ts can't auto-create a
          // client without one, so this copy has to branch on that too,
          // not just on lead vs. standalone).
          <Card title="Send to Questionnaire After Signing">
            <p className="text-xs text-ink/50">
              {proposal.leadId
                ? "This proposal isn't attached to a client yet, so it can't be linked to a questionnaire. Convert this lead to a client first if you need that."
                : proposal.prospectEmail
                  ? "This proposal isn't attached to a client yet, so it can't be linked to a questionnaire. Once the prospect signs, a client is created automatically and you can link one then."
                  : "This proposal isn't attached to a client yet, so it can't be linked to a questionnaire. No email was collected for this prospect, so signing won't create a client either -- create one manually afterward if you need to link a questionnaire."}
            </p>
          </Card>
        )}

        <Card title="Proposal Content">
          <div className="flex items-center justify-end gap-2 pb-2">
            <button type="button" onClick={() => setPreview((p) => !p)} className="text-xs font-semibold text-brand-blue hover:underline">
              {preview ? "Edit" : "Preview"}
            </button>
          </div>
          {preview ? (
            <div className="proposal-content rounded-lg border border-ink/10 bg-paper-alt p-4 text-sm" dangerouslySetInnerHTML={{ __html: contentHtml }} />
          ) : (
            <RichTextEditor value={contentHtml} onChange={setContentHtml} placeholder="Write the proposal here..." />
          )}
        </Card>

        {proposal.versions.length > 0 && (
          <Card title="Version History">
            <ul className="space-y-1 text-sm text-ink/60">
              {proposal.versions.map((v) => (
                <li key={v.id}>
                  v{v.versionNumber} &mdash; published {new Date(v.createdAt).toLocaleString()}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        <button type="button" disabled={saving} onClick={handleSave} className="rounded-full border border-ink/15 px-5 py-2 text-sm font-semibold text-brand-navy hover:border-brand-blue hover:text-brand-blue disabled:opacity-50">
          {saving ? "Saving..." : "Save Draft"}
        </button>
        <button type="button" disabled={publishing} onClick={handlePublish} className="rounded-full bg-brand-blue px-5 py-2 text-sm font-semibold text-white hover:bg-[#0b57cc] disabled:opacity-50">
          {publishing ? "Publishing..." : proposal.status === "draft" ? "Publish" : signed ? "Publish Revision (resets signature)" : "Publish Revision"}
        </button>
      </div>
    </div>
  );
}
