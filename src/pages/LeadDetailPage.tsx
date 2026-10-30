// [2026-10-15] A single lead's detail page -- added so a prospect
// proposal has somewhere to live and be created from, the same way
// ClientDetailPage's ProposalsBlock already works for clients
// (CLAUDE.md §25: "a proposal generator that doesn't need a client").
// Deliberately minimal -- just the lead's own contact fields (editable,
// same fields LeadsPage already lets staff set inline) plus the
// Proposals block. No projects/billing/discovery sections here, since a
// lead has none of that yet; those only start to exist once a lead
// converts into a real client.
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { fetchLead, updateLead, fetchLeadProposals, createLeadProposal, type Lead, type ProposalListRow } from "../lib/api";

const STATUS_OPTIONS: Lead["status"][] = ["new", "contacted", "qualified", "converted", "lost"];

const PROPOSAL_STATUS_STYLES: Record<string, string> = {
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

function ProposalsBlock({ leadId }: { leadId: string }) {
  const navigate = useNavigate();
  const [proposals, setProposals] = useState<ProposalListRow[]>([]);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    fetchLeadProposals(leadId).then(setProposals).catch(() => {});
  }, [leadId]);

  const handleCreate = async () => {
    setCreating(true);
    try {
      const { id } = await createLeadProposal(leadId);
      navigate(`/proposals/${id}`);
    } catch {
      setCreating(false);
    }
  };

  return (
    <div>
      {proposals.length === 0 ? (
        <p className="text-sm text-ink/40">No proposals yet.</p>
      ) : (
        <ul className="space-y-2">
          {proposals.map((p) => (
            <li key={p.id} className="flex items-center justify-between rounded-lg border border-ink/10 p-3 text-sm">
              <Link to={`/proposals/${p.id}`} className="font-medium text-brand-navy hover:underline">
                {p.title}
              </Link>
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide ${PROPOSAL_STATUS_STYLES[p.status] ?? "bg-ink/10 text-ink/60"}`}>{p.status}</span>
            </li>
          ))}
        </ul>
      )}
      <button type="button" disabled={creating} onClick={handleCreate} className="mt-3 rounded-full border border-ink/15 px-4 py-1.5 text-xs font-semibold text-brand-navy hover:border-brand-blue hover:text-brand-blue disabled:opacity-50">
        {creating ? "Creating..." : "+ New Proposal"}
      </button>
    </div>
  );
}

export default function LeadDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [lead, setLead] = useState<Lead | null>(null);
  const [status, setStatus] = useState<Lead["status"]>("new");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!id) return;
    fetchLead(id)
      .then((l) => {
        setLead(l);
        setStatus(l.status);
        setNotes(l.notes || "");
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load this lead."));
  }, [id]);

  const handleSave = async () => {
    if (!id) return;
    setSaving(true);
    setError(null);
    try {
      await updateLead(id, { status, notes });
      setLead((prev) => (prev ? { ...prev, status, notes } : prev));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save.");
    } finally {
      setSaving(false);
    }
  };

  if (error && !lead) return <p className="text-sm text-red-600">{error}</p>;
  if (!lead) return <p className="text-sm text-ink/50">Loading&hellip;</p>;

  return (
    <div className="max-w-3xl">
      <Link to="/leads" className="text-xs font-semibold text-ink/50 hover:text-ink">
        &larr; Back to leads
      </Link>

      <div className="mt-2 flex items-start justify-between gap-3">
        <h1 className="text-2xl font-bold text-brand-navy">{lead.business_name || lead.full_name || "Prospect"}</h1>
        <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide bg-ink/10 text-ink/60`}>{lead.status}</span>
      </div>

      {error && <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="mt-4 grid gap-4">
        <Card title="Contact">
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs uppercase tracking-wide text-ink/40">Name</dt>
              <dd className="text-ink">{lead.full_name || "—"}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-ink/40">Business</dt>
              <dd className="text-ink">{lead.business_name || "—"}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-ink/40">Email</dt>
              <dd className="text-ink">{lead.email || "—"}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-ink/40">Phone</dt>
              <dd className="text-ink">{lead.phone || "—"}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-ink/40">Source</dt>
              <dd className="text-ink">{lead.source || "—"}</dd>
            </div>
          </dl>
        </Card>

        <Card title="Status & Notes">
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as Lead["status"])}
            className="rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm"
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <textarea
            placeholder="Internal notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={4}
            className="mt-3 w-full rounded-lg border border-ink/15 px-3 py-2 text-sm"
          />
          <button
            type="button"
            disabled={saving}
            onClick={handleSave}
            className="mt-3 rounded-full bg-brand-blue px-4 py-1.5 text-xs font-semibold text-white hover:bg-[#0b57cc] disabled:opacity-50"
          >
            {saving ? "Saving..." : saved ? "Saved!" : "Save"}
          </button>
        </Card>

        <Card title="Proposals">
          <ProposalsBlock leadId={lead.id} />
        </Card>
      </div>
    </div>
  );
}
