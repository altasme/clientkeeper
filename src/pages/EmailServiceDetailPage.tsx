import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import Modal from "../components/Modal";
import FulfillMailboxModal from "../components/emailServices/FulfillMailboxModal";
import { useMe } from "../lib/MeContext";
import {
  MAILBOX_STATUS_LABEL,
  MAILBOX_STATUS_STYLE,
  MANUALLY_FULFILLABLE,
  SERVICE_STATUS_LABEL,
  SERVICE_STATUS_STYLE,
  addEmailDomain,
  adjustEmailEntitlement,
  assignEmailPlan,
  canManageEmail,
  createMailboxRequestLink,
  declineEmailMailboxRequest,
  deleteEmailMailbox,
  discardEmailMailbox,
  fetchEmailPlans,
  fetchEmailService,
  fetchEmailServiceLogs,
  fetchMailboxRequestLinks,
  formatDate,
  formatDateTime,
  formatPhp,
  formatStorage,
  isClientRequest,
  provisionEmailMailbox,
  removeEmailDomain,
  resolveEmailMailbox,
  retryEmailMailbox,
  revokeMailboxRequestLink,
  syncEmailService,
  transitionEmailService,
  updateEmailService,
  type AuditEntry,
  type Discrepancy,
  type EmailMailbox,
  type EmailPlan,
  type EmailServiceDetail,
  type LifecycleAction,
  type MailboxRequestLink,
  type OperationEntry,
} from "../lib/emailServicesApi";

const inputClass = "w-full rounded-lg border border-ink/15 px-3 py-2 text-sm outline-none focus:border-brand-blue";
const primaryBtn = "rounded-full bg-brand-blue px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#0b57cc] disabled:opacity-50";
const secondaryBtn = "rounded-full border border-ink/15 bg-white px-3 py-1.5 text-xs font-semibold text-ink/70 transition hover:bg-paper-alt disabled:opacity-50";
const dangerBtn = "rounded-full border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-600 transition hover:bg-red-50 disabled:opacity-50";

function Card({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-ink/10 bg-white p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold uppercase tracking-wide text-ink/50">{title}</h2>
        {actions}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-ink/50">{label}</dt>
      <dd className="mt-0.5 break-words text-sm font-medium text-ink">{children}</dd>
    </div>
  );
}

// One generic "confirm with inputs" dialog for every action that needs a
// reason, password, or date.
interface PromptField {
  name: string;
  label: string;
  type?: "text" | "password" | "date" | "select" | "textarea";
  options?: { value: string; label: string }[];
  required?: boolean;
  placeholder?: string;
}
interface PromptState {
  title: string;
  description?: string;
  fields: PromptField[];
  confirmLabel: string;
  danger?: boolean;
  onConfirm: (values: Record<string, string>) => Promise<void>;
}

