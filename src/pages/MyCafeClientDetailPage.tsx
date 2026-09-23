import { useCallback, useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import {
  fetchMyCafeClientDetail,
  fetchMyCafeDevices,
  provisionMyCafeClient,
  mintMyCafeDeviceToken,
  revokeMyCafeDevice,
  addClientActivity,
  isMyCafeAdmin,
  ApiError,
  type MyCafeClientDetail,
  type MyCafeDeviceRow,
} from "../lib/api";
import { useMe } from "../lib/MeContext";

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-ink/10 bg-white p-5">
      <h2 className="text-sm font-bold uppercase tracking-wide text-ink/50">{title}</h2>
      <div className="mt-3">{children}</div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-ink/40">{label}</dt>
      <dd className="text-sm text-ink">{value ?? "—"}</dd>
    </div>
  );
}

const ENTITLEMENT_LABEL: Record<string, string> = {
  trial: "Trial",
  trial_expired: "Expired",
  core: "Core",
  pro: "Pro",
  business: "Business",
  enterprise: "Enterprise",
};

export default function MyCafeClientDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { staffUser } = useMe();
  const canAdminister = isMyCafeAdmin(staffUser);

  const [detail, setDetail] = useState<MyCafeClientDetail | null>(null);
  const [devices, setDevices] = useState<MyCafeDeviceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tokenResult, setTokenResult] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const load = useCallback(() => {
    if (!id) return;
    setLoading(true);
    Promise.all([fetchMyCafeClientDetail(id), fetchMyCafeDevices(id)])
      .then(([d, dev]) => {
        setDetail(d);
        setDevices(dev);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Failed to load this client."))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const run = async (action: () => Promise<unknown>) => {
    if (!id) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  // Not routed through run(): a provision call that returns but doesn't
  // finish (status still "provisioning") is not a thrown error, so the
  // client's now-current state should still reload either way -- matching
  // MyCafePage's list-view handling of the exact same call.
  const handleProvision = async () => {
    if (!id) return;
    setBusy(true);
    setError(null);
    setTokenResult(null);
    try {
      const result = await provisionMyCafeClient(id);
      if (result.deviceActivationToken) setTokenResult(result.deviceActivationToken);
      if (result.status !== "active") {
        setError(`Provisioning didn't finish (still "${result.status}"): ${result.error ?? "no reason given"}. Click "Provision" again to retry from where it stopped.`);
      }
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not provision this cafe.");
    } finally {
      setBusy(false);
    }
  };

  const handleNewDevice = () =>
    run(async () => {
      if (!id) return;
      const result = await mintMyCafeDeviceToken(id);
      setTokenResult(result.deviceActivationToken);
    });

  const handleRevoke = (deviceId: string) => {
    if (!id) return;
    if (!window.confirm("Revoke this device? It will stop working immediately.")) return;
    run(() => revokeMyCafeDevice(id, deviceId));
  };

  if (loading) return <p className="text-sm text-ink/50">Loading&hellip;</p>;
  if (!detail) return <p className="text-sm text-red-600">{error ?? "Could not load this client."}</p>;

  const { client, cafe, cafeError, activity } = detail;

  return (
    <div>
      <Link to="/mycafe" className="text-xs font-semibold text-brand-blue hover:underline">
        &larr; Back to MyCafe POS
      </Link>

      <div className="mt-2 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-brand-navy">{client.businessName}</h1>
          <p className="mt-1 text-sm text-ink/50">{client.fullName} &middot; {client.email}</p>
        </div>
        <span
          className={`rounded-full px-3 py-1 text-xs font-semibold ${
            client.mycafeStatus === "active"
              ? "bg-green-100 text-green-700"
              : client.mycafeCafeId
                ? "bg-amber-100 text-amber-700"
                : "bg-ink/10 text-ink/60"
          }`}
        >
          {client.mycafeStatus ?? "not provisioned"}
        </span>
      </div>

      {error && <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {tokenResult && (
        <div className="mt-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          <p className="font-semibold">Device activation token (copy this now — it won't be shown again):</p>
          <p className="mt-1 select-all break-all rounded bg-white px-3 py-2 font-mono text-base text-ink">{tokenResult}</p>
          <button type="button" onClick={() => setTokenResult(null)} className="mt-2 text-xs font-semibold text-green-700 underline">
            Dismiss
          </button>
        </div>
      )}

      <div className="mt-6 grid gap-5 lg:grid-cols-2">
        <Card title="Account">
          <dl className="grid grid-cols-2 gap-3">
            <Field label="Owner" value={client.fullName} />
            <Field label="Email" value={client.email} />
            <Field label="Store name" value={client.mycafeStoreName} />
            <Field label="Slug" value={client.mycafeSlug} />
            <Field label="Client since" value={new Date(client.createdAt).toLocaleDateString()} />
            <Field label="Last updated" value={new Date(client.updatedAt).toLocaleDateString()} />
          </dl>
        </Card>

        <Card title="Plan & Licensing">
          {cafeError && <p className="text-sm text-red-600">{cafeError}</p>}
          {!client.mycafeCafeId ? (
            <div>
              <p className="text-sm text-ink/60">Not provisioned yet.</p>
              {canAdminister && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={handleProvision}
                  className="mt-3 rounded-full bg-brand-blue px-4 py-2 text-xs font-semibold text-white hover:bg-[#0b57cc] disabled:opacity-50"
                >
                  {busy ? "Working…" : "Provision"}
                </button>
              )}
            </div>
          ) : !cafe ? (
            <p className="text-sm text-ink/40">Plan details unavailable right now.</p>
          ) : (
            <dl className="grid grid-cols-2 gap-3">
              <Field
                label="State"
                value={cafe.entitlement ? (ENTITLEMENT_LABEL[cafe.entitlement.state] ?? cafe.entitlement.state) : "—"}
              />
              <Field label="Tier" value={cafe.tier ? cafe.tier.charAt(0).toUpperCase() + cafe.tier.slice(1) : "—"} />
              <Field
                label="Trial ends"
                value={cafe.entitlement ? new Date(cafe.entitlement.trialEndsAt).toLocaleDateString() : "—"}
              />
              <Field
                label="Days remaining (trial)"
                value={cafe.entitlement?.state === "trial" ? cafe.entitlement.daysRemaining : "—"}
              />
              <Field
                label="Current period ends"
                value={cafe.entitlement?.currentPeriodEndsAt ? new Date(cafe.entitlement.currentPeriodEndsAt).toLocaleDateString() : "—"}
              />
              <Field label="Branch limit" value={cafe.branchLimit ?? "—"} />
            </dl>
          )}
        </Card>

        {cafe && (
          <Card title="Branches">
            {cafe.branches.length === 0 ? (
              <p className="text-sm text-ink/40">No branches.</p>
            ) : (
              <ul className="space-y-1.5 text-sm text-ink/70">
                {cafe.branches.map((b) => (
                  <li key={b.id} className="flex items-center justify-between">
                    <span>{b.name}</span>
                    <span className={b.active ? "text-green-700" : "text-ink/40"}>{b.active ? "Active" : "Inactive"}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}

        {client.mycafeCafeId && (
          <Card title="Devices">
            <div className="flex justify-end">
              {canAdminister && client.mycafeStatus === "active" && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={handleNewDevice}
                  className="mb-2 rounded-full border border-ink/15 px-3 py-1 text-xs font-semibold text-ink/70 hover:bg-paper-alt disabled:opacity-50"
                >
                  {busy ? "Working…" : "New device token"}
                </button>
              )}
            </div>
            {devices.length === 0 ? (
              <p className="text-sm text-ink/40">No devices registered.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {devices.map((d) => (
                  <li key={d.id} className="flex items-center justify-between border-b border-ink/5 pb-2 last:border-0">
                    <div>
                      <p className="font-semibold text-ink">{d.deviceName}</p>
                      <p className="text-xs text-ink/40">
                        {d.branchName ?? "No branch"} &middot; Registered {new Date(d.createdAt).toLocaleDateString()}
                        {d.lastUsedAt && <> &middot; Last used {new Date(d.lastUsedAt).toLocaleDateString()}</>}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                          d.active ? "bg-green-100 text-green-700" : "bg-ink/10 text-ink/50"
                        }`}
                      >
                        {d.active ? "Active" : "Revoked"}
                      </span>
                      {canAdminister && d.active && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => handleRevoke(d.id)}
                          className="text-xs font-semibold text-red-600 hover:underline disabled:opacity-50"
                        >
                          Revoke
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}

        <Card title="Activity">
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="Add a note&hellip;"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="flex-1 rounded border border-ink/15 px-2 py-1.5 text-xs"
            />
            <button
              type="button"
              disabled={busy || !note.trim()}
              onClick={() => {
                if (!id) return;
                run(() => addClientActivity(id, note.trim()));
                setNote("");
              }}
              className="rounded-full bg-brand-blue px-3 py-1 text-xs font-semibold text-white hover:bg-[#0b57cc] disabled:opacity-50"
            >
              Add
            </button>
          </div>
          <ul className="mt-3 space-y-2 text-xs text-ink/60">
            {activity.map((a) => (
              <li key={a.id}>
                <span className="font-semibold text-ink/80">{a.type}:</span> {a.description}
                <span className="ml-1 text-ink/40">({new Date(a.created_at).toLocaleString()})</span>
              </li>
            ))}
            {activity.length === 0 && <li className="text-ink/40">No activity yet.</li>}
          </ul>
        </Card>
      </div>
    </div>
  );
}
