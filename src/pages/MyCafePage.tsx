import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import MyCafeAllCafesView from "../components/MyCafeAllCafes";
import {
  fetchMyCafeClients,
  provisionMyCafeClient,
  mintMyCafeDeviceToken,
  isMyCafeAdmin,
  ApiError,
  type MyCafeClientRow,
} from "../lib/api";
import { useMe } from "../lib/MeContext";
import AddMyCafeClientModal from "../components/AddMyCafeClientModal";

const STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "active", label: "Active" },
  { value: "provisioning", label: "Provisioning" },
  { value: "not_provisioned", label: "Not provisioned" },
];

// MyCafe POS clients: a second product line, deliberately kept off the
// web_dev Clients page and its stage machine (see CLAUDE.md's MyCafe
// section). "Provision" and "New device token" both return a plaintext
// token exactly once, in the response body only — never stored here, same
// rule MyCafe's own API follows for it — so this page's job is to surface
// it clearly right after the call and make staff copy it before navigating
// away, not to make it retrievable later.
function ClientsAndProvisioning() {
  const { staffUser } = useMe();
  const canAdminister = isMyCafeAdmin(staffUser);

  const [clients, setClients] = useState<MyCafeClientRow[]>([]);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [busyClientId, setBusyClientId] = useState<string | null>(null);
  const [tokenResult, setTokenResult] = useState<{ clientId: string; token: string } | null>(null);

  const load = () => {
    setLoading(true);
    fetchMyCafeClients({ q: q || undefined, status: status || undefined })
      .then(setClients)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    setLoading(true);
    const handle = setTimeout(load, 250);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, status]);

  const handleProvision = async (clientId: string) => {
    setBusyClientId(clientId);
    setError(null);
    setTokenResult(null);
    try {
      const result = await provisionMyCafeClient(clientId);
      if (result.deviceActivationToken) {
        setTokenResult({ clientId, token: result.deviceActivationToken });
      }
      if (result.status !== "active") {
        setError(
          `Provisioning didn't finish (still "${result.status}"): ${result.error ?? "no reason given"}. ` +
            `Click "Resume provisioning" to retry from where it stopped.`,
        );
      }
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not provision this cafe.");
    } finally {
      setBusyClientId(null);
    }
  };

  const handleNewDevice = async (clientId: string) => {
    setBusyClientId(clientId);
    setError(null);
    setTokenResult(null);
    try {
      const result = await mintMyCafeDeviceToken(clientId);
      setTokenResult({ clientId, token: result.deviceActivationToken });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not mint a new device token.");
    } finally {
      setBusyClientId(null);
    }
  };

  const statusBadge = (c: MyCafeClientRow) => (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
        c.mycafeStatus === "active" ? "bg-green-100 text-green-700" : c.mycafeCafeId ? "bg-amber-100 text-amber-700" : "bg-ink/10 text-ink/60"
      }`}
    >
      {c.mycafeStatus ?? "not provisioned"}
    </span>
  );

  const actionButton = (c: MyCafeClientRow) =>
    c.mycafeStatus === "active" ? (
      <button
        type="button"
        disabled={busyClientId === c.id}
        onClick={() => handleNewDevice(c.id)}
        className="rounded-full border border-ink/15 px-3 py-1.5 text-xs font-semibold text-ink/70 hover:bg-paper-alt disabled:opacity-50"
      >
        {busyClientId === c.id ? "Working…" : "New device token"}
      </button>
    ) : (
      <button
        type="button"
        disabled={busyClientId === c.id}
        onClick={() => handleProvision(c.id)}
        className="rounded-full bg-mycafe px-3 py-1.5 text-xs font-semibold text-white hover:bg-mycafe-dark disabled:opacity-50"
      >
        {busyClientId === c.id ? "Working…" : c.mycafeCafeId ? "Resume provisioning" : "Provision"}
      </button>
    );

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-mycafe-dark">Clients &amp; provisioning</h2>
          <p className="mt-1 text-sm text-ink/50">Clients added in ClientKeeper: add them, provision their café and issue device tokens.</p>
        </div>
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          className="w-full rounded-full bg-mycafe px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-mycafe-dark sm:w-auto"
        >
          + Add MyCafe Client
        </button>
      </div>

      <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          type="text"
          placeholder="Search owner, business, or email"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="w-full rounded-lg border border-ink/15 px-3 py-2.5 text-sm outline-none focus:border-mycafe sm:w-72"
        />
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="w-full rounded-lg border border-ink/15 px-3 py-2.5 text-sm outline-none focus:border-mycafe sm:w-auto"
        >
          {STATUS_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      {tokenResult && (
        <div className="mt-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          <p className="font-semibold">Device activation token (copy this now &mdash; it won't be shown again):</p>
          <p className="mt-1 select-all break-all rounded bg-white px-3 py-2 font-mono text-base text-ink">{tokenResult.token}</p>
          <button type="button" onClick={() => setTokenResult(null)} className="mt-2 text-xs font-semibold text-green-700 underline">
            Dismiss
          </button>
        </div>
      )}

      {/* Phones: one card per café. md+: the table. */}
      <ul className="mt-4 space-y-3 md:hidden">
        {clients.map((c) => (
          <li key={c.id} className="rounded-xl border border-ink/10 bg-white p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <Link to={`/mycafe/cafes/${c.id}`} className="block truncate font-semibold text-mycafe hover:underline">
                  {c.businessName}
                </Link>
                <p className="truncate text-sm text-ink/70">{c.fullName}</p>
                <p className="truncate text-xs text-ink/50">{c.email}</p>
              </div>
              {statusBadge(c)}
            </div>
            {canAdminister && <div className="mt-3">{actionButton(c)}</div>}
          </li>
        ))}
        {!loading && clients.length === 0 && (
          <li className="rounded-xl border border-ink/10 bg-white p-6 text-center text-sm text-ink/40">
            {q || status ? "No MyCafe clients match." : "No MyCafe clients yet."}
          </li>
        )}
      </ul>

      <div className="mt-4 hidden overflow-x-auto rounded-xl border border-ink/10 bg-white md:block">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-ink/10 text-xs uppercase tracking-wide text-ink/40">
            <tr>
              <th className="px-4 py-3">Owner</th>
              <th className="px-4 py-3">Business</th>
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Status</th>
              {canAdminister && <th className="px-4 py-3">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {clients.map((c) => (
              <tr key={c.id} className="border-b border-ink/5 last:border-0 hover:bg-paper-alt">
                <td className="px-4 py-3 font-semibold text-ink">
                  <Link to={`/mycafe/cafes/${c.id}`} className="text-mycafe hover:underline">
                    {c.fullName}
                  </Link>
                </td>
                <td className="px-4 py-3 text-ink/70">{c.businessName}</td>
                <td className="px-4 py-3 text-ink/70">{c.email}</td>
                <td className="px-4 py-3">{statusBadge(c)}</td>
                {canAdminister && <td className="px-4 py-3">{actionButton(c)}</td>}
              </tr>
            ))}
            {!loading && clients.length === 0 && (
              <tr>
                <td colSpan={canAdminister ? 5 : 4} className="px-4 py-6 text-center text-ink/40">
                  {q || status ? "No MyCafe clients match." : "No MyCafe clients yet."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <AddMyCafeClientModal open={addOpen} onClose={() => setAddOpen(false)} onCreated={() => { setAddOpen(false); load(); }} />
    </div>
  );
}

// The Cafés section: every café on MyCafe POS with its sales (default), or the
// clients created in ClientKeeper with provisioning actions. The view is kept in the
// URL (?view=clients) so it can be linked to.
export default function MyCafePage() {
  const [params, setParams] = useSearchParams();
  const view = params.get("view") === "clients" ? "clients" : "all";
  const tab = (value: "all" | "clients", label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={view === value}
      onClick={() => setParams(value === "all" ? {} : { view: value }, { replace: true })}
      className={`whitespace-nowrap rounded-full px-4 py-2 text-sm font-semibold ${view === value ? "bg-mycafe text-white" : "border border-ink/15 bg-white text-ink/70 hover:bg-paper-alt"}`}
    >
      {label}
    </button>
  );
  return (
    <div>
      <h1 className="text-2xl font-bold text-mycafe-dark">Cafés</h1>
      <p className="mt-1 text-sm text-ink/50">Every café running MyCafe POS and how it is selling.</p>
      <div role="tablist" aria-label="Café views" className="-mx-4 mt-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        {tab("all", "All cafés")}
        {tab("clients", "Clients & provisioning")}
      </div>
      <div className="mt-5">{view === "all" ? <MyCafeAllCafesView /> : <ClientsAndProvisioning />}</div>
    </div>
  );
}
