import { useEffect, useState } from "react";
import { ApiError, fetchMyCafeSales, type MyCafeSalesSummary } from "../lib/api";
import { peso } from "../lib/money";

const RANGES = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
];

const dayLabel = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-PH", { timeZone: "UTC", month: "short", day: "numeric" });

// Aggregated sales for one café, live from MyCafe: totals, a bar per day, how it was
// paid and the top products. Nothing here identifies a customer, a staff member or an
// order. Dates are Manila days, the same days the café's own reports use.
export default function MyCafeSalesCard({ clientId }: { clientId: string }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<MyCafeSalesSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    const to = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
    const from = new Date(Date.parse(`${to}T00:00:00Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10);
    fetchMyCafeSales(clientId, from, to)
      .then((d) => live && setData(d))
      .catch((err) => live && setError(err instanceof ApiError ? err.message : "Could not load sales."));
    return () => {
      live = false;
    };
  }, [clientId, days]);

  const max = data ? Math.max(1, ...data.daily.map((d) => d.netCentavos)) : 1;

  return (
    <section className="rounded-xl border border-ink/10 bg-white p-4 sm:p-5 lg:col-span-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-bold uppercase tracking-wide text-ink/50">Sales</h2>
        <div className="flex gap-1.5" role="tablist" aria-label="Sales period">
          {RANGES.map((r) => (
            <button
              key={r.days}
              type="button"
              role="tab"
              aria-selected={days === r.days}
              onClick={() => setDays(r.days)}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold ${days === r.days ? "bg-mycafe text-white" : "border border-ink/15 text-ink/70 hover:bg-paper-alt"}`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      {!data && !error && <p className="mt-3 text-sm text-ink/50">Loading&hellip;</p>}

      {data && (
        <>
          <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ["Net sales", peso(data.netCentavos)],
              ["Orders", String(data.orderCount)],
              ["Average order", peso(data.averageOrderCentavos)],
              ["Refunds", peso(data.refundCentavos)],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg bg-mycafe-soft/60 p-3">
                <dt className="text-xs text-ink/50">{label}</dt>
                <dd className="mt-0.5 text-lg font-bold text-mycafe-dark">{value}</dd>
              </div>
            ))}
          </dl>

          {data.orderCount === 0 ? (
            <p className="mt-4 rounded-lg border border-dashed border-ink/15 p-4 text-center text-sm text-ink/40">No sales in this period.</p>
          ) : (
            <>
              <div className="mt-5">
                <p className="text-xs font-semibold text-ink/50">
                  Net sales per day, {dayLabel(data.from)} &ndash; {dayLabel(data.to)}
                </p>
                <div className="mt-2 flex h-28 items-end gap-px sm:gap-0.5" role="img" aria-label={`Daily net sales, ${peso(data.netCentavos)} in total`}>
                  {data.daily.map((d) => (
                    <div key={d.date} className="group relative flex h-full min-w-0 flex-1 items-end">
                      <div
                        className={`w-full rounded-t-sm ${d.netCentavos > 0 ? "bg-mycafe" : "bg-ink/10"}`}
                        style={{ height: `${d.netCentavos > 0 ? Math.max(4, (d.netCentavos / max) * 100) : 2}%` }}
                        title={`${dayLabel(d.date)}: ${peso(d.netCentavos)} · ${d.orders} order${d.orders === 1 ? "" : "s"}`}
                      />
                    </div>
                  ))}
                </div>
              </div>

              <div className="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-2">
                <div className="min-w-0">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-ink/40">How it was paid</h3>
                  <ul className="mt-2 space-y-1.5 text-sm">
                    {data.paymentBreakdown.map((p) => (
                      <li key={p.method} className="flex justify-between gap-3">
                        <span className="capitalize text-ink/70">{p.method.replace("_", " ")}</span>
                        <span className="font-semibold text-ink">{peso(p.amountCentavos)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="min-w-0">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-ink/40">Top products</h3>
                  <ul className="mt-2 space-y-1.5 text-sm">
                    {data.topProducts.map((p) => (
                      <li key={p.name} className="flex justify-between gap-3">
                        <span className="min-w-0 truncate text-ink/70">
                          {p.name} <span className="text-ink/40">&times;{p.units}</span>
                        </span>
                        <span className="shrink-0 font-semibold text-ink">{peso(p.revenueCentavos)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
              {data.deliveryFeeCentavos > 0 && (
                <p className="mt-4 text-xs text-ink/40">Delivery fees customers paid on top ({peso(data.deliveryFeeCentavos)}) are not part of these sales.</p>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
