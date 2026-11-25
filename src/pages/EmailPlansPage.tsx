import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import Modal from "../components/Modal";
import { useMe } from "../lib/MeContext";
import { canManageEmail, createEmailPlan, fetchEmailPlans, formatPhp, formatStorage, updateEmailPlan, type EmailPlan, type EmailPlanInput } from "../lib/emailServicesApi";

const inputClass = "w-full rounded-lg border border-ink/15 px-3 py-2 text-sm outline-none focus:border-brand-blue";

interface FormState {
  name: string;
  pricePhp: string;
  billingInterval: "annual" | "monthly";
  includedMailboxes: string;
  storageGb: string;
  additionalMailboxPricePhp: string;
  features: string;
  sortOrder: string;
  status: "active" | "archived";
}

const EMPTY: FormState = { name: "", pricePhp: "", billingInterval: "annual", includedMailboxes: "1", storageGb: "3", additionalMailboxPricePhp: "250", features: "", sortOrder: "100", status: "active" };

function toForm(p: EmailPlan): FormState {
  return {
    name: p.name,
    pricePhp: String(p.pricePhp),
    billingInterval: p.billingInterval,
    includedMailboxes: String(p.includedMailboxes),
    storageGb: String(p.storageQuotaMb / 1024),
    additionalMailboxPricePhp: String(p.additionalMailboxPricePhp),
    features: p.features.join("\n"),
    sortOrder: String(p.sortOrder),
    status: p.status,
  };
}

function toInput(f: FormState): EmailPlanInput {
  return {
    name: f.name.trim(),
    pricePhp: Number(f.pricePhp),
    billingInterval: f.billingInterval,
    includedMailboxes: Number(f.includedMailboxes),
    storageQuotaMb: Math.round(Number(f.storageGb) * 1024),
    additionalMailboxPricePhp: Number(f.additionalMailboxPricePhp),
    features: f.features
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
    sortOrder: Number(f.sortOrder),
    status: f.status,
  };
}

export default function EmailPlansPage() {
  const { staffUser } = useMe();
  const canManage = canManageEmail(staffUser);
  const [plans, setPlans] = useState<EmailPlan[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ plan: EmailPlan | null; form: FormState } | null>(null);

  const load = () =>
    fetchEmailPlans(true)
      .then(setPlans)
      .catch((err: Error) => setError(err.message));
  useEffect(() => {
    load();
  }, []);

  return (
    <div>
      <Link to="/email-services" className="text-xs font-semibold text-brand-blue hover:underline">
        ← Email Services
      </Link>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-brand-navy">Email Plans</h1>
        {canManage && (
          <button type="button" onClick={() => setEditing({ plan: null, form: EMPTY })} className="rounded-full bg-brand-blue px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#0b57cc]">
            + New Plan
          </button>
        )}
      </div>
      <p className="mt-1 text-sm text-ink/60">
        The plan catalog. Editing a plan affects only services assigned to it afterwards: each service keeps a copy of the plan values it was given.
      </p>
      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      <div className="mt-4 overflow-x-auto rounded-xl border border-ink/10 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-ink/10 text-xs uppercase tracking-wide text-ink/40">
            <tr>
              <th className="px-4 py-3">Plan</th>
              <th className="px-4 py-3">Price</th>
              <th className="px-4 py-3">Mailboxes</th>
              <th className="px-4 py-3">Storage</th>
              <th className="px-4 py-3">Extra mailbox</th>
              <th className="px-4 py-3">Services</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {plans.map((p) => (
              <tr key={p.id} className={`border-b border-ink/5 align-top last:border-0 ${p.status === "archived" ? "opacity-60" : ""}`}>
                <td className="px-4 py-3">
                  <span className="font-semibold text-brand-navy">{p.name}</span>
                  {p.status === "archived" && <span className="ml-2 rounded-full bg-ink/10 px-2 py-0.5 text-xs text-ink/60">Archived</span>}
                  {p.features.length > 0 && <p className="mt-1 max-w-xs text-xs text-ink/50">{p.features.join(" · ")}</p>}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-ink/70">
                  {formatPhp(p.pricePhp)}/{p.billingInterval === "annual" ? "yr" : "mo"}
                </td>
                <td className="px-4 py-3 text-ink/70">{p.includedMailboxes}</td>
                <td className="px-4 py-3 text-ink/70">{formatStorage(p.storageQuotaMb)}</td>
                <td className="whitespace-nowrap px-4 py-3 text-ink/70">{formatPhp(p.additionalMailboxPricePhp)}/yr</td>
                <td className="px-4 py-3 text-ink/70">{p.servicesUsing}</td>
                <td className="px-4 py-3 text-right">
                  {canManage && (
                    <button type="button" className="text-xs font-semibold text-brand-blue hover:underline" onClick={() => setEditing({ plan: p, form: toForm(p) })}>
                      Edit
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <PlanModal
          plan={editing.plan}
          initial={editing.form}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function PlanModal({ plan, initial, onClose, onSaved }: { plan: EmailPlan | null; initial: FormState; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof FormState) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      if (plan) await updateEmailPlan(plan.id, toInput(form));
      else await createEmailPlan(toInput(form));
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const num = (k: keyof FormState, label: string, step = "1") => (
    <div>
      <label className="text-xs font-semibold text-ink/60" htmlFor={`plan-${k}`}>
        {label}
      </label>
      <input id={`plan-${k}`} type="number" min="0" step={step} className={`${inputClass} mt-1`} value={form[k]} onChange={set(k)} required />
    </div>
  );

  return (
    <Modal open onClose={onClose} title={plan ? `Edit ${plan.name}` : "New plan"}>
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="text-xs font-semibold text-ink/60" htmlFor="plan-name">
            Name
          </label>
          <input id="plan-name" className={`${inputClass} mt-1`} value={form.name} onChange={set("name")} required />
        </div>
        <div className="grid grid-cols-2 gap-3">
          {num("pricePhp", "Price (₱)")}
          <div>
            <label className="text-xs font-semibold text-ink/60" htmlFor="plan-interval">
              Billing
            </label>
            <select id="plan-interval" className={`${inputClass} mt-1`} value={form.billingInterval} onChange={set("billingInterval")}>
              <option value="annual">Annual</option>
              <option value="monthly">Monthly</option>
            </select>
          </div>
          {num("includedMailboxes", "Included mailboxes")}
          {num("storageGb", "Storage (GB)", "0.5")}
          {num("additionalMailboxPricePhp", "Extra mailbox (₱/yr)")}
          {num("sortOrder", "Sort order")}
        </div>
        <div>
          <label className="text-xs font-semibold text-ink/60" htmlFor="plan-features">
            Features (one per line)
          </label>
          <textarea id="plan-features" rows={4} className={`${inputClass} mt-1`} value={form.features} onChange={set("features")} />
        </div>
        {plan && (
          <div>
            <label className="text-xs font-semibold text-ink/60" htmlFor="plan-status">
              Status
            </label>
            <select id="plan-status" className={`${inputClass} mt-1`} value={form.status} onChange={set("status")}>
              <option value="active">Active (assignable)</option>
              <option value="archived">Archived (existing services keep it)</option>
            </select>
          </div>
        )}
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="rounded-full px-4 py-2 text-sm font-semibold text-ink/60 hover:bg-paper-alt">
            Cancel
          </button>
          <button type="submit" disabled={saving} className="rounded-full bg-brand-blue px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#0b57cc] disabled:opacity-50">
            {saving ? "Saving…" : "Save plan"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
