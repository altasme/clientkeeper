import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchDashboard, type DashboardCounts, type ActiveClientRow } from "../lib/api";
import { STAGE_LABELS } from "../lib/stageLabels";

const COUNT_LABELS: Record<keyof DashboardCounts, string> = {
  newClientsToday: "New Clients",
  discoveryToday: "Started Discovery",
  buildingToday: "Started Building",
  presentationToday: "Presentations",
  offersUnlockedToday: "Offers Unlocked",
  conversionsToday: "Conversions",
};

export default function DashboardPage() {
  const [counts, setCounts] = useState<DashboardCounts | null>(null);
  const [activeClients, setActiveClients] = useState<ActiveClientRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchDashboard()
      .then((data) => {
        setCounts(data.counts);
        setActiveClients(data.activeClients);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="text-sm text-ink/50">Loading&hellip;</p>;
  if (error) return <p className="text-sm text-red-600">{error}</p>;

  return (
    <div>
      <h1 className="text-2xl font-bold text-brand-navy">Dashboard</h1>
      <p className="mt-1 text-sm text-ink/50">Today's activity across all clients.</p>

      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        {counts &&
          (Object.keys(COUNT_LABELS) as Array<keyof DashboardCounts>).map((key) => (
            <div key={key} className="rounded-xl border border-ink/10 bg-white p-4">
              <p className="text-2xl font-bold text-brand-navy">{counts[key]}</p>
              <p className="mt-1 text-xs text-ink/50">{COUNT_LABELS[key]}</p>
            </div>
          ))}
      </div>

      <h2 className="mt-8 text-lg font-bold text-brand-navy">Active Clients</h2>
      <div className="mt-3 overflow-x-auto rounded-xl border border-ink/10 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-ink/10 text-xs uppercase tracking-wide text-ink/40">
            <tr>
              <th className="px-4 py-3">Client</th>
              <th className="px-4 py-3">Business</th>
              <th className="px-4 py-3">Stage</th>
              <th className="px-4 py-3">Account</th>
              <th className="px-4 py-3">Updated</th>
            </tr>
          </thead>
          <tbody>
            {activeClients.map((c) => (
              <tr key={c.id} className="border-b border-ink/5 last:border-0 hover:bg-paper-alt">
                <td className="px-4 py-3">
                  <Link to={`/clients/${c.id}`} className="font-semibold text-brand-blue hover:underline">
                    {c.fullName}
                  </Link>
                </td>
                <td className="px-4 py-3 text-ink/70">{c.businessName}</td>
                <td className="px-4 py-3 text-ink/70">{c.stage ? STAGE_LABELS[c.stage] : "—"}</td>
                <td className="px-4 py-3 text-ink/70">{c.invitationStatus}</td>
                <td className="px-4 py-3 text-ink/50">{c.updatedAt ? new Date(c.updatedAt).toLocaleDateString() : "—"}</td>
              </tr>
            ))}
            {activeClients.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-ink/40">
                  No clients yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
