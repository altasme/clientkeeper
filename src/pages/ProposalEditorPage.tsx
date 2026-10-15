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
    <div className="rounded-xl border border-ink/10 bg-white p-5">
      <h2 className="text-sm font-bold uppercase tracking-wide text-ink/50">{title}</h2>
      <div className="mt-3">{children}</div>
    </div>
  );
}

export default function ProposalEditorPage() {
  const { clientId, proposalId } = useParams<{ clientId: string; proposalId: string }>();
  const [proposal, setProposal] = useState<ProposalDetail | null>(null);
  const [questionnaires, setQuestionnaires] = useState<QuestionnaireListRow[]>([]);
  const [title, setTitle] = useState("");
  const [contentHtml, setContentHtml] = useState("");
  const [questionnaireId, setQuestionnaireId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);
  const [preview, setPreview] = useState(false);

  const load = () => {
    if (!clientId || !proposalId) return;
    fetchProposalDetail(clientId, proposalId)
      .then((p) => {
        setProposal(p);
        setTitle(p.title);
        setContentHtml(p.contentHtml);
        setQuestionnaireId(p.questionnaireId ?? "");
      })
      .catch((err) => setError(err.message));
    fetchQuestionnaires(clientId).then(setQuestionnaires).catch(() => {});
  };

  useEffect(load, [clientId, proposalId]);

  // Editing is always allowed, even once signed -- publishing a revision
  // of a signed proposal resets status to "published" and preserves the
  // original signature as a historical record (see publish.ts), rather
  // than editing being blocked outright.
  const signed = proposal?.status === "signed";

  const handleSave = async () => {
    if (!clientId || !proposalId) return;
    setSaving(true);
    setError(null);
    try {
      await updateProposalDraft(clientId, proposalId, { title, contentHtml, questionnaireId: questionnaireId || null });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the draft.");
    } finally {
      setSaving(false);
    }
  };

  const handlePublish = async () => {
    if (!clientId || !proposalId) return;
    setPublishing(true);
    setError(null);
    try {
      await handleSave();
      await publishProposal(clientId, proposalId);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't publish.");
    } finally {
      setPublishing(false);
    }
  };

  const handleRevoke = async () => {
    if (!clientId || !proposalId) return;
    try {
      await revokeProposal(clientId, proposalId);
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
      <Link to={`/clients/${clientId}`} className="text-xs font-semibold text-ink/50 hover:text-ink">
        &larr; Back to client
      </Link>

      <div className="mt-2 flex items-start justify-between gap-3">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full rounded-lg border border-transparent bg-transparent text-2xl font-bold text-brand-navy outline-none focus:border-ink/15 focus:bg-white"
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
          </Card>
        )}

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
