import type { MyCafeUsage } from "../lib/api";
import { peso } from "../lib/money";

const when = (iso: string | null) => {
  if (!iso) return "never";
  const normalised = /[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso.replace(" ", "T")}Z`;
  return new Date(normalised).toLocaleString("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

const ACTION_LABEL: Record<string, string> = {
  suspend: "Suspended",
  reactivate: "Reactivated",
  extend_trial: "Trial extended",
};

const KIND_LABEL: Record<string, string> = {
  tier_purchase: "Plan payment",
  refund: "Refund",
  adjustment: "Adjustment",
};

// Usage signals and billing history, live from MyCafe.
export default function MyCafeUsageCard({ usage, error }: { usage: MyCafeUsage | null; error: string | null }) {
  return (
    <section className="rounded-xl border border-ink/10 bg-white p-4 sm:p-5">
      <h2 className="text-sm font-bold uppercase tracking-wide text-ink/50">Usage &amp; billing</h2>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      {!usage && !error && <p className="mt-3 text-sm text-ink/50">Loading&hellip;</p>}
      {usage && (
        <>
          <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-xs text-ink/40">Last order</dt>
              <dd className="font-semibold text-ink">{when(usage.lastOrderAt)}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink/40">Last device use</dt>
              <dd className="font-semibold text-ink">{when(usage.lastDeviceUseAt)}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink/40">Orders, 7 / 30 days</dt>
              <dd className="font-semibold text-ink">
                {usage.orders7d} / {usage.orders30d}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-ink/40">Staff / open shifts</dt>
              <dd className="font-semibold text-ink">
                {usage.activeStaff} / {usage.openShifts}
              </dd>
            </div>
          </dl>

          <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide text-ink/40">Billing history</h3>
          {usage.billing.length === 0 ? (
            <p className="mt-2 text-sm text-ink/40">No payments recorded.</p>
          ) : (
            <ul className="mt-2 space-y-2 text-sm">
              {usage.billing.map((b) => (
                <li key={b.id} className="flex items-start justify-between gap-3 border-b border-ink/5 pb-2 last:border-0">
                  <div className="min-w-0">
                    <p className="font-semibold text-ink">{KIND_LABEL[b.kind] ?? b.kind}</p>
                    <p className="truncate text-xs text-ink/40">
                      {when(b.createdAt)}
                      {b.reference ? ` · ${b.reference}` : ""}
                    </p>
                  </div>
                  <span className="shrink-0 font-semibold text-ink">{peso(b.amountCentavos)}</span>
                </li>
              ))}
            </ul>
          )}

          {usage.actions.length > 0 && (
            <>
              <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide text-ink/40">Account actions</h3>
              <ul className="mt-2 space-y-1.5 text-xs text-ink/60">
                {usage.actions.map((a, i) => (
                  <li key={i}>
                    <span className="font-semibold text-ink/80">{ACTION_LABEL[a.action] ?? a.action}</span>
                    {a.reason ? `: ${a.reason}` : ""}
                    <span className="ml-1 text-ink/40">
                      ({a.actor ?? "unknown"}, {when(a.createdAt)})
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}
