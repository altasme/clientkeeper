import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { adoptMyCafeCafe, ApiError, fetchMyCafeCafes, isMyCafeAdmin, type MyCafeAllCafes, type MyCafeCafeRow } from "../lib/api";
import { peso } from "../lib/money";
import { useMe } from "../lib/MeContext";

const PERIODS = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
];

const SORTS = [
  { value: "sales", label: "Most sales" },
  { value: "recent", label: "Latest order" },
  { value: "name", label: "Name" },
  { value: "joined", label: "Newest" },
] as const;
type Sort = (typeof SORTS)[number]["value"];

const FILTERS = [
  { value: "", label: "All" },
  { value: "paid", label: "Paid" },
  { value: "trial", label: "Trial" },
  { value: "expired", label: "Expired" },
  { value: "suspended", label: "Suspended" },
  { value: "setup", label: "Setting up" },
];

// One chip per café: suspended and setting-up win over the plan state.
function stateChip(c: MyCafeCafeRow): { label: string; className: string } {
  if (c.status === "suspended") return { label: "Suspended", className: "bg-red-100 text-red-700" };
  if (c.status !== "active") return { label: "Setting up", className: "bg-amber-100 text-amber-800" };
  switch (c.entitlementState) {
    case "trial":
      return { label: c.daysRemaining != null ? `Trial · ${c.daysRemaining}d left` : "Trial", className: "bg-sky-100 text-sky-800" };
    case "trial_expired":
      return { label: "Expired", className: "bg-amber-100 text-amber-800" };
    case null:
      return { label: "—", className: "bg-ink/10 text-ink/60" };
    default:
      return { label: c.tier ? c.tier.charAt(0).toUpperCase() + c.tier.slice(1) : "Paid", className: "bg-green-100 text-green-700" };
  }
}

const matchesFilter = (c: MyCafeCafeRow, f: string) => {
  switch (f) {
    case "paid":
      return c.status === "active" && !!c.entitlementState && c.entitlementState !== "trial" && c.entitlementState !== "trial_expired";
    case "trial":
      return c.status === "active" && c.entitlementState === "trial";
    case "expired":
      return c.status === "active" && c.entitlementState === "trial_expired";
    case "suspended":
      return c.status === "suspended";
    case "setup":
      return c.status === "provisioning";
    default:
      return true;
  }
};

