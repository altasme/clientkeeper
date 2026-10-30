import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  fetchQuestionnaireDetail,
  updateQuestionnaireDraft,
  saveQuestionnaireQuestions,
  publishQuestionnaire,
  revokeQuestionnaire,
  fetchQuestionnaireResponses,
  type QuestionnaireDetail,
  type QuestionnaireStatus,
  type QuestionDraft,
  type QuestionFieldType,
  type QuestionnaireResponse,
} from "../lib/api";

const STATUS_STYLES: Record<QuestionnaireStatus, string> = {
  draft: "bg-ink/10 text-ink/60",
  published: "bg-blue-100 text-blue-700",
  submitted: "bg-green-100 text-green-700",
  closed: "bg-red-100 text-red-700",
};

const FIELD_TYPE_LABELS: Record<QuestionFieldType, string> = {
  short_text: "Short text",
  long_text: "Long text",
  single_choice: "Single choice (radio)",
  multi_choice: "Multiple choice (checkboxes)",
  dropdown: "Dropdown",
  yes_no: "Yes / No",
  date: "Date",
  url: "URL",
  file: "File upload",
};

const NEEDS_OPTIONS: QuestionFieldType[] = ["single_choice", "multi_choice", "dropdown"];

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl border border-ink/10 bg-white p-5">
      <h2 className="text-sm font-bold uppercase tracking-wide text-ink/50">{title}</h2>
      <div className="mt-3">{children}</div>
    </div>
  );
}

let localIdCounter = 0;
function newLocalId() {
  localIdCounter += 1;
  return `local-${Date.now()}-${localIdCounter}`;
}

function emptyQuestion(): QuestionDraft {
  return {
    id: newLocalId(),
    sectionHeading: null,
    sectionDescription: null,
    prompt: "",
    helpText: null,
    fieldType: "short_text",
    isRequired: false,
    options: [],
    sortOrder: 0,
  };
}

