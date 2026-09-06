import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchOffers, type OfferRow } from "../lib/api";

export default function OffersPage() {
  const [offers, setOffers] = useState<OfferRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchOffers()
      .then(setOffers)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <h1 className="text-2xl font-bold text-brand-navy">Offers</h1>
      <p className="mt-1 text-sm text-ink/50">Open a client's page to unlock or record a decision.</p>

      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      <div className="mt-4 overflow-x-auto rounded-xl border border-ink/10 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-ink/10 text-xs uppercase tracking-wide text-ink/40">
            <tr>
              <th className="px-4 py-3">Client</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Unlocked</th>
            </tr>
          </thead>
          <tbody>
            {offers.map((o) => (
              <tr key={o.id} className="border-b border-ink/5 last:border-0 hover:bg-paper-alt">
                <td className="px-4 py-3">
                  <Link to={`/clients/${o.clientId}`} className="font-semibold text-brand-blue hover:underline">
                    {o.clientFullName}
                  </Link>
                  <span className="ml-1 text-ink/50">({o.businessName})</span>
                </td>
                <td className="px-4 py-3 text-ink/70">{o.type === "1499" ? "₱1,499" : "Essential"}</td>
                <td className="px-4 py-3">
                  <span className="rounded-full bg-paper-alt px-2 py-0.5 text-xs font-semibold uppercase text-ink/60">{o.status}</span>
                </td>
                <td className="px-4 py-3 text-ink/50">{o.unlockedAt ? new Date(o.unlockedAt).toLocaleDateString() : "—"}</td>
              </tr>
            ))}
            {!loading && offers.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-ink/40">
                  No offers yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