function PromptModal({ prompt, onClose }: { prompt: PromptState | null; onClose: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setValues(Object.fromEntries((prompt?.fields ?? []).map((f) => [f.name, f.type === "select" ? (f.options?.[0]?.value ?? "") : ""])));
    setError(null);
  }, [prompt]);

  if (!prompt) return null;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const missing = prompt.fields.find((f) => f.required && !values[f.name]?.trim());
    if (missing) {
      setError(`${missing.label} is required.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await prompt.onConfirm(values);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={prompt.title}>
      <form onSubmit={submit} className="space-y-3">
        {prompt.description && <p className="text-sm text-ink/60">{prompt.description}</p>}
        {prompt.fields.map((f) => (
          <div key={f.name}>
            <label className="text-xs font-semibold text-ink/60" htmlFor={`prompt-${f.name}`}>
              {f.label}
              {f.required ? "" : " (optional)"}
            </label>
            {f.type === "select" ? (
              <select id={`prompt-${f.name}`} className={`${inputClass} mt-1`} value={values[f.name] ?? ""} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}>
                {f.options?.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : f.type === "textarea" ? (
              <textarea id={`prompt-${f.name}`} rows={3} className={`${inputClass} mt-1`} value={values[f.name] ?? ""} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} />
            ) : (
              <input
                id={`prompt-${f.name}`}
                type={f.type ?? "text"}
                autoComplete={f.type === "password" ? "new-password" : "off"}
                placeholder={f.placeholder}
                className={`${inputClass} mt-1`}
                value={values[f.name] ?? ""}
                onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
              />
            )}
          </div>
        ))}
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="rounded-full px-4 py-2 text-sm font-semibold text-ink/60 hover:bg-paper-alt">
            Cancel
          </button>
          <button type="submit" disabled={busy} className={prompt.danger ? "rounded-full bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50" : primaryBtn}>
            {busy ? "Working…" : prompt.confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

const LIFECYCLE: { action: LifecycleAction; label: string; from: string[]; needsReason: boolean; danger?: boolean; description: string }[] = [
  { action: "activate", label: "Activate", from: ["pending_setup", "provisioning_error"], needsReason: false, description: "Requires a plan, a domain, and at least one active mailbox. Starts the term if it hasn't started." },
  { action: "renew", label: "Renew", from: ["active", "expired", "suspended"], needsReason: false, description: "Extends the term by one billing interval from the later of today or the current expiry, unless you pick a date. Mailboxes are not recreated." },
  { action: "suspend", label: "Suspend", from: ["active", "expired"], needsReason: true, danger: true, description: "Blocks new mailboxes and client self-service. Existing mailboxes are not deleted." },
  { action: "reactivate", label: "Reactivate", from: ["suspended"], needsReason: false, description: "Only possible while the term is still running; otherwise renew." },
  {
    action: "decommission",
    label: "Decommission",
    from: ["pending_setup", "active", "suspended", "expired", "provisioning_error"],
    needsReason: true,
    danger: true,
    description: "Ends the service for good and releases its domains. Every mailbox must be deleted or resolved first; nothing is deleted automatically.",
  },
];

export default function EmailServiceDetailPage() {
  const { id = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { staffUser } = useMe();
  const canManage = canManageEmail(staffUser);

  const [detail, setDetail] = useState<EmailServiceDetail | null>(null);
  const [plans, setPlans] = useState<EmailPlan[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "warn" | "error"; text: string } | null>(() => {
    const warn = searchParams.get("warn");
    return warn ? { kind: "warn", text: warn } : null;
  });
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [fulfilling, setFulfilling] = useState<EmailMailbox | null>(null);
  const [logs, setLogs] = useState<{ audit: AuditEntry[]; operations: OperationEntry[] } | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [syncResult, setSyncResult] = useState<{ ok: boolean; error: { code: string; message: string } | null; discrepancies: Discrepancy[] } | null>(null);

  const load = useCallback(() => {
    fetchEmailService(id)
      .then((d) => {
        setDetail(d);
        setError(null);
      })
      .catch((err: Error) => setError(err.message));
    if (logs) fetchEmailServiceLogs(id).then(setLogs).catch(() => undefined);
  }, [id, logs]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  useEffect(() => {
    fetchEmailPlans().then(setPlans).catch(() => setPlans([]));
    if (searchParams.get("warn")) setSearchParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (fn: () => Promise<unknown>, success: string) => {
    try {
      await fn();
      setNotice({ kind: "ok", text: success });
    } finally {
      load();
    }
  };

  if (error && !detail) return <p className="text-sm text-red-600">{error}</p>;
  if (!detail) return <p className="text-sm text-ink/40">Loading…</p>;

  const s = detail;
  const cancelled = s.status === "cancelled";
  const activeDomains = s.domains.filter((d) => d.status === "active");
  const visibleMailboxes = s.mailboxes.filter((m) => showHidden || (m.status !== "deleted" && m.status !== "discarded"));
  const hiddenCount = s.mailboxes.length - s.mailboxes.filter((m) => m.status !== "deleted" && m.status !== "discarded").length;
  const lastSyncDiscrepancies = syncResult?.discrepancies ?? s.provider.lastSync?.details?.discrepancies ?? [];

  const openProvision = () =>
    setPrompt({
      title: "Provision mailbox",
      description: s.provider.configured
        ? "Creates the mailbox at the provider. The password is sent to the provider only and is never stored."
        : `${s.provider.message} This attempt will be recorded as failed and will not use a slot.`,
      fields: [
        { name: "localPart", label: "Mailbox name (before the @)", required: true, placeholder: "hello" },
        { name: "domainId", label: "Domain", type: "select", options: activeDomains.map((d) => ({ value: d.id, label: `@${d.domain}` })), required: true },
        { name: "password", label: "Initial password (10+ chars, letters and numbers)", type: "password", required: true },
        { name: "isPrimary", label: "Primary mailbox?", type: "select", options: s.mailboxes.some((m) => m.isPrimary && !["failed", "deleted", "discarded"].includes(m.status)) ? [{ value: "no", label: "No" }] : [{ value: "yes", label: "Yes, this is the primary mailbox" }, { value: "no", label: "No" }] },
      ],
      confirmLabel: "Provision",
      onConfirm: async (v) => {
        try {
          await provisionEmailMailbox(s.id, { domainId: v.domainId!, localPart: v.localPart!.trim(), password: v.password!, isPrimary: v.isPrimary === "yes", idempotencyKey: crypto.randomUUID() });
          setNotice({ kind: "ok", text: "Mailbox created at the provider." });
        } catch (err) {
          // 502/503 (provider failed, slot released) and 202-style answers
          // still produced a record; show the reason and refresh.
          setNotice({ kind: "error", text: (err as Error).message });
        } finally {
          load();
        }
      },
    });

  const mailboxActions = (m: EmailMailbox) => {
    const out: ReactNode[] = [];
    if (!canManage || cancelled) return out;
    // Manual fulfillment (CLAUDE.md §35): the mailbox was created by hand
    // in Z.com's dashboard. Offered on any reserved/needs-review/failed row
    // (a client request, or recovering a staff attempt).
    if (MANUALLY_FULFILLABLE.includes(m.status)) {
      out.push(
        <button key="fulfill" type="button" className={secondaryBtn} onClick={() => setFulfilling(m)}>
          Fulfill manually
        </button>
      );
    }
    if (isClientRequest(m)) {
      out.push(
        <button
          key="decline"
          type="button"
          className={dangerBtn}
          onClick={() =>
            setPrompt({
              title: `Decline request for ${m.address}`,
              description: "Releases the slot and the address; the client can request again.",
              fields: [{ name: "reason", label: "Reason", type: "textarea", required: true }],
              confirmLabel: "Decline request",
              danger: true,
              onConfirm: (v) => run(() => declineEmailMailboxRequest(s.id, m.id, v.reason!), `Request for ${m.address} declined.`),
            })
          }
        >
          Decline
        </button>
      );
    }
    if (m.status === "failed") {
      out.push(
        <button
          key="retry"
          type="button"
          className={secondaryBtn}
          onClick={() =>
            setPrompt({
              title: `Retry ${m.address}`,
              description: "The password was never stored, so enter it again.",
              fields: [{ name: "password", label: "Password", type: "password", required: true }],
              confirmLabel: "Retry",
              onConfirm: async (v) => {
                try {
                  await retryEmailMailbox(s.id, m.id, v.password!);
                  setNotice({ kind: "ok", text: `${m.address} created at the provider.` });
                } catch (err) {
                  setNotice({ kind: "error", text: (err as Error).message });
                } finally {
                  load();
                }
              },
            })
          }
        >
          Retry
        </button>,
        <button key="discard" type="button" className={secondaryBtn} onClick={() => run(() => discardEmailMailbox(s.id, m.id), `${m.address} discarded.`).catch((e: Error) => setNotice({ kind: "error", text: e.message }))}>
          Discard
        </button>
      );
    }
    if (m.status === "needs_review") {
      out.push(
        <button
          key="resolve"
          type="button"
          className={secondaryBtn}
          onClick={() =>
            setPrompt({
              title: `Resolve ${m.address}`,
              description: "Check the provider's own panel (or run a sync) first. This only updates our records; it doesn't call the provider.",
              fields: [
                {
                  name: "resolution",
                  label: "What did you find?",
                  type: "select",
                  options: [
                    { value: "exists", label: "It exists at the provider (mark active)" },
                    { value: "absent", label: "It does not exist at the provider (release the slot)" },
                  ],
                  required: true,
                },
                { name: "providerMailboxId", label: "Provider mailbox id" },
                { name: "reason", label: "Reason / how you checked", type: "textarea", required: true },
              ],
              confirmLabel: "Resolve",
              onConfirm: (v) => run(() => resolveEmailMailbox(s.id, m.id, v.resolution as "exists" | "absent", v.reason!, v.providerMailboxId || undefined), `${m.address} resolved.`),
            })
          }
        >
          Resolve
        </button>
      );
    }
    if (m.status === "active" || m.status === "needs_review") {
      out.push(
        <button
          key="delete"
          type="button"
          className={dangerBtn}
          onClick={() =>
            setPrompt({
              title: `Delete ${m.address}`,
              description: "Asks the provider to delete this mailbox and everything in it. The slot is released only once the provider confirms.",
              fields: [{ name: "reason", label: "Reason", type: "textarea", required: true }],
              confirmLabel: "Delete mailbox",
              danger: true,
              onConfirm: async (v) => {
                try {
                  await deleteEmailMailbox(s.id, m.id, v.reason!);
                  setNotice({ kind: "ok", text: `${m.address} deleted.` });
                } catch (err) {
                  setNotice({ kind: "error", text: (err as Error).message });
                } finally {
                  load();
                }
              },
            })
          }
        >
          Delete
        </button>
      );
    }
    return out;
  };

  return (
    <div className="space-y-5">
      <div>
        <Link to="/email-services" className="text-xs font-semibold text-brand-blue hover:underline">
          ← Email Services
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold text-brand-navy">{s.client?.businessName ?? "Email service"}</h1>
          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${SERVICE_STATUS_STYLE[s.effectiveStatus]}`}>{SERVICE_STATUS_LABEL[s.effectiveStatus]}</span>
        </div>
        {s.statusReason && <p className="mt-1 text-sm text-ink/60">{s.statusReason}</p>}
      </div>

      {notice && (
        <div
          role="status"
          className={`flex items-start justify-between gap-3 rounded-lg border px-4 py-3 text-sm ${
            notice.kind === "ok" ? "border-green-200 bg-green-50 text-green-800" : notice.kind === "warn" ? "border-amber-200 bg-amber-50 text-amber-800" : "border-red-200 bg-red-50 text-red-700"
          }`}
        >
          <span>{notice.text}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)} className="opacity-60 hover:opacity-100">
            &times;
          </button>
        </div>
      )}

      {!s.provider.configured && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <p className="font-semibold">Provider not connected</p>
          <p className="mt-0.5">{s.provider.message} You can set up plans, domains and allowances now; mailbox creation will fail without using a slot until the integration exists.</p>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card
          title="Overview"
          actions={
            canManage && !cancelled ? (
              <button
                type="button"
                className={secondaryBtn}
                onClick={() =>
                  setPrompt({
                    title: "Change expiration date",
                    description: "Use Renew to extend a term normally. This sets the date directly.",
                    fields: [
                      { name: "expiresAt", label: "New expiration date", type: "date", required: true },
                      { name: "reason", label: "Reason", type: "textarea", required: true },
                    ],
                    confirmLabel: "Save",
                    onConfirm: (v) => run(() => updateEmailService(s.id, { expiresAt: v.expiresAt, reason: v.reason }), "Expiration date updated."),
                  })
                }
              >
                Edit expiry
              </button>
            ) : undefined
          }
        >
          <dl className="grid grid-cols-2 gap-4">
            <Field label="Client">
              {s.client ? (
                <Link to={`/clients/${s.client.id}`} className="text-brand-blue hover:underline">
                  {s.client.fullName}
                </Link>
              ) : (
                "—"
              )}
            </Field>
            <Field label="Domain">{activeDomains.find((d) => d.isPrimary)?.domain ?? activeDomains[0]?.domain ?? "—"}</Field>
            <Field label="Plan">{s.plan?.name ?? "—"}</Field>
            <Field label="Status">{SERVICE_STATUS_LABEL[s.effectiveStatus]}</Field>
            <Field label="Start date">{formatDate(s.startsAt)}</Field>
            <Field label="Expiry date">{formatDate(s.expiresAt)}</Field>
          </dl>
          {s.status === "pending_setup" || s.status === "provisioning_error" ? (
            <ul className="mt-4 space-y-1 text-sm">
              {(
                [
                  ["domainAssigned", "Domain assigned"],
                  ["planAssigned", "Plan assigned"],
                  ["mailboxActive", "Initial mailbox provisioned"],
                ] as const
              ).map(([key, label]) => (
                <li key={key} className={s.activationChecklist[key] ? "text-green-700" : "text-ink/50"}>
                  {s.activationChecklist[key] ? "✓" : "○"} {label}
                </li>
              ))}
            </ul>
          ) : null}
        </Card>

        <Card title="Mailbox usage">
          {s.allowance ? (
            <>
              <dl className="grid grid-cols-3 gap-4">
                <Field label="Included">{s.allowance.included}</Field>
                <Field label="Additional">{s.allowance.additional}</Field>
                <Field label="Overrides">{s.allowance.overrides}</Field>
                <Field label="Total allowance">{s.allowance.total}</Field>
                <Field label="Active">{s.allowance.active}</Field>
                <Field label="Remaining slots">{s.allowance.available}</Field>
              </dl>
              {s.allowance.pending > 0 && <p className="mt-3 text-xs text-amber-700">{s.allowance.pending} slot(s) held by mailboxes still provisioning, deleting, or awaiting review.</p>}
              {s.allowance.total > 0 && (
                <div className="mt-4 h-2 overflow-hidden rounded-full bg-paper-alt" aria-hidden="true">
                  <div className="h-full bg-brand-blue" style={{ width: `${Math.min(100, (s.allowance.active / s.allowance.total) * 100)}%` }} />
                </div>
              )}
            </>
          ) : (
            <p className="text-sm text-ink/40">—</p>
          )}
        </Card>
      </div>

      <Card
        title="Mailboxes"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {hiddenCount > 0 && (
              <button type="button" className="text-xs font-semibold text-ink/50 hover:text-ink" onClick={() => setShowHidden(!showHidden)}>
                {showHidden ? "Hide" : "Show"} deleted/discarded ({hiddenCount})
              </button>
            )}
            {canManage && !cancelled && (
              <button type="button" className={primaryBtn} disabled={!activeDomains.length || !s.plan} title={!s.plan ? "Assign a plan first" : !activeDomains.length ? "Assign a domain first" : undefined} onClick={openProvision}>
                Provision mailbox
              </button>
            )}
          </div>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-ink/10 text-xs uppercase tracking-wide text-ink/40">
              <tr>
                <th className="py-2 pr-4">Address</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2 pr-4">Created</th>
                <th className="py-2 pr-4">Provider id</th>
                <th className="py-2 pr-4">Creator</th>
                <th className="py-2 pr-4">Last sync</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {visibleMailboxes.map((m) => (
                <tr key={m.id} className="border-b border-ink/5 align-top last:border-0">
                  <td className="py-2 pr-4">
                    <span className="font-medium text-ink">{m.address}</span>
                    <span className="ml-2 text-xs text-ink/50">{m.isPrimary ? "Primary" : "Standard"}</span>
                    {isClientRequest(m) && <span className="ml-2 whitespace-nowrap rounded-full bg-violet-100 px-2 py-0.5 text-xs font-semibold text-violet-700">Requested by client</span>}
                    {m.bridgedMailAccountId && <p className="mt-0.5 text-xs text-ink/50">Linked to webmail</p>}
                    {m.lastError && <p className="mt-1 max-w-sm text-xs text-red-600">{m.lastError}</p>}
                  </td>
                  <td className="py-2 pr-4">
                    <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${MAILBOX_STATUS_STYLE[m.status]}`}>{isClientRequest(m) ? "Awaiting setup" : MAILBOX_STATUS_LABEL[m.status]}</span>
                  </td>
                  <td className="whitespace-nowrap py-2 pr-4 text-ink/60">{formatDate(m.createdAt)}</td>
                  <td className="py-2 pr-4 font-mono text-xs text-ink/60">{m.providerMailboxId ?? "—"}</td>
                  <td className="py-2 pr-4 text-ink/60">
                    {m.createdBy ?? "—"}
                    {m.createdByType !== "staff" && <span className="ml-1 text-xs text-ink/40">({m.createdByType})</span>}
                  </td>
                  <td className="whitespace-nowrap py-2 pr-4 text-ink/60">{formatDate(m.lastSyncedAt)}</td>
                  <td className="py-2">
                    <div className="flex flex-wrap justify-end gap-1">{mailboxActions(m)}</div>
                  </td>
                </tr>
              ))}
              {visibleMailboxes.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-4 text-center text-ink/40">
                    No mailboxes yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <RequestLinksCard
        detail={s}
        canManage={canManage && !cancelled}
        blockedReason={!s.plan ? "Assign a plan first" : !activeDomains.length ? "Assign a domain first" : !["pending_setup", "active", "provisioning_error"].includes(s.effectiveStatus) ? `Not available while the service is ${SERVICE_STATUS_LABEL[s.effectiveStatus].toLowerCase()}` : null}
        onNotice={setNotice}
      />

      <div className="grid gap-5 lg:grid-cols-2">
        <Card
          title="Domains"
          actions={
            canManage && !cancelled ? (
              <button
                type="button"
                className={secondaryBtn}
                onClick={() =>
                  setPrompt({
                    title: "Assign domain",
                    fields: [
                      { name: "domain", label: "Domain", required: true, placeholder: "clientbusiness.com" },
                      { name: "primary", label: "Primary domain?", type: "select", options: [{ value: activeDomains.length ? "no" : "yes", label: activeDomains.length ? "No" : "Yes" }, { value: activeDomains.length ? "yes" : "no", label: activeDomains.length ? "Yes" : "No" }] },
                    ],
                    confirmLabel: "Assign",
                    onConfirm: (v) => run(() => addEmailDomain(s.id, v.domain!.trim(), v.primary === "yes"), "Domain assigned."),
                  })
                }
              >
                + Domain
              </button>
            ) : undefined
          }
        >
          <ul className="divide-y divide-ink/5 text-sm">
            {s.domains.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className={d.status === "removed" ? "text-ink/40 line-through" : "font-medium text-ink"}>
                  {d.domain}
                  {d.isPrimary && <span className="ml-2 text-xs font-normal text-ink/50">Primary</span>}
                  <span className="ml-2 font-mono text-xs font-normal text-ink/40">{d.providerDomainId ?? ""}</span>
                </span>
                {canManage && !cancelled && d.status === "active" && (
                  <button
                    type="button"
                    className={dangerBtn}
                    onClick={() =>
                      setPrompt({
                        title: `Remove ${d.domain}`,
                        description: "Only possible once no mailbox on this domain is active, in progress, or awaiting review.",
                        fields: [{ name: "reason", label: "Reason", type: "textarea" }],
                        confirmLabel: "Remove",
                        danger: true,
                        onConfirm: (v) => run(() => removeEmailDomain(s.id, d.id, v.reason || undefined), "Domain removed."),
                      })
                    }
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
            {s.domains.length === 0 && <li className="py-2 text-ink/40">No domain assigned.</li>}
          </ul>
        </Card>

        <Card
          title="Plan & entitlement"
          actions={
            canManage && !cancelled ? (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={secondaryBtn}
                  onClick={() =>
                    setPrompt({
                      title: s.plan ? "Change plan" : "Assign plan",
                      description: "Plan values are copied onto this service; later catalog edits don't change it. A downgrade below current usage is refused.",
                      fields: [
                        { name: "planId", label: "Plan", type: "select", options: plans.map((p) => ({ value: p.id, label: `${p.name}: ${p.includedMailboxes} mailboxes, ${formatStorage(p.storageQuotaMb)}, ${formatPhp(p.pricePhp)}` })), required: true },
                        { name: "reason", label: "Reason", type: "textarea", required: !!s.plan },
                      ],
                      confirmLabel: "Save plan",
                      onConfirm: (v) => run(() => assignEmailPlan(s.id, v.planId!, v.reason || undefined), "Plan saved."),
                    })
                  }
                >
                  {s.plan ? "Change plan" : "Assign plan"}
                </button>
                <button
                  type="button"
                  className={secondaryBtn}
                  disabled={!s.plan}
                  onClick={() =>
                    setPrompt({
                      title: "Adjust mailbox allowance",
                      description: `Add-ons are billed at ${formatPhp(s.plan?.additionalMailboxPricePhp)} per mailbox per year. Use a negative number to remove; it can't drop below mailboxes in use.`,
                      fields: [
                        { name: "kind", label: "Type", type: "select", options: [{ value: "addon", label: "Purchased additional mailboxes" }, { value: "override", label: "Admin override" }] },
                        { name: "quantity", label: "Quantity (e.g. 2 or -1)", required: true },
                        { name: "reason", label: "Reason (required for overrides and removals)", type: "textarea" },
                      ],
                      confirmLabel: "Apply",
                      onConfirm: async (v) => {
                        const qty = Number(v.quantity);
                        if (!Number.isInteger(qty) || qty === 0) throw new Error("Quantity must be a non-zero whole number.");
                        await run(() => adjustEmailEntitlement(s.id, v.kind as "addon" | "override", qty, v.reason || undefined), "Allowance updated.");
                      },
                    })
                  }
                >
                  Adjust allowance
                </button>
              </div>
            ) : undefined
          }
        >
          {s.plan ? (
            <dl className="grid grid-cols-2 gap-4">
              <Field label="Plan">
                {s.plan.name}
                {s.plan.catalogStatus === "archived" && <span className="ml-1 text-xs text-ink/40">(archived)</span>}
              </Field>
              <Field label="Price">
                {formatPhp(s.plan.pricePhp)}/{s.plan.billingInterval === "monthly" ? "month" : "year"}
              </Field>
              <Field label="Included mailboxes">{s.plan.includedMailboxes}</Field>
              <Field label="Storage">{formatStorage(s.plan.storageQuotaMb)}</Field>
            </dl>
          ) : (
            <p className="text-sm text-ink/40">No plan assigned.</p>
          )}
          {s.entitlements.length > 0 && (
            <ul className="mt-4 divide-y divide-ink/5 text-sm">
              {s.entitlements.map((e) => (
                <li key={e.id} className="py-2">
                  <span className={`font-semibold ${e.quantity > 0 ? "text-green-700" : "text-red-600"}`}>
                    {e.quantity > 0 ? "+" : ""}
                    {e.quantity}
                  </span>{" "}
                  {e.kind === "addon" ? "additional mailbox(es)" : "override"}
                  {e.unitPricePhp !== null && <span className="text-ink/50"> at {formatPhp(e.unitPricePhp)}</span>}
                  <p className="text-xs text-ink/50">
                    {formatDate(e.createdAt)} · {e.createdBy ?? "—"}
                    {e.reason ? ` · ${e.reason}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card
          title="Provider"
          actions={
            canManage ? (
              <button
                type="button"
                className={secondaryBtn}
                onClick={async () => {
                  try {
                    const r = await syncEmailService(s.id);
                    setSyncResult(r);
                    setNotice(
                      r.ok
                        ? { kind: r.discrepancies.length ? "warn" : "ok", text: r.discrepancies.length ? `Sync found ${r.discrepancies.length} discrepancies. Nothing was changed.` : "Sync complete. No discrepancies." }
                        : { kind: "error", text: `Sync failed: ${r.error?.message}` }
                    );
                  } catch (err) {
                    setNotice({ kind: "error", text: (err as Error).message });
                  } finally {
                    load();
                  }
                }}
              >
                Sync & reconcile
              </button>
            ) : undefined
          }
        >
          <dl className="grid grid-cols-2 gap-4">
            <Field label="Provider">{s.provider.displayName}</Field>
            <Field label="Integration">{s.provider.configured ? "Connected" : <span className="text-amber-700">Not configured</span>}</Field>
            <Field label="Provider service id">
              <span className="font-mono text-xs">{s.provider.providerServiceId ?? "—"}</span>
              {canManage && !cancelled && (
                <button
                  type="button"
                  className="ml-2 text-xs font-semibold text-brand-blue hover:underline"
                  onClick={() =>
                    setPrompt({
                      title: "Provider service id",
                      description: "The provider's own id for this service, for when it was set up outside ClientKeeper.",
                      fields: [{ name: "providerServiceId", label: "Provider service id" }],
                      confirmLabel: "Save",
                      onConfirm: (v) => run(() => updateEmailService(s.id, { providerServiceId: v.providerServiceId ?? "" }), "Provider service id saved."),
                    })
                  }
                >
                  Edit
                </button>
              )}
            </Field>
            <Field label="Provider status">{s.provider.providerStatus ?? "—"}</Field>
            <Field label="Storage used">{formatStorage(s.provider.storageUsedMb)}</Field>
            <Field label="Sync status">{s.provider.syncStatus.replace("_", " ")}</Field>
            <Field label="Last sync">{formatDateTime(s.provider.lastSyncAt)}</Field>
          </dl>
          {s.provider.lastSyncError && <p className="mt-3 text-xs text-red-600">{s.provider.lastSyncError}</p>}
          {lastSyncDiscrepancies.length > 0 && (
            <div className="mt-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink/50">Discrepancies (not auto-fixed)</p>
              <ul className="mt-2 space-y-2 text-sm">
                {lastSyncDiscrepancies.map((d, i) => (
                  <li key={i} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                    <span className="font-mono text-xs text-amber-800">{d.type}</span> <span className="font-medium">{d.address ?? ""}</span>
                    <p className="text-xs text-ink/60">{d.detail}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>

        <Card title="Operations">
          {canManage ? (
            <div className="flex flex-wrap gap-2">
              {LIFECYCLE.filter((l) => l.from.includes(s.effectiveStatus)).map((l) => (
                <button
                  key={l.action}
                  type="button"
                  className={l.danger ? dangerBtn : secondaryBtn}
                  onClick={() =>
                    setPrompt({
                      title: `${l.label} service`,
                      description: l.description,
                      fields: [
                        ...(l.action === "renew" || l.action === "activate" ? [{ name: "expiresAt", label: "Expiration date (default: one billing interval)", type: "date" as const }] : []),
                        { name: "reason", label: "Reason", type: "textarea" as const, required: l.needsReason },
                      ],
                      confirmLabel: l.label,
                      danger: l.danger,
                      onConfirm: (v) => run(() => transitionEmailService(s.id, l.action, v.reason || undefined, v.expiresAt || undefined), `Service ${l.action === "renew" ? "renewed" : `${l.action}d`}.`),
                    })
                  }
                >
                  {l.label}
                </button>
              ))}
              {cancelled && <p className="text-sm text-ink/50">Decommissioned {formatDate(s.decommissionedAt)}. No further actions.</p>}
            </div>
          ) : (
            <p className="text-sm text-ink/50">Only owners and admins can change this service.</p>
          )}
          <div className="mt-4">
            <label className="text-xs font-semibold text-ink/60" htmlFor="es-notes-view">
              Internal notes
            </label>
            <NotesEditor serviceId={s.id} initial={s.internalNotes ?? ""} disabled={!canManage} onSaved={() => {
                setNotice({ kind: "ok", text: "Notes saved." });
                load();
              }} />
          </div>
        </Card>
      </div>

      <Card
        title="Logs"
        actions={
          <button type="button" className={secondaryBtn} onClick={() => fetchEmailServiceLogs(s.id).then(setLogs).catch((e: Error) => setNotice({ kind: "error", text: e.message }))}>
            {logs ? "Refresh" : "Load logs"}
          </button>
        }
      >
        {logs ? (
          <div className="grid gap-6 lg:grid-cols-2">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-ink/50">Audit trail</p>
              <ul className="mt-2 divide-y divide-ink/5 text-sm">
                {logs.audit.map((a) => (
                  <li key={a.id} className="py-2">
                    <span className="font-medium text-ink">{a.action.replace(/_/g, " ")}</span>
                    {a.mailboxAddress && <span className="text-ink/60"> · {a.mailboxAddress}</span>}
                    <p className="text-xs text-ink/50">
                      {formatDateTime(a.createdAt)} · {a.actor ?? a.actorType}
                      {a.reason ? ` · “${a.reason}”` : ""}
                    </p>
                  </li>
                ))}
                {logs.audit.length === 0 && <li className="py-2 text-ink/40">Nothing yet.</li>}
              </ul>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-ink/50">Provider operations</p>
              <ul className="mt-2 divide-y divide-ink/5 text-sm">
                {logs.operations.map((o) => (
                  <li key={o.id} className="py-2">
                    <span className="font-medium text-ink">{o.operation.replace(/_/g, " ")}</span>{" "}
                    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${o.outcome === "succeeded" ? "bg-green-100 text-green-700" : o.outcome === "unknown" ? "bg-amber-100 text-amber-700" : "bg-red-100 text-red-700"}`}>
                      {o.outcome}
                    </span>
                    {o.mailboxAddress && <span className="text-ink/60"> · {o.mailboxAddress}</span>}
                    <p className="text-xs text-ink/50">
                      {formatDateTime(o.createdAt)}
                      {o.errorCode ? ` · ${o.errorCode}: ${o.errorMessage ?? ""}` : ""}
                    </p>
                  </li>
                ))}
                {logs.operations.length === 0 && <li className="py-2 text-ink/40">Nothing yet.</li>}
              </ul>
            </div>
          </div>
        ) : (
          <p className="text-sm text-ink/40">Audit trail and provider operation history for this service.</p>
        )}
      </Card>

      <PromptModal prompt={prompt} onClose={() => setPrompt(null)} />
      <FulfillMailboxModal
        serviceId={s.id}
        serviceProviderId={s.provider.providerServiceId}
        mailbox={fulfilling}
        onClose={() => setFulfilling(null)}
        onDone={(text) => {
          setNotice({ kind: "ok", text });
          load();
        }}
      />
    </div>
  );
}

