import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { fetchLeads, updateLead, createLead, createStandaloneProposal, type Lead } from "../lib/api";

const STATUS_OPTIONS: Lead["status"][] = ["new", "contacted", "qualified", "converted", "lost"];

// [2026-10-15] A minimal "add lead" form -- this page previously had no
// way to create a lead at all (every existing row arrived from a
// payment-flow webhook or manual D1 insert), which left the new
// "proposal without a client" feature (CLAUDE.md §25) with no real entry
// point: a proposal can be attached to a lead, but there was nowhere to
// make a new prospect to attach one to. Kept deliberately small (name/
// business/email/phone only, source always "manual") rather than a full
// modal -- the fuller editing (status/notes) already lives on
// LeadDetailPage once the lead exists.
function AddLeadForm({ onCreated }: { onCreated: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [fullName, setFullName] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-full border border-ink/15 px-4 py-2 text-sm font-semibold text-brand-navy hover:border-brand-blue hover:text-brand-blue"
      >
        + Add Lead
      </button>
    );
  }

  const handleSave = async () => {
    if (!fullName.trim() && !businessName.trim() && !email.trim()) {
      setError("At least a name, business name, or email is required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const { id } = await createLead({
        fullName: fullName.trim() || undefined,
        businessName: businessName.trim() || undefined,
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
        source: "manual",
      });
      onCreated(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save this lead.");
      setSaving(false);
    }
  };

  return (
    <div className="mt-4 rounded-xl border border-ink/10 bg-white p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <input placeholder="Full name" value={fullName} onChange={(e) => setFullName(e.target.value)} className="rounded-lg border border-ink/15 px-3 py-2 text-sm" />
        <input placeholder="Business name" value={businessName} onChange={(e) => setBusinessName(e.target.value)} className="rounded-lg border border-ink/15 px-3 py-2 text-sm" />
        <input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} className="rounded-lg border border-ink/15 px-3 py-2 text-sm" />
        <input placeholder="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} className="rounded-lg border border-ink/15 px-3 py-2 text-sm" />
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      <div className="mt-3 flex gap-2">
        <button type="button" disabled={saving} onClick={handleSave} className="rounded-full bg-brand-blue px-4 py-1.5 text-xs font-semibold text-white hover:bg-[#0b57cc] disabled:opacity-50">
          {saving ? "Saving..." : "Save Lead"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-ink/50 hover:text-ink">
          Cancel
        </button>
      </div>
    </div>
  );
}

