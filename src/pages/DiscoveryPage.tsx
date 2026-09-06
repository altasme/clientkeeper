import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchDiscoverySessions, type DiscoveryRow } from "../lib/api";

const STATUS_OPTIONS = ["requested", "scheduled", "completed"];

export default function DiscoveryPage() {
  const [rows, setRows] = useState<DiscoveryRow[]>([]);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetchDiscoverySessions(status || undefined)
      .then(setRows)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [status]);

  return (
    <div>
      <h1 className="text-2xl font-bold text-brand-navy">Discovery</h1>
      <p className="mt-1 text-sm text-ink/50">Open a client to update status or notes.</p>
      <div className="mt-4">
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
              <th className="px-4 py-3">Client</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Scheduled</th>
              <th className="px-4 py-3">Updated</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-ink/5 last:border-0 hover:bg-paper-alt">
                <td className="px-4 py-3">
                  <Link to={`/clients/${r.client_id}`} className="font-semibold text-brand-blue hover:underline">
                    {r.full_name}
                  </Link>
                  <span className="ml-1 text-ink/50">({r.business_name})</span>
                </td>
                <td className="px-4 py-3 text-ink/70">{r.external_status}</td>
                <td className="px-4 py-3 text-ink/50">{r.scheduled_at ? new Date(r.scheduled_at).toLocaleString() : "—"}</td>
                <td className="px-4 py-3 text-ink/50">{new Date(r.updated_at).toLocaleDateString()}</td>
              </tr>
            ))}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-ink/40">
                  No discovery sessions match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
