import { useEffect, useState } from "react";
import {
  fetchMyCafeClients,
  provisionMyCafeClient,
  mintMyCafeDeviceToken,
  ApiError,
  type MyCafeClientRow,
} from "../lib/api";
import AddMyCafeClientModal from "../components/AddMyCafeClientModal";

// MyCafe POS clients: a second product line, deliberately kept off the
// web_dev Clients page and its stage machine (see CLAUDE.md's MyCafe
// section). "Provision" and "New device token" both return a plaintext
// token exactly once, in the response body only — never stored here, same
// rule MyCafe's own API follows for it — so this page's job is to surface
// it clearly right after the call and make staff copy it before navigating
// away, not to make it retrievable later.
export default function MyCafePage() {
  const [clients, setClients] = useState<MyCafeClientRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [busyClientId, setBusyClientId] = useState<string | null>(null);
  const [tokenResult, setTokenResult] = useState<{ clientId: string; token: string } | null>(null);

  const load = () => {
    setLoading(true);
    fetchMyCafeClients()
      .then(setClients)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const handleProvision = async (clientId: string) => {
    setBusyClientId(clientId);
    setError(null);
    setTokenResult(null);
    try {
      const result = await provisionMyCafeClient(clientId);
      if (result.deviceActivationToken) {
        setTokenResult({ clientId, token: result.deviceActivationToken });
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

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-brand-navy">MyCafe POS</h1>
          <p className="mt-1 text-sm text-ink/50">Cafes running MyCafe POS — a separate product line from web development clients.</p>
        </div>
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          className="rounded-full bg-brand-blue px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#0b57cc]"
        >
          + Add MyCafe Client
        </button>
      </div>

      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      {tokenResult && (
        <div className="mt-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          <p className="font-semibold">Device activation token (copy this now — it won't be shown again):</p>
          <p className="mt-1 select-all break-all rounded bg-white px-3 py-2 font-mono text-base text-ink">{tokenResult.token}</p>
          <button type="button" onClick={() => setTokenResult(null)} className="mt-2 text-xs font-semibold text-green-700 underline">
            Dismiss
          </button>
        </div>
      )}

      <div className="mt-4 overflow-x-auto rounded-xl border border-ink/10 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-ink/10 text-xs uppercase tracking-wide text-ink/40">
            <tr>
              <th className="px-4 py-3">Owner</th>
              <th className="px-4 py-3">Business</th>
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {clients.map((c) => (
              <tr key={c.id} className="border-b border-ink/5 last:border-0 hover:bg-paper-alt">
                <td className="px-4 py-3 font-semibold text-ink">{c.fullName}</td>
                <td className="px-4 py-3 text-ink/70">{c.businessName}</td>
                <td className="px-4 py-3 text-ink/70">{c.email}</td>
                <td className="px-4 py-3">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                      c.mycafeStatus === "active"
                        ? "bg-green-100 text-green-700"
                        : c.mycafeCafeId
                          ? "bg-amber-100 text-amber-700"
                          : "bg-ink/10 text-ink/60"
                    }`}
                  >
                    {c.mycafeStatus ?? "not provisioned"}
                  </span>
                </td>
                <td className="px-4 py-3">
                  {c.mycafeStatus === "active" ? (
                    <button
                      type="button"
                      disabled={busyClientId === c.id}
                      onClick={() => handleNewDevice(c.id)}
                      className="rounded-full border border-ink/15 px-3 py-1 text-xs font-semibold text-ink/70 hover:bg-paper-alt disabled:opacity-50"
                    >
                      {busyClientId === c.id ? "Working…" : "New device token"}
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={busyClientId === c.id}
                      onClick={() => handleProvision(c.id)}
                      className="rounded-full bg-brand-blue px-3 py-1 text-xs font-semibold text-white hover:bg-[#0b57cc] disabled:opacity-50"
                    >
                      {busyClientId === c.id ? "Working…" : c.mycafeCafeId ? "Resume provisioning" : "Provision"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {!loading && clients.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-ink/40">
                  No MyCafe clients yet.
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
