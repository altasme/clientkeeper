import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchPayments, type PaymentRow } from "../lib/api";

export default function PaymentsPage() {
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchPayments()
      .then(setPayments)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <h1 className="text-2xl font-bold text-brand-navy">Payments</h1>
      <p className="mt-1 text-sm text-ink/50">Read-only. Every row here comes from clienthub's ganap.net webhook.</p>

      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      <div className="mt-4 overflow-x-auto rounded-xl border border-ink/10 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-ink/10 text-xs uppercase tracking-wide text-ink/40">
            <tr>
              <th className="px-4 py-3">Client</th>
              <th className="px-4 py-3">Reference</th>
              <th className="px-4 py-3">Amount</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Date</th>
            </tr>
          </thead>
          <tbody>
            {payments.map((p) => (
              <tr key={p.id} className="border-b border-ink/5 last:border-0 hover:bg-paper-alt">
                <td className="px-4 py-3">
                  {p.client_id ? (
                    <Link to={`/clients/${p.client_id}`} className="font-semibold text-brand-blue hover:underline">
                      {p.full_name}
                    </Link>
                  ) : (
                    <span className="text-ink/40">Unmatched</span>
                  )}
                </td>
                <td className="px-4 py-3 text-ink/70">{p.ganap_reference_number}</td>
                <td className="px-4 py-3 text-ink/70">
                  ₱{p.amount} {p.currency}
                </td>
                <td className="px-4 py-3 text-ink/70">{p.status}</td>
                <td className="px-4 py-3 text-ink/50">{new Date(p.created_at).toLocaleDateString()}</td>
              </tr>
            ))}
            {!loading && payments.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-ink/40">
                  No payments yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