// [2026-10-16] A proposal doesn't need a lead or client at all anymore
// (CLAUDE.md §26: "create a proposal even outside of a lead or client" --
// signing it later auto-creates a real client). This form is where staff
// reach that: same spot and shape as AddLeadForm above (this is already
// the page for "working with a prospect who isn't a client yet"), but
// collecting the contact info a client record actually needs (name,
// business name, a valid email) rather than a lead's looser optional
// fields, since there's no lead row here to fall back on later.
function NewStandaloneProposalForm({ onCreated }: { onCreated: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [prospectFullName, setProspectFullName] = useState("");
  const [prospectBusinessName, setProspectBusinessName] = useState("");
  const [prospectEmail, setProspectEmail] = useState("");
  const [prospectPhone, setProspectPhone] = useState("");
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-full border border-ink/15 px-4 py-2 text-sm font-semibold text-brand-navy hover:border-brand-blue hover:text-brand-blue"
      >
        + New Proposal
      </button>
    );
  }

  const handleSave = async () => {
    if (!prospectFullName.trim() || !prospectBusinessName.trim() || !prospectEmail.trim()) {
      setError("Name, business name, and email are all required -- they're what lets us create a client once this is signed.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const { id } = await createStandaloneProposal({
        prospectFullName: prospectFullName.trim(),
        prospectBusinessName: prospectBusinessName.trim(),
        prospectEmail: prospectEmail.trim(),
        prospectPhone: prospectPhone.trim() || undefined,
        title: title.trim() || undefined,
      });
      onCreated(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create this proposal.");
      setSaving(false);
    }
  };

  return (
    <div className="mt-4 rounded-xl border border-ink/10 bg-white p-4">
      <p className="text-xs text-ink/50">No lead or client needed -- a real client is created automatically once this proposal is signed.</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <input placeholder="Prospect's full name" value={prospectFullName} onChange={(e) => setProspectFullName(e.target.value)} className="rounded-lg border border-ink/15 px-3 py-2 text-sm" />
        <input placeholder="Business name" value={prospectBusinessName} onChange={(e) => setProspectBusinessName(e.target.value)} className="rounded-lg border border-ink/15 px-3 py-2 text-sm" />
        <input placeholder="Email" type="email" value={prospectEmail} onChange={(e) => setProspectEmail(e.target.value)} className="rounded-lg border border-ink/15 px-3 py-2 text-sm" />
        <input placeholder="Phone (optional)" value={prospectPhone} onChange={(e) => setProspectPhone(e.target.value)} className="rounded-lg border border-ink/15 px-3 py-2 text-sm" />
        <input placeholder="Proposal title (optional)" value={title} onChange={(e) => setTitle(e.target.value)} className="rounded-lg border border-ink/15 px-3 py-2 text-sm sm:col-span-2" />
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      <div className="mt-3 flex gap-2">
        <button type="button" disabled={saving} onClick={handleSave} className="rounded-full bg-brand-blue px-4 py-1.5 text-xs font-semibold text-white hover:bg-[#0b57cc] disabled:opacity-50">
          {saving ? "Creating..." : "Create Proposal"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-ink/50 hover:text-ink">
          Cancel
        </button>
      </div>
    </div>
  );
}

export default function LeadsPage() {
  const navigate = useNavigate();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    fetchLeads({ q: q || undefined, status: status || undefined })
      .then(setLeads)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    const handle = setTimeout(load, 250);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, status]);

  const changeStatus = async (id: string, newStatus: Lead["status"]) => {
    await updateLead(id, { status: newStatus });
    load();
  };

  return (
    <div>
      <h1 className="text-2xl font-bold text-brand-navy">Leads</h1>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <input
          type="text"
          placeholder="Search name, business, or email"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="w-72 rounded-lg border border-ink/15 px-3 py-2 text-sm outline-none focus:border-brand-blue"
        />
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-lg border border-ink/15 px-3 py-2 text-sm">
          <option value="">All statuses</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <div className="ml-auto flex gap-2">
          <NewStandaloneProposalForm onCreated={(id) => navigate(`/proposals/${id}`)} />
          <AddLeadForm onCreated={(id) => navigate(`/leads/${id}`)} />
        </div>
      </div>

      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      <div className="mt-4 overflow-x-auto rounded-xl border border-ink/10 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-ink/10 text-xs uppercase tracking-wide text-ink/40">
            <tr>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Business</th>
              <th className="px-4 py-3">Contact</th>
              <th className="px-4 py-3">Source</th>
              <th className="px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody>
            {leads.map((lead) => (
              <tr key={lead.id} className="border-b border-ink/5 last:border-0 hover:bg-paper-alt">
                <td className="px-4 py-3 font-semibold text-ink">
                  <Link to={`/leads/${lead.id}`} className="text-brand-navy hover:underline">
                    {lead.full_name || "—"}
                  </Link>
                </td>
                <td className="px-4 py-3 text-ink/70">{lead.business_name || "—"}</td>
                <td className="px-4 py-3 text-ink/70">{lead.email || lead.phone || "—"}</td>
                <td className="px-4 py-3 text-ink/50">{lead.source || "—"}</td>
                <td className="px-4 py-3">
                  <select
                    value={lead.status}
                    onChange={(e) => changeStatus(lead.id, e.target.value as Lead["status"])}
                    className="rounded border border-ink/15 px-2 py-1 text-xs"
                  >
                    {STATUS_OPTIONS.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
            {!loading && leads.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-ink/40">
                  No leads match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
