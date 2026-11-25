import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import Modal from "../components/Modal";
import { useMe } from "../lib/MeContext";
import { fetchClients, type ClientListRow } from "../lib/api";
import {
  SERVICE_STATUS_LABEL,
  SERVICE_STATUS_STYLE,
  canManageEmail,
  createEmailService,
  fetchEmailPlans,
  fetchEmailServices,
  fetchFailedOperations,
  formatDate,
  formatDateTime,
  type EmailPlan,
  type EmailServiceListItem,
  type FailedOperation,
  type ServiceStatus,
} from "../lib/emailServicesApi";

const inputClass = "w-full rounded-lg border border-ink/15 px-3 py-2 text-sm outline-none focus:border-brand-blue";

export default function EmailServicesPage() {
  const { staffUser } = useMe();
  const canManage = canManageEmail(staffUser);
  const [tab, setTab] = useState<"services" | "failed">("services");
  const [services, setServices] = useState<EmailServiceListItem[]>([]);
  const [failed, setFailed] = useState<FailedOperation[]>([]);
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    setLoading(true);
    const t = setTimeout(() => {
      (tab === "services" ? fetchEmailServices({ status, q: q.trim() }).then(setServices) : fetchFailedOperations().then(setFailed))
        .then(() => setError(null))
        .catch((err: Error) => setError(err.message))
        .finally(() => setLoading(false));
    }, 200);
    return () => clearTimeout(t);
  }, [tab, status, q]);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-brand-navy">Email Services</h1>
        <div className="flex flex-wrap gap-2">
          <Link to="/email-services/plans" className="rounded-full border border-ink/15 bg-white px-4 py-2 text-sm font-semibold text-ink/70 transition hover:bg-paper-alt">
            Plans
          </Link>
          {canManage && (
            <button type="button" onClick={() => setCreating(true)} className="rounded-full bg-brand-blue px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#0b57cc]">
              + New Email Service
            </button>
          )}
        </div>
      </div>
      <p className="mt-1 text-sm text-ink/60">Client email hosting: plans, mailbox allowances, domains and provider provisioning.</p>

      <div className="mt-4 flex gap-1 border-b border-ink/10">
        {(["services", "failed"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-semibold ${tab === t ? "border-brand-blue text-brand-blue" : "border-transparent text-ink/50 hover:text-ink"}`}
          >
            {t === "services" ? "Services" : "Failed operations"}
          </button>
        ))}
      </div>

      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      {tab === "services" ? (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search client or domain" aria-label="Search" className={`${inputClass} max-w-xs`} />
            <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status filter" className="rounded-lg border border-ink/15 px-3 py-2 text-sm outline-none focus:border-brand-blue">
              <option value="">All statuses</option>
              {(Object.keys(SERVICE_STATUS_LABEL) as ServiceStatus[]).map((s) => (
                <option key={s} value={s}>
                  {SERVICE_STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
          <div className="mt-4 overflow-x-auto rounded-xl border border-ink/10 bg-white">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-ink/10 text-xs uppercase tracking-wide text-ink/40">
                <tr>
                  <th className="px-4 py-3">Client</th>
                  <th className="px-4 py-3">Domain</th>
                  <th className="px-4 py-3">Plan</th>
                  <th className="px-4 py-3">Mailboxes</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Expires</th>
                </tr>
              </thead>
              <tbody>
                {services.map((s) => (
                  <tr key={s.id} className="border-b border-ink/5 last:border-0 hover:bg-paper-alt">
                    <td className="px-4 py-3">
                      <Link to={`/email-services/${s.id}`} className="font-semibold text-brand-blue hover:underline">
                        {s.businessName}
                      </Link>
                      <p className="text-xs text-ink/50">{s.clientName}</p>
                    </td>
                    <td className="px-4 py-3 text-ink/70">{s.primaryDomain ?? <span className="text-ink/40">None yet</span>}</td>
                    <td className="px-4 py-3 text-ink/70">{s.planName ?? <span className="text-ink/40">None yet</span>}</td>
                    <td className="px-4 py-3 text-ink/70">
                      {s.allowance.active} / {s.allowance.total}
                      {(s.failedCount > 0 || s.needsReviewCount > 0) && (
                        <p className="text-xs text-red-600">
                          {[s.failedCount ? `${s.failedCount} failed` : "", s.needsReviewCount ? `${s.needsReviewCount} need review` : ""].filter(Boolean).join(", ")}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${SERVICE_STATUS_STYLE[s.effectiveStatus]}`}>{SERVICE_STATUS_LABEL[s.effectiveStatus]}</span>
                    </td>
                    <td className="px-4 py-3 text-ink/50">{formatDate(s.expiresAt)}</td>
                  </tr>
                ))}
                {!loading && services.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-6 text-center text-ink/40">
                      No email services match.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-xl border border-ink/10 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-ink/10 text-xs uppercase tracking-wide text-ink/40">
              <tr>
                <th className="px-4 py-3">When</th>
                <th className="px-4 py-3">Client</th>
                <th className="px-4 py-3">Operation</th>
                <th className="px-4 py-3">Result</th>
                <th className="px-4 py-3">Error</th>
              </tr>
            </thead>
            <tbody>
              {failed.map((op) => (
                <tr key={op.id} className="border-b border-ink/5 last:border-0 align-top hover:bg-paper-alt">
                  <td className="whitespace-nowrap px-4 py-3 text-ink/50">{formatDateTime(op.createdAt)}</td>
                  <td className="px-4 py-3">
                    <Link to={`/email-services/${op.serviceId}`} className="font-semibold text-brand-blue hover:underline">
                      {op.businessName}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-ink/70">
                    {op.operation.replace(/_/g, " ")}
                    {op.mailboxAddress && <p className="text-xs text-ink/50">{op.mailboxAddress}</p>}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${op.outcome === "unknown" ? "bg-amber-100 text-amber-700" : "bg-red-100 text-red-700"}`}>
                      {op.outcome === "unknown" ? "Outcome unknown" : "Failed"}
                    </span>
                  </td>
                  <td className="max-w-md px-4 py-3 text-xs text-ink/60">
                    <span className="font-mono">{op.errorCode}</span> {op.errorMessage}
                  </td>
                </tr>
              ))}
              {!loading && failed.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-ink/40">
                    No failed provider operations.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <CreateServiceModal open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

function CreateServiceModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [clientQuery, setClientQuery] = useState("");
  const [clients, setClients] = useState<ClientListRow[]>([]);
  const [clientId, setClientId] = useState("");
  const [plans, setPlans] = useState<EmailPlan[]>([]);
  const [planId, setPlanId] = useState("");
  const [domain, setDomain] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    fetchEmailPlans().then(setPlans).catch(() => setPlans([]));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      fetchClients({ q: clientQuery.trim() || undefined })
        .then(setClients)
        .catch(() => setClients([]));
    }, 200);
    return () => clearTimeout(t);
  }, [open, clientQuery]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!clientId) {
      setError("Choose a client.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await createEmailService({ clientId, planId: planId || undefined, domain: domain.trim() || undefined, internalNotes: notes.trim() || undefined });
      navigate(`/email-services/${res.serviceId}${res.warnings.length ? `?warn=${encodeURIComponent(res.warnings.join(" "))}` : ""}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="New Email Service">
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="text-xs font-semibold text-ink/60" htmlFor="es-client-search">
            Client
          </label>
          <input id="es-client-search" value={clientQuery} onChange={(e) => setClientQuery(e.target.value)} placeholder="Search clients" className={`${inputClass} mt-1`} />
          <select value={clientId} onChange={(e) => setClientId(e.target.value)} aria-label="Client" className={`${inputClass} mt-2`} size={Math.min(6, Math.max(2, clients.length))}>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.businessName} ({c.fullName})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs font-semibold text-ink/60" htmlFor="es-plan">
            Plan (optional now)
          </label>
          <select id="es-plan" value={planId} onChange={(e) => setPlanId(e.target.value)} className={`${inputClass} mt-1`}>
            <option value="">Assign later</option>
            {plans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}: {p.includedMailboxes} mailbox{p.includedMailboxes === 1 ? "" : "es"}, ₱{p.pricePhp.toLocaleString()}/{p.billingInterval === "annual" ? "yr" : "mo"}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs font-semibold text-ink/60" htmlFor="es-domain">
            Domain (optional now)
          </label>
          <input id="es-domain" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="clientbusiness.com" className={`${inputClass} mt-1`} />
        </div>
        <div>
          <label className="text-xs font-semibold text-ink/60" htmlFor="es-notes">
            Internal notes
          </label>
          <textarea id="es-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={`${inputClass} mt-1`} />
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="rounded-full px-4 py-2 text-sm font-semibold text-ink/60 hover:bg-paper-alt">
            Cancel
          </button>
          <button type="submit" disabled={submitting} className="rounded-full bg-brand-blue px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#0b57cc] disabled:opacity-50">
            {submitting ? "Creating…" : "Create Service"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
