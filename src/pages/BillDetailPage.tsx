import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { fetchBillDetail, cancelBill, reconcileBillPayment, type BillDetail, type BillStatus } from "../lib/api";

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

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-ink/10 bg-white p-5">
      <h2 className="text-sm font-bold uppercase tracking-wide text-ink/50">{title}</h2>
      <div className="mt-3">{children}</div>
    </div>
  );
}

export default function BillDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [bill, setBill] = useState<BillDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [checkingStatus, setCheckingStatus] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const load = () => {
    if (!id) return;
    fetchBillDetail(id)
      .then(setBill)
      .catch((err) => setError(err.message));
  };

  useEffect(load, [id]);

  const handleCopy = () => {
    if (!bill) return;
    navigator.clipboard.writeText(bill.publicUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleCheckStatus = async () => {
    if (!bill) return;
    setCheckingStatus(true);
    setStatusMessage(null);
    setError(null);
    try {
      const result = await reconcileBillPayment(bill.token);
      setStatusMessage(result.message || (result.reconciled ? "Bill marked paid." : "No change."));
      if (result.reconciled) load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't check payment status.");
    } finally {
      setCheckingStatus(false);
    }
  };

  const handleCancel = async () => {
    if (!id) return;
    setCancelling(true);
    setError(null);
    try {
      await cancelBill(id);
      setConfirmingCancel(false);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setCancelling(false);
    }
  };

  if (error && !bill) return <p className="text-sm text-red-600">{error}</p>;
  if (!bill) return <p className="text-sm text-ink/50">Loading&hellip;</p>;

  return (
    <div className="max-w-2xl">
      <Link to="/billing" className="text-xs font-semibold text-ink/50 hover:text-ink">
        &larr; Back to Billing
      </Link>

      <div className="mt-2 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-brand-navy">{bill.billNumber}</h1>
          <p className="mt-1 text-sm text-ink/60">{bill.recipientName}</p>
        </div>
        <span className={`rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide ${STATUS_STYLES[bill.status]}`}>{bill.status}</span>
      </div>

      {error && <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <Card title="Payment Link">
          <p className="break-all text-sm text-brand-blue">{bill.publicUrl}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleCopy}
              className="rounded-full bg-brand-blue px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-[#0b57cc]"
            >
              {copied ? "Copied!" : "Copy Link"}
            </button>
            <a
              href={bill.publicUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded-full border border-ink/15 px-4 py-1.5 text-xs font-semibold text-brand-navy transition hover:border-brand-blue hover:text-brand-blue"
            >
              View as Client
            </a>
            {bill.status === "pending" && (
              <button
                type="button"
                disabled={checkingStatus}
                onClick={handleCheckStatus}
                className="rounded-full border border-ink/15 px-4 py-1.5 text-xs font-semibold text-brand-navy transition hover:border-brand-blue hover:text-brand-blue disabled:opacity-50"
              >
                {checkingStatus ? "Checking…" : "Check Payment Status"}
              </button>
            )}
          </div>
          {statusMessage && <p className="mt-2 text-xs text-ink/60">{statusMessage}</p>}
        </Card>

        <Card title="Recipient">
          <p className="text-sm font-semibold text-brand-navy capitalize">{bill.clientType}</p>
          <p className="text-sm text-ink/70">{bill.recipientName}</p>
          {bill.recipientContactPerson && <p className="text-xs text-ink/50">Attn: {bill.recipientContactPerson}</p>}
          {bill.recipientTin && <p className="text-xs text-ink/50">TIN: {bill.recipientTin}</p>}
          {bill.recipientEmail && <p className="text-xs text-ink/50">{bill.recipientEmail}</p>}
          {bill.clientId && (
            <Link to={`/clients/${bill.clientId}`} className="mt-2 inline-block text-xs font-semibold text-brand-blue hover:underline">
              View linked client &rarr;
            </Link>
          )}
        </Card>

        <Card title="Dates">
          <p className="text-sm text-ink/70">Issued: {new Date(bill.issueDate).toLocaleDateString()}</p>
          <p className="text-sm text-ink/70">Expires: {new Date(bill.expiresAt).toLocaleDateString()} ({bill.validityDays} days)</p>
          {bill.paidAt && <p className="text-sm text-green-700">Paid: {new Date(bill.paidAt).toLocaleDateString()}</p>}
        </Card>

        <Card title="Service Scope and Description">
          {bill.scopeDescription ? <p className="text-sm text-ink/70">{bill.scopeDescription}</p> : <p className="text-sm text-ink/40">No scope description provided.</p>}
        </Card>

        <div className="sm:col-span-2">
          <Card title="Line Items">
            <div className="divide-y divide-ink/10">
              {bill.lineItems.map((item, i) => (
                <div key={i} className="flex items-center justify-between py-2 text-sm">
                  <p className="text-ink/80">{item.description}</p>
                  <p className="font-semibold text-brand-navy">{formatMoney(item.amount)}</p>
                </div>
              ))}
            </div>
            <div className="mt-2 flex items-center justify-between border-t-2 border-brand-navy pt-2">
              <p className="text-sm font-bold text-brand-navy">Total</p>
              <p className="text-lg font-extrabold text-brand-navy">{formatMoney(bill.totalAmount)}</p>
            </div>
            {bill.notes && <p className="mt-3 text-xs text-ink/50">{bill.notes}</p>}
          </Card>
        </div>
      </div>

      {bill.status === "pending" && (
        <div className="mt-5">
          {!confirmingCancel ? (
            <button type="button" onClick={() => setConfirmingCancel(true)} className="text-xs font-semibold text-red-600 hover:underline">
              Cancel this bill
            </button>
          ) : (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3">
              <p className="text-sm text-red-700">Cancel this bill? The payment link will stop working.</p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  disabled={cancelling}
                  onClick={handleCancel}
                  className="rounded-full bg-red-600 px-3 py-1 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
                >
                  {cancelling ? "Cancelling..." : "Yes, Cancel"}
                </button>
                <button type="button" onClick={() => setConfirmingCancel(false)} className="text-xs text-ink/50 hover:text-ink">
                  Never mind
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
