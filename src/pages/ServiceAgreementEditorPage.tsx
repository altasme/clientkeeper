// Service Agreement Generator editor (CLAUDE.md §29) -- a direct clone
// of ProposalEditorPage.tsx, minus the "Payment Request" card (no
// payment step, the operator's own confirmed decision) and minus the
// "Send to Questionnaire After Signing" card (an intake-questionnaire
// concept that belongs to the proposal that precedes a contract, not
// the contract itself).

import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  fetchServiceAgreementDetail,
  updateServiceAgreementDraft,
  publishServiceAgreement,
  revokeServiceAgreement,
  type ServiceAgreementDetail,
  type ServiceAgreementStatus,
} from "../lib/api";
import RichTextEditor from "../components/RichTextEditor";

const STATUS_STYLES: Record<ServiceAgreementStatus, string> = {
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

export default function ServiceAgreementEditorPage() {
  const { agreementId } = useParams<{ agreementId: string }>();
  const [agreement, setAgreement] = useState<ServiceAgreementDetail | null>(null);
  const [title, setTitle] = useState("");
  const [contentHtml, setContentHtml] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);
  const [preview, setPreview] = useState(false);

  const load = () => {
    if (!agreementId) return;
    fetchServiceAgreementDetail(agreementId)
      .then((a) => {
        setAgreement(a);
        setTitle(a.title);
        setContentHtml(a.contentHtml);
      })
      .catch((err) => setError(err.message));
  };

  useEffect(load, [agreementId]);

  // Editing is always allowed, even once signed -- publishing a revision
  // of a signed agreement resets status to "published" and preserves the
  // original signature as a historical record (see publish.ts), rather
  // than editing being blocked outright.
  const signed = agreement?.status === "signed";

  const handleSave = async () => {
    if (!agreementId) return;
    setSaving(true);
    setError(null);
    try {
      await updateServiceAgreementDraft(agreementId, { title, contentHtml });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the draft.");
    } finally {
      setSaving(false);
    }
  };

  const handlePublish = async () => {
    if (!agreementId) return;
    setPublishing(true);
    setError(null);
    try {
      await handleSave();
      await publishServiceAgreement(agreementId);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't publish.");
    } finally {
      setPublishing(false);
    }
  };

  const handleRevoke = async () => {
    if (!agreementId) return;
    try {
      await revokeServiceAgreement(agreementId);
      setConfirmingRevoke(false);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't revoke.");
    }
  };

  const handleCopy = () => {
    if (!agreement) return;
    navigator.clipboard.writeText(agreement.publicUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  // Agreement content is free-form rich text (no fixed layout like the
  // WSA PDFs), so there's no pdf-lib template to overlay -- same
  // reasoning as ProposalEditorPage's identical button. A real
  // print-to-PDF document (window.print(), browser "Save as PDF") is the
  // pragmatic "downloadable signed copy" here.
  const handleDownloadSignedCopy = () => {
    if (!agreement || !agreement.signature) return;
    const sig = agreement.signature;
    const win = window.open("", "_blank");
    if (!win) return;
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    win.document.write(`<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${esc(agreement.title)} - Signed Copy</title>
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
  <h1>${esc(agreement.title)}</h1>
  <p class="meta">Signed copy &mdash; generated ${esc(new Date().toLocaleString())}</p>
  <div class="content">${agreement.contentHtml}</div>
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

  if (error && !agreement) return <p className="text-sm text-red-600">{error}</p>;
  if (!agreement) return <p className="text-sm text-ink/50">Loading&hellip;</p>;

  return (
    <div className="max-w-3xl">
      {agreement.clientId ? (
        <Link to={`/clients/${agreement.clientId}`} className="text-xs font-semibold text-ink/50 hover:text-ink">
          &larr; Back to client
        </Link>
      ) : agreement.leadId ? (
        <Link to={`/leads/${agreement.leadId}`} className="text-xs font-semibold text-ink/50 hover:text-ink">
          &larr; Back to lead
        </Link>
      ) : (
        <Link to="/leads" className="text-xs font-semibold text-ink/50 hover:text-ink">
          &larr; Back to leads
        </Link>
      )}

      {!agreement.clientId && !agreement.leadId && (
        // A standalone agreement has no lead or client to show a "back
        // to..." link for -- this banner is what tells staff where the
        // prospect info it was created with actually went, and what
        // happens to it on signing. Same as ProposalEditorPage's
        // identical banner.
        <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900">
          <p className="font-semibold">Standalone service agreement, no client yet.</p>
          <p className="mt-1">
            {agreement.prospectFullName} &middot; {agreement.prospectBusinessName}
            {agreement.prospectEmail ? ` · ${agreement.prospectEmail}` : ""}
            {agreement.prospectPhone ? ` · ${agreement.prospectPhone}` : ""}
          </p>
          <p className="mt-1 text-blue-700">
            {agreement.prospectEmail
              ? "A real client record is created automatically from this info the moment the prospect signs."
              : "No email was collected for this prospect, so no client record will be created when they sign -- this agreement stays unlinked."}
          </p>
        </div>
      )}

      <div className="mt-2 flex items-start justify-between gap-3">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-transparent bg-transparent text-2xl font-bold text-brand-navy outline-none focus:border-ink/15 focus:bg-white"
        />
        <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide ${STATUS_STYLES[agreement.status]}`}>{agreement.status}</span>
      </div>

      {error && <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="mt-4 grid gap-4">
        {agreement.status !== "draft" && (
          <Card title="Public Link">
            <p className="break-all text-sm text-brand-blue">{agreement.publicUrl}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" onClick={handleCopy} className="rounded-full bg-brand-blue px-4 py-1.5 text-xs font-semibold text-white hover:bg-[#0b57cc]">
                {copied ? "Copied!" : "Copy Link"}
              </button>
              <a href={agreement.publicUrl} target="_blank" rel="noreferrer" className="rounded-full border border-ink/15 px-4 py-1.5 text-xs font-semibold text-brand-navy hover:border-brand-blue hover:text-brand-blue">
                View as Client
              </a>
              {agreement.status !== "revoked" && (
                <button type="button" onClick={() => setConfirmingRevoke(true)} className="rounded-full border border-red-200 px-4 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50">
                  Revoke Link
                </button>
              )}
            </div>
            {confirmingRevoke && (
              <div className="mt-2 rounded-lg border border-red-200 bg-red-50 p-3">
                <p className="text-sm text-red-700">Revoke this agreement's link? The client will no longer be able to view or sign it.</p>
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

        {agreement.signature && (
          <Card title="Signature">
            <p className="text-sm text-ink/70">
              Signed by <span className="font-semibold text-brand-navy">{agreement.signature.signerName}</span>
              {agreement.signature.signerTitle ? `, ${agreement.signature.signerTitle}` : ""} on {new Date(agreement.signature.signedAt).toLocaleString()}
            </p>
            <img src={agreement.signature.signatureDataUrl} alt="Client signature" className="mt-2 h-20 w-auto rounded border border-ink/10 bg-white p-2" />
            {agreement.signature.ipAddress && <p className="mt-1 text-xs text-ink/40">IP: {agreement.signature.ipAddress}</p>}
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
          </Card>
        )}

        <Card title="Agreement Content">
          <div className="flex items-center justify-end gap-2 pb-2">
            <button type="button" onClick={() => setPreview((p) => !p)} className="text-xs font-semibold text-brand-blue hover:underline">
              {preview ? "Edit" : "Preview"}
            </button>
          </div>
          {preview ? (
            <div className="proposal-content rounded-lg border border-ink/10 bg-paper-alt p-4 text-sm" dangerouslySetInnerHTML={{ __html: contentHtml }} />
          ) : (
            <RichTextEditor value={contentHtml} onChange={setContentHtml} placeholder="Write the service agreement here..." />
          )}
        </Card>

        {agreement.versions.length > 0 && (
          <Card title="Version History">
            <ul className="space-y-1 text-sm text-ink/60">
              {agreement.versions.map((v) => (
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
          {publishing ? "Publishing..." : agreement.status === "draft" ? "Publish" : signed ? "Publish Revision (resets signature)" : "Publish Revision"}
        </button>
      </div>
    </div>
  );
}
