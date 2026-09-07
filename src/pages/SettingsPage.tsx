import { useEffect, useState } from "react";
import { useMe } from "../lib/MeContext";
import {
  fetchAvailabilityRules,
  addAvailabilityRule,
  deleteAvailabilityRule,
  ApiError,
  type AvailabilityRule,
} from "../lib/api";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function formatTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${period}`;
}

function AvailabilitySettings() {
  const [rules, setRules] = useState<AvailabilityRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [dayOfWeek, setDayOfWeek] = useState(1);
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("17:00");

  const load = () => {
    setLoading(true);
    fetchAvailabilityRules()
      .then(setRules)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Failed to load availability."))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const handleAdd = async () => {
    setBusy(true);
    setError(null);
    try {
      await addAvailabilityRule({ dayOfWeek, startTime, endTime });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to add rule.");
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await deleteAvailabilityRule(id);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to delete rule.");
    } finally {
      setBusy(false);
    }
  };

  const rulesByDay = DAY_NAMES.map((name, day) => ({
    day,
    name,
    rules: rules.filter((r) => r.day_of_week === day),
  }));

  return (
    <div className="mt-4 max-w-md rounded-xl border border-ink/10 bg-white p-5">
      <h2 className="text-sm font-bold uppercase tracking-wide text-ink/50">Availability</h2>
      <p className="mt-1 text-xs text-ink/50">
        Your weekly discovery-call availability (Asia/Manila). Clients pick from open 45-minute slots (with a 15-minute
        buffer between calls) generated from this template. Presentation scheduling checks the same slots to avoid
        double-booking.
      </p>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      {!loading && (
        <ul className="mt-3 space-y-2 text-sm">
          {rulesByDay.map(({ day, name, rules: dayRules }) => (
            <li key={day}>
              <span className="font-semibold text-ink/70">{name}:</span>{" "}
              {dayRules.length === 0 ? (
                <span className="text-ink/40">closed</span>
              ) : (
                dayRules.map((r) => (
                  <span key={r.id} className="mr-2 inline-flex items-center gap-1">
                    {formatTime(r.start_time)}&ndash;{formatTime(r.end_time)}
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => handleDelete(r.id)}
                      aria-label={`Remove ${name} ${formatTime(r.start_time)}-${formatTime(r.end_time)}`}
                      className="text-ink/30 hover:text-red-600 disabled:opacity-50"
                    >
                      &times;
                    </button>
                  </span>
                ))
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-ink/10 pt-4">
        <div>
          <label className="block text-xs text-ink/50">Day</label>
          <select
            value={dayOfWeek}
            onChange={(e) => setDayOfWeek(Number(e.target.value))}
            className="mt-1 rounded border border-ink/15 px-2 py-1.5 text-xs"
          >
            {DAY_NAMES.map((name, day) => (
              <option key={day} value={day}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-ink/50">Start</label>
          <input
            type="time"
            value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
            className="mt-1 rounded border border-ink/15 px-2 py-1.5 text-xs"
          />
        </div>
        <div>
          <label className="block text-xs text-ink/50">End</label>
          <input
            type="time"
            value={endTime}
            onChange={(e) => setEndTime(e.target.value)}
            className="mt-1 rounded border border-ink/15 px-2 py-1.5 text-xs"
          />
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={handleAdd}
          className="rounded-full bg-brand-blue px-4 py-1.5 text-xs font-semibold text-white hover:bg-[#0b57cc] disabled:opacity-50"
        >
          Add
        </button>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const { staffUser } = useMe();

  return (
    <div>
      <h1 className="text-2xl font-bold text-brand-navy">Settings</h1>

      <div className="mt-6 max-w-md rounded-xl border border-ink/10 bg-white p-5">
        <h2 className="text-sm font-bold uppercase tracking-wide text-ink/50">Your Account</h2>
        <dl className="mt-3 space-y-1.5 text-sm">
          <div className="flex justify-between">
            <dt className="text-ink/50">Name</dt>
            <dd>{staffUser.full_name || "—"}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink/50">Email</dt>
            <dd>{staffUser.email}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink/50">Role</dt>
            <dd className="capitalize">{staffUser.role}</dd>
          </div>
        </dl>
      </div>

      <AvailabilitySettings />

      <div className="mt-4 max-w-md rounded-xl border border-ink/10 bg-white p-5 text-sm text-ink/60">
        <h2 className="text-sm font-bold uppercase tracking-wide text-ink/50">Adding Staff</h2>
        <p className="mt-2">
          There's no self-service "add a staff member" flow in V1. To add someone: invite them directly via the WorkOS
          dashboard, have them sign in once here, confirm their WorkOS user id, then insert a row into the shared{" "}
          <code className="rounded bg-paper-alt px-1 py-0.5">users</code> table with their role (owner, developer, admin,
          or sales).
        </p>
      </div>
    </div>
  );
}