export default function QuestionnaireEditorPage() {
  const { clientId, questionnaireId } = useParams<{ clientId: string; questionnaireId: string }>();
  const [detail, setDetail] = useState<QuestionnaireDetail | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [questions, setQuestions] = useState<QuestionDraft[]>([]);
  const [responses, setResponses] = useState<QuestionnaireResponse[]>([]);
  const [showResponses, setShowResponses] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);

  const load = () => {
    if (!clientId || !questionnaireId) return;
    fetchQuestionnaireDetail(clientId, questionnaireId)
      .then((d) => {
        setDetail(d);
        setTitle(d.title);
        setDescription(d.description ?? "");
        setQuestions(d.draftQuestions.length ? d.draftQuestions : [emptyQuestion()]);
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

  const updateQuestion = (index: number, patch: Partial<QuestionDraft>) => {
    setQuestions((qs) => qs.map((q, i) => (i === index ? { ...q, ...patch } : q)));
  };

  const addQuestion = () => setQuestions((qs) => [...qs, emptyQuestion()]);
  const deleteQuestion = (index: number) => setQuestions((qs) => qs.filter((_, i) => i !== index));
  const duplicateQuestion = (index: number) =>
    setQuestions((qs) => {
      const copy = { ...qs[index], id: newLocalId() };
      return [...qs.slice(0, index + 1), copy, ...qs.slice(index + 1)];
    });
  const moveQuestion = (index: number, direction: -1 | 1) =>
    setQuestions((qs) => {
      const target = index + direction;
      if (target < 0 || target >= qs.length) return qs;
      const copy = [...qs];
      [copy[index], copy[target]] = [copy[target], copy[index]];
      return copy;
    });

  const handleSave = async () => {
    if (!clientId || !questionnaireId) return;
    setSaving(true);
    setError(null);
    try {
      await updateQuestionnaireDraft(clientId, questionnaireId, { title, description: description || null });
      await saveQuestionnaireQuestions(
        clientId,
        questionnaireId,
        questions
          .filter((q) => q.prompt.trim())
          .map((q) => ({
            sectionHeading: q.sectionHeading,
            sectionDescription: q.sectionDescription,
            prompt: q.prompt,
            helpText: q.helpText,
            fieldType: q.fieldType,
            isRequired: q.isRequired,
            options: q.options,
          }))
      );
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
          className="min-w-0 flex-1 rounded-lg border border-transparent bg-transparent text-2xl font-bold text-brand-navy outline-none focus:border-ink/15 focus:bg-white"
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

        <Card title="Description (shown to the client above the questions)">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm"
            placeholder="Optional intro text..."
          />
        </Card>

        <Card title={`Questions (${detail.responseCount} response${detail.responseCount === 1 ? "" : "s"} so far)`}>
          <div className="space-y-4">
            {questions.map((q, i) => (
              <div key={q.id} className="rounded-lg border border-ink/10 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-2">
                    <input
                      value={q.sectionHeading ?? ""}
                      onChange={(e) => updateQuestion(i, { sectionHeading: e.target.value || null })}
                      placeholder="Section heading (optional)"
                      className="rounded-lg border border-ink/15 px-3 py-1.5 text-xs"
                    />
                    <select
                      value={q.fieldType}
                      onChange={(e) => updateQuestion(i, { fieldType: e.target.value as QuestionFieldType })}
                      className="rounded-lg border border-ink/15 px-3 py-1.5 text-xs"
                    >
                      {Object.entries(FIELD_TYPE_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button type="button" title="Move up" onClick={() => moveQuestion(i, -1)} className="rounded px-1.5 py-1 text-xs text-ink/50 hover:bg-ink/5">
                      &uarr;
                    </button>
                    <button type="button" title="Move down" onClick={() => moveQuestion(i, 1)} className="rounded px-1.5 py-1 text-xs text-ink/50 hover:bg-ink/5">
                      &darr;
                    </button>
                    <button type="button" title="Duplicate" onClick={() => duplicateQuestion(i)} className="rounded px-1.5 py-1 text-xs text-ink/50 hover:bg-ink/5">
                      ⧉
                    </button>
                    <button type="button" title="Delete" onClick={() => deleteQuestion(i)} className="rounded px-1.5 py-1 text-xs text-red-500 hover:bg-red-50">
                      ✕
                    </button>
                  </div>
                </div>

                <input
                  value={q.prompt}
                  onChange={(e) => updateQuestion(i, { prompt: e.target.value })}
                  placeholder="Question prompt"
                  className="mt-2 w-full rounded-lg border border-ink/15 px-3 py-2 text-sm font-medium"
                />
                <input
                  value={q.helpText ?? ""}
                  onChange={(e) => updateQuestion(i, { helpText: e.target.value || null })}
                  placeholder="Help text shown under the question (optional)"
                  className="mt-2 w-full rounded-lg border border-ink/15 px-3 py-1.5 text-xs text-ink/70"
                />

                {NEEDS_OPTIONS.includes(q.fieldType) && (
                  <div className="mt-2">
                    <p className="text-xs font-semibold text-ink/50">Options (one per line)</p>
                    <textarea
                      value={q.options.join("\n")}
                      onChange={(e) => updateQuestion(i, { options: e.target.value.split("\n") })}
                      rows={3}
                      className="mt-1 w-full rounded-lg border border-ink/15 px-3 py-1.5 text-xs"
                    />
                  </div>
                )}

                <label className="mt-2 flex items-center gap-2 text-xs text-ink/70">
                  <input type="checkbox" checked={q.isRequired} onChange={(e) => updateQuestion(i, { isRequired: e.target.checked })} />
                  Required
                </label>
              </div>
            ))}
          </div>
          <button type="button" onClick={addQuestion} className="mt-3 rounded-full border border-ink/15 px-4 py-1.5 text-xs font-semibold text-brand-navy hover:border-brand-blue hover:text-brand-blue">
            + Add Question
          </button>
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
              <div className="space-y-5">
                {responses.map((r) => (
                  <div key={r.id} className="rounded-lg border border-ink/10 p-4">
                    <p className="text-xs text-ink/40">Submitted {new Date(r.submittedAt).toLocaleString()}</p>
                    <dl className="mt-2 space-y-2">
                      {r.answers.map((a) => (
                        <div key={a.questionId}>
                          <dt className="text-xs font-semibold text-ink/60">{a.prompt}</dt>
                          <dd className="text-sm text-ink/80">
                            {a.fileUrl ? (
                              <a href={a.fileUrl} target="_blank" rel="noreferrer" className="text-brand-blue hover:underline">
                                {a.fileName || "Download file"}
                              </a>
                            ) : a.valueList ? (
                              a.valueList.join(", ") || <span className="text-ink/30">(no answer)</span>
                            ) : (
                              a.valueText || <span className="text-ink/30">(no answer)</span>
                            )}
                          </dd>
                        </div>
                      ))}
                    </dl>
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
