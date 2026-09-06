import { useEffect, useState } from "react";
import { fetchLeads, updateLead, type Lead } from "../lib/api";

const STATUS_OPTIONS: Lead["status"][] = ["new", "contacted", "qualified", "converted", "lost"];

export default function LeadsPage() {
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
                <td className="px-4 py-3 font-semibold text-ink">{lead.full_name || "—"}</td>
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
