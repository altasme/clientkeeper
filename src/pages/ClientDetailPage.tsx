import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import {
  fetchClientDetail,
  addClientActivity,
  resendInvite,
  advanceProject,
  overrideProject,
  updateDiscoverySession,
  updatePresentation,
  unlockOffer,
  recordOfferDecision,
  ApiError,
  type ClientDetail,
  type Stage,
} from "../lib/api";
import { STAGE_LABELS, NEXT_FORWARD_STAGE, ALL_STAGES } from "../lib/stageLabels";

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-ink/10 bg-white p-5">
      <h2 className="text-sm font-bold uppercase tracking-wide text-ink/50">{title}</h2>
      <div className="mt-3">{children}</div>
    </div>
  );
}

function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{message}</p>;
}

export default function ClientDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<ClientDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!id) return;
    setLoading(true);
    fetchClientDetail(id)
      .then(setDetail)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Failed to load client."))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const run = async (action: () => Promise<unknown>) => {
    if (!id) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <p className="text-sm text-ink/50">Loading&hellip;</p>;
  if (!detail) return <p className="text-sm text-red-600">{error || "Client not found."}</p>;

  const { client, project, discovery, presentation, offers, stageHistory, payments, activity } = detail;
  const nextStage = project ? NEXT_FORWARD_STAGE[project.stage] : undefined;
  const hasOffer1499 = offers.some((o) => o.type === "1499");
  const hasOfferEssential = offers.some((o) => o.type === "essential");

  return (
    <div>
      <ErrorBanner message={error} />

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-brand-navy">{client.full_name}</h1>
          <p className="text-sm text-ink/60">{client.business_name}</p>
        </div>
        <span
          className={`rounded-full px-3 py-1 text-xs font-semibold ${
            client.invitation_status === "accepted" ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"
          }`}
        >
          Account: {client.invitation_status}
        </span>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card title="Identity">
          <dl className="space-y-1.5 text-sm">
            <div className="flex justify-between"><dt className="text-ink/50">Email</dt><dd>{client.email}</dd></div>
            <div className="flex justify-between"><dt className="text-ink/50">Mobile</dt><dd>{client.mobile || "—"}</dd></div>
            <div className="flex justify-between"><dt className="text-ink/50">Facebook</dt><dd>{client.facebook || "—"}</dd></div>
            <div className="flex justify-between"><dt className="text-ink/50">Existing site</dt><dd>{client.current_website || "—"}</dd></div>
            <div className="flex justify-between"><dt className="text-ink/50">Client since</dt><dd>{new Date(client.created_at).toLocaleDateString()}</dd></div>
          </dl>
          {client.invitation_status !== "accepted" && (
            <button
              type="button"
              disabled={busy}
              onClick={() => run(() => resendInvite(client.id))}
              className="mt-3 rounded-full border border-brand-blue px-4 py-1.5 text-xs font-semibold text-brand-blue hover:bg-brand-blue hover:text-white disabled:opacity-50"
            >
              Resend Account Invitation
            </button>
          )}
        </Card>

        <Card title="Project & Stage">
          {!project ? (
            <p className="text-sm text-ink/40">No project on record yet.</p>
          ) : (
            <>
              <p className="text-lg font-bold text-brand-navy">{STAGE_LABELS[project.stage]}</p>
              {project.website_url && (
                <p className="mt-1 text-sm">
                  <a href={project.website_url} target="_blank" rel="noreferrer" className="text-brand-blue hover:underline">
                    {project.website_url}
                  </a>
                </p>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                {nextStage && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => run(() => advanceProject(project.id, nextStage))}
                    className="rounded-full bg-brand-blue px-4 py-1.5 text-xs font-semibold text-white hover:bg-[#0b57cc] disabled:opacity-50"
                  >
                    {STAGE_LABELS[nextStage]} &rarr;
                  </button>
                )}
                {project.stage === "post_presentation" && !hasOffer1499 && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => run(() => unlockOffer(project.id, "1499"))}
                    className="rounded-full bg-brand-navy px-4 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
                  >
                    Unlock ₱1,499 Offer
                  </button>
                )}
                {project.stage === "conversion" && !hasOfferEssential && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => run(() => unlockOffer(project.id, "essential"))}
                    className="rounded-full bg-brand-navy px-4 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
                  >
                    Unlock Next Offer (Essential)
                  </button>
                )}
              </div>
              <OverrideControl busy={busy} onSubmit={(toStage, reason) => run(() => overrideProject(project.id, toStage, reason))} />
            </>
          )}
        </Card>

        <Card title="Discovery">
          {!discovery ? (
            <p className="text-sm text-ink/40">No discovery session yet.</p>
          ) : (
            <NotesBlock
              statusOptions={["requested", "scheduled", "completed"]}
              status={discovery.external_status}
              notes={discovery.internal_notes}
              busy={busy}
              onSave={(status, notes) => run(() => updateDiscoverySession(discovery.id, { externalStatus: status, internalNotes: notes }))}
            />
          )}
        </Card>

        <Card title="Presentation">
          {!presentation ? (
            <p className="text-sm text-ink/40">No presentation on record yet.</p>
          ) : (
            <>
              <NotesBlock
                statusOptions={["requested", "scheduled", "completed"]}
                status={presentation.external_status}
                notes={presentation.internal_notes}
                busy={busy}
                onSave={(status, notes) => run(() => updatePresentation(presentation.id, { externalStatus: status, internalNotes: notes }))}
              />
              <p className="mt-2 text-xs text-ink/50">Client decision: {presentation.client_decision || "pending"}</p>
            </>
          )}
        </Card>

        <Card title="Offers">
          {offers.length === 0 ? (
            <p className="text-sm text-ink/40">No offers yet.</p>
          ) : (
            <ul className="space-y-3">
              {offers.map((o) => (
                <li key={o.id} className="rounded-lg border border-ink/10 p-3 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-brand-navy">{o.type === "1499" ? "₱1,499 Offer" : "Essential Offer"}</span>
                    <span className="text-xs uppercase text-ink/50">{o.status}</span>
                  </div>
                  {o.content && <p className="mt-1 text-xs text-ink/60">{String(o.content.headline || "")}</p>}
                  {o.status === "unlocked" && (
                    <div className="mt-2 flex gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => run(() => recordOfferDecision(o.id, "accepted"))}
                        className="rounded-full bg-green-600 px-3 py-1 text-xs font-semibold text-white hover:bg-green-700 disabled:opacity-50"
                      >
                        Record Accepted
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => run(() => recordOfferDecision(o.id, "declined"))}
                        className="rounded-full border border-ink/20 px-3 py-1 text-xs font-semibold text-ink/70 hover:bg-paper-alt disabled:opacity-50"
                      >
                        Record Declined
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Payments">
          {payments.length === 0 ? (
            <p className="text-sm text-ink/40">No payments on record.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {payments.map((p) => (
                <li key={p.id} className="flex justify-between">
                  <span>{p.ganap_reference_number}</span>
                  <span className="text-ink/60">
                    ₱{p.amount} {p.currency} &middot; {p.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Stage History">
          {stageHistory.length === 0 ? (
            <p className="text-sm text-ink/40">No stage changes yet.</p>
          ) : (
            <ul className="space-y-2 text-xs text-ink/60">
              {stageHistory.map((h) => (
                <li key={h.id}>
                  {h.from_stage ? STAGE_LABELS[h.from_stage as Stage] : "(start)"} &rarr; {STAGE_LABELS[h.to_stage as Stage]}
                  {h.reason && <span className="italic"> — {h.reason}</span>}
                  <span className="ml-1 text-ink/40">({new Date(h.created_at).toLocaleString()})</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Activity & Notes">
          <ActivityBlock activity={activity} busy={busy} onAdd={(note) => run(() => addClientActivity(client.id, note))} />
        </Card>
      </div>
    </div>
  );
}

function OverrideControl({ busy, onSubmit }: { busy: boolean; onSubmit: (toStage: Stage, reason: string) => void }) {
  const [open, setOpen] = useState(false);
  const [toStage, setToStage] = useState<Stage>("on_hold");
  const [reason, setReason] = useState("");

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="mt-3 text-xs font-semibold text-ink/50 hover:text-ink">
        Admin override&hellip;
      </button>
    );
  }

  return (
    <div className="mt-3 space-y-2 rounded-lg border border-ink/10 bg-paper-alt p-3">
      <select value={toStage} onChange={(e) => setToStage(e.target.value as Stage)} className="w-full rounded border border-ink/15 px-2 py-1.5 text-xs">
        {ALL_STAGES.map((s) => (
          <option key={s} value={s}>
            {STAGE_LABELS[s]}
          </option>
        ))}
      </select>
      <textarea
        placeholder="Reason (required)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        className="w-full rounded border border-ink/15 px-2 py-1.5 text-xs"
        rows={2}
      />
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy || !reason.trim()}
          onClick={() => {
            onSubmit(toStage, reason.trim());
            setOpen(false);
            setReason("");
          }}
          className="rounded-full bg-red-600 px-3 py-1 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
        >
          Apply Override
        </button>
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-ink/50 hover:text-ink">
          Cancel
        </button>
      </div>
    </div>
  );
}

function NotesBlock({
  statusOptions,
  status,
  notes,
  busy,
  onSave,
}: {
  statusOptions: string[];
  status: string;
  notes: string | null;
  busy: boolean;
  onSave: (status: string, notes: string) => void;
}) {
  const [localStatus, setLocalStatus] = useState(status);
  const [localNotes, setLocalNotes] = useState(notes || "");

  return (
    <div>
      <select
        value={localStatus}
        onChange={(e) => setLocalStatus(e.target.value)}
        className="rounded border border-ink/15 px-2 py-1.5 text-xs"
      >
        {statusOptions.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      <textarea
        placeholder="Internal notes"
        value={localNotes}
        onChange={(e) => setLocalNotes(e.target.value)}
        className="mt-2 w-full rounded border border-ink/15 px-2 py-1.5 text-xs"
        rows={3}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => onSave(localStatus, localNotes)}
        className="mt-2 rounded-full bg-brand-blue px-3 py-1 text-xs font-semibold text-white hover:bg-[#0b57cc] disabled:opacity-50"
      >
        Save
      </button>
    </div>
  );
}

function ActivityBlock({
  activity,
  busy,
  onAdd,
}: {
  activity: ClientDetail["activity"];
  busy: boolean;
  onAdd: (note: string) => void;
}) {
  const [note, setNote] = useState("");

  return (
    <div>
      <div className="flex gap-2">
        <input
          type="text"
          placeholder="Add a note&hellip;"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="flex-1 rounded border border-ink/15 px-2 py-1.5 text-xs"
        />
        <button
          type="button"
          disabled={busy || !note.trim()}
          onClick={() => {
            onAdd(note.trim());
            setNote("");
          }}
          className="rounded-full bg-brand-blue px-3 py-1 text-xs font-semibold text-white hover:bg-[#0b57cc] disabled:opacity-50"
        >
          Add
        </button>
      </div>
      <ul className="mt-3 space-y-2 text-xs text-ink/60">
        {activity.map((a) => (
          <li key={a.id}>
            <span className="font-semibold text-ink/80">{a.type}:</span> {a.description}
            <span className="ml-1 text-ink/40">({new Date(a.created_at).toLocaleString()})</span>
          </li>
        ))}
        {activity.length === 0 && <li className="text-ink/40">No activity yet.</li>}
      </ul>
    </div>
  );
}
