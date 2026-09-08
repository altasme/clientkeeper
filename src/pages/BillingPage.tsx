import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchBills, type BillListRow, type BillStatus } from "../lib/api";

const STATUS_STYLES: Record<BillStatus, string> = {
  pending: "bg-amber-100 text-amber-700",
  paid: "bg-green-100 text-green-700",
  expired: "bg-ink/10 text-ink/60",
  cancelled: "bg-red-100 text-red-700",
};

const MONEY_FORMATTER = new Intl.NumberFormat("en-US");

function formatMoney(amount: number): string {
  return `₱${MONEY_FORMATTER.format(amount)}`;
}

export default function BillingPage() {
  const [bills, setBills] = useState<BillListRow[]>([]);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetchBills()
      .then(setBills)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const visibleBills = status ? bills.filter((b) => b.status === status) : bills;

  const copyLink = (bill: BillListRow) => {
    const url = `https://account.altasme.com/bill/${bill.token}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopiedId(bill.id);
      setTimeout(() => setCopiedId((current) => (current === bill.id ? null : current)), 2000);
    });
  };

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-brand-navy">Billing</h1>
        <Link
          to="/billing/new"
          className="rounded-full bg-brand-blue px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#0b57cc]"
        >
          + New Bill
        </Link>
      </div>
      <p className="mt-1 text-sm text-ink/60">Generate a Bill of Service and send its link to a client for payment.</p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="rounded-lg border border-ink/15 px-3 py-2 text-sm outline-none focus:border-brand-blue"
        >
          <option value="">All statuses</option>
          <option value="pending">Pending</option>
          <option value="paid">Paid</option>
          <option value="expired">Expired</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </div>

      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      <div className="mt-4 overflow-x-auto rounded-xl border border-ink/10 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-ink/10 text-xs uppercase tracking-wide text-ink/40">
            <tr>
              <th className="px-4 py-3">Bill No.</th>
              <th className="px-4 py-3">Recipient</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Amount</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Expires</th>
              <th className="px-4 py-3">Link</th>
            </tr>
          </thead>
          <tbody>
            {visibleBills.map((bill) => (
              <tr key={bill.id} className="border-b border-ink/5 last:border-0 hover:bg-paper-alt">
                <td className="px-4 py-3">
                  <Link to={`/billing/${bill.id}`} className="font-semibold text-brand-blue hover:underline">
                    {bill.billNumber}
                  </Link>
                </td>
                <td className="px-4 py-3 text-ink/70">{bill.recipientName}</td>
                <td className="px-4 py-3 capitalize text-ink/70">{bill.clientType}</td>
                <td className="px-4 py-3 font-semibold text-brand-navy">{formatMoney(bill.totalAmount)}</td>
                <td className="px-4 py-3">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-semibold capitalize ${STATUS_STYLES[bill.status]}`}>{bill.status}</span>
                </td>
                <td className="px-4 py-3 text-ink/50">{new Date(bill.expiresAt).toLocaleDateString()}</td>
                <td className="px-4 py-3">
                  <button type="button" onClick={() => copyLink(bill)} className="text-xs font-semibold text-brand-blue hover:underline">
                    {copiedId === bill.id ? "Copied!" : "Copy Link"}
                  </button>
                </td>
              </tr>
            ))}
            {!loading && visibleBills.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-ink/40">
                  No bills match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
