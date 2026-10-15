import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  fetchQuestionnaireDetail,
  updateQuestionnaireDraft,
  publishQuestionnaire,
  revokeQuestionnaire,
  fetchQuestionnaireResponses,
  type QuestionnaireDetail,
  type QuestionnaireStatus,
  type QuestionnaireResponse,
} from "../lib/api";
import RichTextEditor from "../components/RichTextEditor";

const STATUS_STYLES: Record<QuestionnaireStatus, string> = {
  draft: "bg-ink/10 text-ink/60",
  published: "bg-blue-100 text-blue-700",
  submitted: "bg-green-100 text-green-700",
  closed: "bg-red-100 text-red-700",
};

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-ink/10 bg-white p-5">
      <h2 className="text-sm font-bold uppercase tracking-wide text-ink/50">{title}</h2>
      <div className="mt-3">{children}</div>
    </div>
  );
}

export default function QuestionnaireEditorPage() {
  const { clientId, questionnaireId } = useParams<{ clientId: string; questionnaireId: string }>();
  const [detail, setDetail] = useState<QuestionnaireDetail | null>(null);
  const [title, setTitle] = useState("");
  const [contentHtml, setContentHtml] = useState("");
  const [responses, setResponses] = useState<QuestionnaireResponse[]>([]);
  const [showResponses, setShowResponses] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);
  const [preview, setPreview] = useState(false);

  const load = () => {
    if (!clientId || !questionnaireId) return;
    fetchQuestionnaireDetail(clientId, questionnaireId)
      .then((d) => {
        setDetail(d);
        setTitle(d.title);
        setContentHtml(d.contentHtml);
      })
      .catch((err) => setError(err.message));
  };

  useEffect(load, [clientId, questionnaireId]);

  const loadResponses = () => {
    if (!clientId || !questionnaireId) return;
    fetchQuestionnaireResponses(clientId, questionnaireId)
      .then(setResponses)
      .catch((err) => setError(err.message));
  };

  const handleSave = async () => {
    if (!clientId || !questionnaireId) return;
    setSaving(true);
    setError(null);
    try {
      await updateQuestionnaireDraft(clientId, questionnaireId, { title, contentHtml });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the draft.");
    } finally {
      setSaving(false);
    }
  };

  const handlePublish = async () => {
    if (!clientId || !questionnaireId) return;
    setPublishing(true);
    setError(null);
    try {
      await handleSave();
      await publishQuestionnaire(clientId, questionnaireId);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't publish.");
    } finally {
      setPublishing(false);
    }
  };

  const handleRevoke = async () => {
    if (!clientId || !questionnaireId) return;
    try {
      await revokeQuestionnaire(clientId, questionnaireId);
      setConfirmingRevoke(false);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't close this questionnaire.");
    }
  };

  const handleCopy = () => {
    if (!detail) return;
    navigator.clipboard.writeText(detail.publicUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  if (error && !detail) return <p className="text-sm text-red-600">{error}</p>;
  if (!detail) return <p className="text-sm text-ink/50">Loading&hellip;</p>;

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
        <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide ${STATUS_STYLES[detail.status]}`}>{detail.status}</span>
      </div>

      {error && <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="mt-4 grid gap-4">
        {detail.status !== "draft" && (
          <Card title="Public Link">
            <p className="break-all text-sm text-brand-blue">{detail.publicUrl}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" onClick={handleCopy} className="rounded-full bg-brand-blue px-4 py-1.5 text-xs font-semibold text-white hover:bg-[#0b57cc]">
                {copied ? "Copied!" : "Copy Link"}
              </button>
              <a href={detail.publicUrl} target="_blank" rel="noreferrer" className="rounded-full border border-ink/15 px-4 py-1.5 text-xs font-semibold text-brand-navy hover:border-brand-blue hover:text-brand-blue">
                View as Client
              </a>
              {detail.status !== "closed" && (
                <button type="button" onClick={() => setConfirmingRevoke(true)} className="rounded-full border border-red-200 px-4 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50">
                  Close Link
                </button>
              )}
            </div>
            {confirmingRevoke && (
              <div className="mt-2 rounded-lg border border-red-200 bg-red-50 p-3">
                <p className="text-sm text-red-700">Close this questionnaire's link? The client will no longer be able to open or submit it.</p>
                <div className="mt-2 flex gap-2">
                  <button type="button" onClick={handleRevoke} className="rounded-full bg-red-600 px-3 py-1 text-xs font-semibold text-white hover:bg-red-700">
                    Yes, Close
                  </button>
                  <button type="button" onClick={() => setConfirmingRevoke(false)} className="text-xs text-ink/50 hover:text-ink">
                    Never mind
                  </button>
                </div>
              </div>
            )}
          </Card>
        )}

        <Card title={`Questionnaire Content (${detail.responseCount} response${detail.responseCount === 1 ? "" : "s"} so far)`}>
          <p className="mb-2 text-xs text-ink/50">Write anything the client needs to read or answer -- instructions, questions, a list, whatever fits. The client replies in one open text box below it.</p>
          <div className="flex items-center justify-end gap-2 pb-2">
            <button type="button" onClick={() => setPreview((p) => !p)} className="text-xs font-semibold text-brand-blue hover:underline">
              {preview ? "Edit" : "Preview"}
            </button>
          </div>
          {preview ? (
            <div className="proposal-content rounded-lg border border-ink/10 bg-paper-alt p-4 text-sm" dangerouslySetInnerHTML={{ __html: contentHtml }} />
          ) : (
            <RichTextEditor value={contentHtml} onChange={setContentHtml} placeholder="Write the questionnaire here..." />
          )}
        </Card>

        {detail.versions.length > 0 && (
          <Card title="Version History">
            <ul className="space-y-1 text-sm text-ink/60">
              {detail.versions.map((v) => (
                <li key={v.id}>
                  v{v.versionNumber} &mdash; published {new Date(v.createdAt).toLocaleString()}
                </li>
              ))}
            </ul>
          </Card>
        )}

        {detail.responseCount > 0 && (
          <Card title="Submitted Responses">
            {!showResponses ? (
              <button
                type="button"
                onClick={() => {
                  setShowResponses(true);
                  loadResponses();
                }}
                className="rounded-full border border-ink/15 px-4 py-1.5 text-xs font-semibold text-brand-navy hover:border-brand-blue hover:text-brand-blue"
              >
                View Responses
              </button>
            ) : (
              <div className="space-y-4">
                {responses.map((r) => (
                  <div key={r.id} className="rounded-lg border border-ink/10 p-4">
                    <p className="text-xs text-ink/40">Submitted {new Date(r.submittedAt).toLocaleString()}</p>
                    <p className="mt-2 whitespace-pre-wrap text-sm text-ink/80">{r.answerText || <span className="text-ink/30">(no answer)</span>}</p>
                  </div>
                ))}
              </div>
            )}
          </Card>
        )}
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        <button type="button" disabled={saving} onClick={handleSave} className="rounded-full border border-ink/15 px-5 py-2 text-sm font-semibold text-brand-navy hover:border-brand-blue hover:text-brand-blue disabled:opacity-50">
          {saving ? "Saving..." : "Save Draft"}
        </button>
        <button type="button" disabled={publishing} onClick={handlePublish} className="rounded-full bg-brand-blue px-5 py-2 text-sm font-semibold text-white hover:bg-[#0b57cc] disabled:opacity-50">
          {publishing ? "Publishing..." : detail.status === "draft" ? "Publish" : "Publish Revision"}
        </button>
      </div>
    </div>
  );
}
