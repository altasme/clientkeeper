import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, fetchMyCafeDashboard, type MyCafeDashboard } from "../lib/api";

const COUNT_TILES: { key: keyof MyCafeDashboard["counts"]; label: string }[] = [
  { key: "totalBusinesses", label: "Total businesses" },
  { key: "activeBusinesses", label: "Active (paid)" },
  { key: "trialBusinesses", label: "Trial" },
  { key: "expiredBusinesses", label: "Expired" },
  { key: "registeredDevices", label: "Registered devices" },
  { key: "activeDevices", label: "Active devices" },
];

// The MyCafe workspace's landing page: live counts from MyCafe's control plane
// (never cached here) and the recent MyCafe client activity.
export default function MyCafeOverviewPage() {
  const [dashboard, setDashboard] = useState<MyCafeDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchMyCafeDashboard()
      .then(setDashboard)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load the overview."));
  }, []);

  return (
    <div>
      <h1 className="text-2xl font-bold text-mycafe-dark">Overview</h1>
      <p className="mt-1 text-sm text-ink/50">Live counts across every café running MyCafe POS.</p>

      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
      {!dashboard && !error && <p className="mt-4 text-sm text-ink/50">Loading&hellip;</p>}

      {dashboard && (
        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4">
          {COUNT_TILES.map((tile) => (
            <div key={tile.key} className="rounded-xl border border-ink/10 bg-white p-4">
              <p className="text-2xl font-bold text-mycafe-dark">{dashboard.counts[tile.key]}</p>
              <p className="mt-1 text-xs text-ink/50">{tile.label}</p>
            </div>
          ))}
        </div>
      )}

      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        <Link to="/mycafe/cafes" className="rounded-xl border border-ink/10 bg-white p-4 transition hover:border-mycafe/40">
          <p className="font-semibold text-mycafe-dark">Cafés</p>
          <p className="mt-1 text-xs text-ink/50">Add clients, provision cafés, issue device tokens.</p>
        </Link>
        <Link to="/mycafe/announcements" className="rounded-xl border border-ink/10 bg-white p-4 transition hover:border-mycafe/40">
          <p className="font-semibold text-mycafe-dark">Announcements</p>
          <p className="mt-1 text-xs text-ink/50">Post what's new. It shows in every café's Owner Panel.</p>
        </Link>
      </div>

      {dashboard && dashboard.recentActivity.length > 0 && (
        <div className="mt-8">
          <h2 className="text-lg font-bold text-mycafe-dark">Recent activity</h2>
          <ul className="mt-3 space-y-2 rounded-xl border border-ink/10 bg-white p-4 text-xs text-ink/60">
            {dashboard.recentActivity.map((a) => (
              <li key={a.id}>
                <Link to={`/mycafe/cafes/${a.clientId}`} className="font-semibold text-ink/80 hover:text-mycafe">
                  {a.businessName}
                </Link>{" "}
                &mdash; {a.description}
                <span className="ml-1 text-ink/40">({new Date(a.createdAt).toLocaleString()})</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