const LINK_STATUS_STYLE: Record<MailboxRequestLink["status"], string> = {
  open: "bg-sky-100 text-sky-700",
  used: "bg-green-100 text-green-700",
  revoked: "bg-ink/10 text-ink/50",
};

// Mailbox request links (CLAUDE.md §36). A link lets the client pick a
// name and domain on www.altasme.com without logging in; it is used once,
// and the request it makes shows up in Mailboxes above as "Requested by
// client", to fulfill or decline as usual. Reloads with the page, so a
// link the client just used flips to "Used" on the next refresh.
function RequestLinksCard({
  detail,
  canManage,
  blockedReason,
  onNotice,
}: {
  detail: EmailServiceDetail;
  canManage: boolean;
  blockedReason: string | null;
  onNotice: (n: { kind: "ok" | "warn" | "error"; text: string }) => void;
}) {
  const [links, setLinks] = useState<MailboxRequestLink[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const serviceId = detail.id;

  const reload = useCallback(() => {
    fetchMailboxRequestLinks(serviceId)
      .then(setLinks)
      .catch(() => setLinks([]));
  }, [serviceId]);
  useEffect(reload, [reload, detail]);

  const copy = async (link: MailboxRequestLink) => {
    try {
      await navigator.clipboard.writeText(link.url);
      setCopiedId(link.id);
      setTimeout(() => setCopiedId((c) => (c === link.id ? null : c)), 2000);
    } catch {
      onNotice({ kind: "warn", text: `Couldn't copy automatically. The link is: ${link.url}` });
    }
  };

  const visible = (links ?? []).filter((l) => showClosed || l.status === "open");
  const closedCount = (links ?? []).filter((l) => l.status !== "open").length;

  return (
    <Card
      title="Mailbox request links"
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {closedCount > 0 && (
            <button type="button" className="text-xs font-semibold text-ink/50 hover:text-ink" onClick={() => setShowClosed(!showClosed)}>
              {showClosed ? "Hide" : "Show"} used/revoked ({closedCount})
            </button>
          )}
          {canManage && (
            <button
              type="button"
              className={primaryBtn}
              disabled={busy || !!blockedReason}
              title={blockedReason ?? undefined}
              onClick={async () => {
                setBusy(true);
                try {
                  const link = await createMailboxRequestLink(serviceId);
                  onNotice({ kind: "ok", text: "Request link created. Copy it and send it to the client." });
                  setShowClosed(false);
                  setLinks((prev) => [link, ...(prev ?? [])]);
                } catch (err) {
                  onNotice({ kind: "error", text: (err as Error).message });
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Creating…" : "Generate mailbox request link"}
            </button>
          )}
        </div>
      }
    >
      <p className="text-xs text-ink/50">
        A one-time link the client opens on www.altasme.com to ask for a mailbox (no login). It shows them the service's domains and remaining slots; their request appears above as
        &ldquo;Requested by client&rdquo;. Each link works once.
      </p>
      {links === null ? (
        <p className="mt-3 text-sm text-ink/40">Loading…</p>
      ) : (
        <ul className="mt-3 divide-y divide-ink/5 text-sm">
          {visible.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="min-w-0 flex-1">
                <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${LINK_STATUS_STYLE[l.status]}`}>{l.status === "open" ? "Open" : l.status === "used" ? "Used" : "Revoked"}</span>
                <span className="ml-2 break-all font-mono text-xs text-ink/70">{l.url}</span>
                <p className="mt-0.5 text-xs text-ink/50">
                  Created {formatDateTime(l.createdAt)}
                  {l.createdBy ? ` · ${l.createdBy}` : ""}
                  {l.status === "used" && ` · used ${formatDateTime(l.usedAt)}${l.usedMailboxAddress ? ` for ${l.usedMailboxAddress}` : ""}`}
                </p>
              </div>
              {l.status === "open" && (
                <div className="flex gap-1">
                  <button type="button" className={secondaryBtn} onClick={() => copy(l)}>
                    {copiedId === l.id ? "Copied!" : "Copy link"}
                  </button>
                  {canManage && (
                    <button
                      type="button"
                      className={dangerBtn}
                      onClick={async () => {
                        try {
                          await revokeMailboxRequestLink(serviceId, l.id);
                          onNotice({ kind: "ok", text: "Request link revoked." });
                        } catch (err) {
                          onNotice({ kind: "error", text: (err as Error).message });
                        } finally {
                          reload();
                        }
                      }}
                    >
                      Revoke
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
          {visible.length === 0 && <li className="py-2 text-ink/40">{links.length ? "No open links." : "No request links yet."}</li>}
        </ul>
      )}
    </Card>
  );
}

function NotesEditor({ serviceId, initial, disabled, onSaved }: { serviceId: string; initial: string; disabled: boolean; onSaved: () => void }) {
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  useEffect(() => setValue(initial), [initial]);
  return (
    <div>
      <textarea id="es-notes-view" rows={3} className={`${inputClass} mt-1`} value={value} disabled={disabled} onChange={(e) => setValue(e.target.value)} />
      {!disabled && value !== initial && (
        <button
          type="button"
          className={`${secondaryBtn} mt-2`}
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            try {
              await updateEmailService(serviceId, { internalNotes: value });
              onSaved();
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? "Saving…" : "Save notes"}
        </button>
      )}
    </div>
  );
}