const ago = (iso: string | null) => {
  if (!iso) return "never";
  const normalised = /[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso.replace(" ", "T")}Z`;
  const mins = Math.round((Date.now() - new Date(normalised).getTime()) / 60_000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days < 60 ? `${days} d ago` : new Date(normalised).toLocaleDateString("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric", year: "numeric" });
};

// Every café on MyCafe POS, with its sales for the period, whether or not it was ever
// added to ClientKeeper as a client. Cafés that signed up on their own can be added
// (owner/admin) so they get a detail page; the rest open straight away.
export default function MyCafeAllCafesView() {
  const { staffUser } = useMe();
  const canAdminister = isMyCafeAdmin(staffUser);
  const navigate = useNavigate();
  const [days, setDays] = useState(30);
  const [data, setData] = useState<MyCafeAllCafes | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<Sort>("sales");
  const [busyCafe, setBusyCafe] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    fetchMyCafeCafes(days)
      .then((d) => live && setData(d))
      .catch((err) => live && setError(err instanceof ApiError ? err.message : "Could not load the cafés."));
    return () => {
      live = false;
    };
  }, [days]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = (data?.cafes ?? []).filter(
      (c) =>
        matchesFilter(c, filter) &&
        (!needle || [c.businessName, c.storeName, c.ownerName, c.ownerEmail].some((v) => v.toLowerCase().includes(needle))),
    );
    const byName = (a: MyCafeCafeRow, b: MyCafeCafeRow) => a.businessName.localeCompare(b.businessName);
    return [...list].sort((a, b) => {
      switch (sort) {
        case "sales":
          return b.netCentavos - a.netCentavos || byName(a, b);
        case "recent":
          return (b.lastOrderAt ?? "").localeCompare(a.lastOrderAt ?? "") || byName(a, b);
        case "joined":
          return b.createdAt.localeCompare(a.createdAt);
        default:
          return byName(a, b);
      }
    });
  }, [data, q, filter, sort]);

  const adopt = async (c: MyCafeCafeRow) => {
    setBusyCafe(c.cafeId);
    setActionError(null);
    try {
      const result = await adoptMyCafeCafe(c.cafeId);
      navigate(`/mycafe/cafes/${result.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && typeof err.body?.clientId === "string") {
        setActionError(`${err.message} Open that client instead.`);
        setData((d) => d && { ...d, cafes: d.cafes.map((x) => (x.cafeId === c.cafeId ? { ...x, clientId: String(err.body!.clientId) } : x)) });
      } else {
        setActionError(err instanceof ApiError ? err.message : "Could not add this café.");
      }
    } finally {
      setBusyCafe(null);
    }
  };

  const open = (c: MyCafeCafeRow) =>
    c.clientId ? (
      <Link to={`/mycafe/cafes/${c.clientId}`} className="rounded-full border border-ink/15 px-3 py-1.5 text-xs font-semibold text-mycafe hover:bg-mycafe-soft">
        Open
      </Link>
    ) : canAdminister ? (
      <button
        type="button"
        disabled={busyCafe === c.cafeId}
        onClick={() => void adopt(c)}
        className="rounded-full bg-mycafe px-3 py-1.5 text-xs font-semibold text-white hover:bg-mycafe-dark disabled:opacity-50"
      >
        {busyCafe === c.cafeId ? "Adding…" : "Add to ClientKeeper"}
      </button>
    ) : (
      <span className="text-xs text-ink/40">Not a client yet</span>
    );

  const field = "w-full rounded-lg border border-ink/15 px-3 py-2.5 text-base outline-none focus:border-mycafe sm:text-sm";

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="Sales period" className="flex gap-1.5">
          {PERIODS.map((p) => (
            <button
              key={p.days}
              type="button"
              role="tab"
              aria-selected={days === p.days}
              onClick={() => setDays(p.days)}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold ${days === p.days ? "bg-mycafe text-white" : "border border-ink/15 text-ink/70 hover:bg-paper-alt"}`}
            >
              {p.label}
            </button>
          ))}
        </div>
        {data && (
          <p className="text-sm text-ink/60">
            All cafés: <strong className="text-mycafe-dark">{peso(data.totalNetCentavos)}</strong> from {data.totalOrders.toLocaleString()} orders
          </p>
        )}
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto_auto]">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search café, store, owner or email" className={field} />
        <select value={filter} onChange={(e) => setFilter(e.target.value)} className={field} aria-label="Filter">
          {FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className={field} aria-label="Sort">
          {SORTS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      {error && <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {actionError && <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{actionError}</p>}
      {!data && !error && <p className="mt-4 text-sm text-ink/50">Loading&hellip;</p>}
      {data && <p className="mt-3 text-xs text-ink/40">{rows.length} of {data.cafes.length} cafés &middot; sales for the last {days} days</p>}

      {/* Phones: a card per café. md+: a table. */}
      <ul className="mt-3 space-y-3 md:hidden">
        {rows.map((c) => {
          const chip = stateChip(c);
          return (
            <li key={c.cafeId} className="rounded-xl border border-ink/10 bg-white p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-semibold text-ink">{c.businessName}</p>
                  <p className="truncate text-xs text-ink/50">
                    {c.ownerName} &middot; {c.ownerEmail}
                  </p>
                </div>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${chip.className}`}>{chip.label}</span>
              </div>
              <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
                <div>
                  <dt className="text-ink/40">Sales</dt>
                  <dd className="font-bold text-mycafe-dark">{peso(c.netCentavos)}</dd>
                </div>
                <div>
                  <dt className="text-ink/40">Orders</dt>
                  <dd className="font-semibold text-ink">{c.orderCount}</dd>
                </div>
                <div>
                  <dt className="text-ink/40">Last order</dt>
                  <dd className="font-semibold text-ink">{ago(c.lastOrderAt)}</dd>
                </div>
              </dl>
              <div className="mt-3">{open(c)}</div>
            </li>
          );
        })}
        {data && rows.length === 0 && <li className="rounded-xl border border-ink/10 bg-white p-6 text-center text-sm text-ink/40">No cafés match.</li>}
      </ul>

      <div className="mt-3 hidden overflow-x-auto rounded-xl border border-ink/10 bg-white md:block">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-ink/10 text-xs uppercase tracking-wide text-ink/40">
            <tr>
              <th className="px-3 py-3">Café</th>
              <th className="px-3 py-3">Owner</th>
              <th className="px-3 py-3">Plan</th>
              <th className="px-3 py-3 text-right">Sales</th>
              <th className="px-3 py-3 text-right">Orders</th>
              <th className="px-3 py-3">Last order</th>
              <th className="hidden px-3 py-3 xl:table-cell">Devices</th>
              <th className="px-3 py-3" />
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const chip = stateChip(c);
              return (
                <tr key={c.cafeId} className="border-b border-ink/5 last:border-0 hover:bg-paper-alt">
                  <td className="max-w-[12rem] px-3 py-3">
                    <p className="truncate font-semibold text-ink">{c.businessName}</p>
                    {c.storeName !== c.businessName && <p className="truncate text-xs text-ink/40">{c.storeName}</p>}
                  </td>
                  <td className="max-w-[11rem] px-3 py-3">
                    <p className="truncate text-ink/80">{c.ownerName}</p>
                    <p className="truncate text-xs text-ink/40">{c.ownerEmail}</p>
                  </td>
                  <td className="px-3 py-3">
                    <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${chip.className}`}>{chip.label}</span>
                  </td>
                  <td className="px-3 py-3 text-right font-semibold text-mycafe-dark">{peso(c.netCentavos)}</td>
                  <td className="px-3 py-3 text-right text-ink/70">{c.orderCount}</td>
                  <td className="whitespace-nowrap px-3 py-3 text-ink/60">{ago(c.lastOrderAt)}</td>
                  <td className="hidden px-3 py-3 text-ink/60 xl:table-cell">
                    {c.activeDeviceCount}/{c.deviceCount}
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-right">{open(c)}</td>
                </tr>
              );
            })}
            {data && rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-ink/40">
                  No cafés match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
