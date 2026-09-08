import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { fetchClients, type ClientListRow } from "../lib/api";
import { STAGE_LABELS, ALL_STAGES } from "../lib/stageLabels";
import AddClientModal from "../components/AddClientModal";

export default function ClientsPage() {
  const navigate = useNavigate();
  const [clients, setClients] = useState<ClientListRow[]>([]);
  const [q, setQ] = useState("");
  const [stage, setStage] = useState("");
  const [paidNoAccount, setPaidNoAccount] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  useEffect(() => {
    setLoading(true);
    const handle = setTimeout(() => {
      fetchClients({ q: q || undefined, stage: stage || undefined, paidNoAccount })
        .then(setClients)
        .catch((err) => setError(err.message))
        .finally(() => setLoading(false));
    }, 250);
    return () => clearTimeout(handle);
  }, [q, stage, paidNoAccount]);

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-brand-navy">Clients</h1>
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          className="rounded-full bg-brand-blue px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#0b57cc]"
        >
          + Add Client
        </button>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <input
          type="text"
          placeholder="Search name, business, or email"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="w-72 rounded-lg border border-ink/15 px-3 py-2 text-sm outline-none focus:border-brand-blue"
        />
        <select
          value={stage}
          onChange={(e) => setStage(e.target.value)}
          className="rounded-lg border border-ink/15 px-3 py-2 text-sm outline-none focus:border-brand-blue"
        >
          <option value="">All stages</option>
          {ALL_STAGES.map((s) => (
            <option key={s} value={s}>
              {STAGE_LABELS[s]}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm text-ink/70">
          <input type="checkbox" checked={paidNoAccount} onChange={(e) => setPaidNoAccount(e.target.checked)} />
          Paid, no account yet
        </label>
      </div>

      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      <div className="mt-4 overflow-x-auto rounded-xl border border-ink/10 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-ink/10 text-xs uppercase tracking-wide text-ink/40">
            <tr>
              <th className="px-4 py-3">Client</th>
              <th className="px-4 py-3">Business</th>
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Stage</th>
              <th className="px-4 py-3">Account</th>
            </tr>
          </thead>
          <tbody>
            {clients.map((c) => (
              <tr key={c.id} className="border-b border-ink/5 last:border-0 hover:bg-paper-alt">
                <td className="px-4 py-3">
                  <Link to={`/clients/${c.id}`} className="font-semibold text-brand-blue hover:underline">
                    {c.fullName}
                  </Link>
                </td>
                <td className="px-4 py-3 text-ink/70">{c.businessName}</td>
                <td className="px-4 py-3 text-ink/70">{c.email}</td>
                <td className="px-4 py-3 text-ink/70">{c.stage ? STAGE_LABELS[c.stage] : "—"}</td>
                <td className="px-4 py-3">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                      c.invitationStatus === "accepted" ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"
                    }`}
                  >
                    {c.invitationStatus}
                  </span>
                </td>
              </tr>
            ))}
            {!loading && clients.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-ink/40">
                  No clients match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <AddClientModal open={addOpen} onClose={() => setAddOpen(false)} onCreated={(clientId) => navigate(`/clients/${clientId}`)} />
    </div>
  );
}
