import { useState } from "react";
import { ApiError, extendMyCafeTrial, reactivateMyCafe, suspendMyCafe, type MyCafeUsage } from "../lib/api";

// Owner/admin only. Suspend puts the café on hold (its POS and Owner Panel stop at
// once and say why; nothing is deleted and devices stay paired). Reactivate lifts
// it. Extend trial adds days to a trial. Every action is audited on both sides.
export default function MyCafeAccountActionsCard({
  clientId,
  usage,
  onChanged,
}: {
  clientId: string;
  usage: MyCafeUsage | null;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [days, setDays] = useState(14);
  const [trialReason, setTrialReason] = useState("");

  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(done);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  const suspended = usage?.status === "suspended";
  const active = usage?.status === "active";
  const field = "mt-1 w-full rounded-lg border border-ink/15 px-3 py-2.5 text-base outline-none focus:border-mycafe sm:text-sm";

  return (
    <section className="rounded-xl border border-ink/10 bg-white p-4 sm:p-5">
      <h2 className="text-sm font-bold uppercase tracking-wide text-ink/50">Account actions</h2>
      {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {notice && <p className="mt-3 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">{notice}</p>}
      {!usage && <p className="mt-3 text-sm text-ink/50">Loading&hellip;</p>}

      {usage && suspended && (
        <div className="mt-3">
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
            <strong>Suspended.</strong> {usage.suspendedReason}
          </p>
          <p className="mt-2 text-xs text-ink/50">Their POS and Owner Panel show an &ldquo;account suspended&rdquo; screen. Devices are still paired.</p>
          <button
            type="button"
            disabled={busy}
            onClick={() => window.confirm("Reactivate this café? Their POS and Owner Panel work again immediately.") && void run(() => reactivateMyCafe(clientId), "Reactivated.")}
            className="mt-3 w-full rounded-full bg-mycafe px-5 py-3 text-sm font-semibold text-white hover:bg-mycafe-dark disabled:opacity-50 sm:w-auto sm:py-2.5"
          >
            {busy ? "Working…" : "Reactivate café"}
          </button>
        </div>
      )}

      {usage && active && (
        <div className="mt-3 space-y-6">
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink/40">Extend trial</h3>
            <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-[8rem_1fr]">
              <label className="text-sm font-semibold text-ink">
                Days
                <select value={days} onChange={(e) => setDays(Number(e.target.value))} className={field}>
                  {[7, 14, 30, 60].map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm font-semibold text-ink">
                Reason (optional)
                <input value={trialReason} onChange={(e) => setTrialReason(e.target.value)} maxLength={300} className={field} placeholder="Onboarding delay" />
              </label>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => extendMyCafeTrial(clientId, days, trialReason.trim()), `Trial extended by ${days} days.`)}
              className="mt-3 w-full rounded-full border border-ink/20 px-5 py-3 text-sm font-semibold text-ink/70 hover:bg-paper-alt disabled:opacity-50 sm:w-auto sm:py-2.5"
            >
              {busy ? "Working…" : `Extend trial by ${days} days`}
            </button>
          </div>

          <div className="border-t border-ink/10 pt-5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-red-600">Suspend</h3>
            <p className="mt-1 text-xs text-ink/50">Stops their POS and Owner Panel at once. Nothing is deleted; reactivate any time.</p>
            <label className="mt-2 block text-sm font-semibold text-ink">
              Reason (required, shown to them)
              <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} className={field} placeholder="Unpaid invoice" />
            </label>
            <button
              type="button"
              disabled={busy || !reason.trim()}
              onClick={() => window.confirm("Suspend this café? Their POS stops working immediately.") && void run(() => suspendMyCafe(clientId, reason.trim()), "Suspended.")}
              className="mt-3 w-full rounded-full border border-red-300 px-5 py-3 text-sm font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50 sm:w-auto sm:py-2.5"
            >
              {busy ? "Working…" : "Suspend café"}
            </button>
          </div>
        </div>
      )}

      {usage && !active && !suspended && <p className="mt-3 text-sm text-ink/50">Available once the café is active.</p>}
    </section>
  );
}
