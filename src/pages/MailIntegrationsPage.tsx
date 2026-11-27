// /email-services/integrations -- Altaventures' registry of Webmail Connect
// integrations (CLAUDE.md §38): which client each registered admin panel
// belongs to, active/disabled, its API secret (generate on create, rotate),
// and which extra mailboxes staff allow it to grant. A client's own users
// and their per-mailbox access are managed in the CLIENT's panel through
// the integration's API, never here.
//
// The secret is displayed once, right after create/rotate, and can't be
// fetched again. Mutations are owner/admin (server-enforced; the buttons
// are hidden for other roles only as a convenience).

import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import Modal from "../components/Modal";
import { useMe } from "../lib/MeContext";
import { apiFetch, fetchClients, type ClientListRow } from "../lib/api";
import { canManageEmail } from "../lib/emailServicesApi";

interface Integration {
  id: string;
  clientId: string;
  clientName: string;
  businessName: string;
  name: string;
  status: "active" | "disabled";
  attachedMailboxCount: number;
  grantCount: number;
  createdAt: string;
}

interface IntegrationMailbox {
  mailAccountId: string;
  emailAddress: string;
  displayName: string;
  source: "client_hosted" | "attached";
  grantCount: number;
}

const BASE = "/api/app/mail-integrations";
const inputClass = "w-full rounded-lg border border-ink/15 px-3 py-2 text-sm outline-none focus:border-brand-blue";

function SecretBox({ secret, onDone }: { secret: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-4 rounded-2xl border border-amber-300 bg-amber-50 p-4">
      <p className="text-sm font-semibold text-amber-900">Copy this secret now. It won't be shown again.</p>
      <p className="mt-1 text-xs text-amber-900/80">Store it only in the client panel's server-side configuration. Never put it in browser code.</p>
      <code className="mt-2 block break-all rounded-lg bg-white px-3 py-2 text-xs text-ink">{secret}</code>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={() => navigator.clipboard?.writeText(secret).then(() => setCopied(true)).catch(() => undefined)}
          className="rounded-full bg-brand-blue px-4 py-1.5 text-sm font-semibold text-white"
        >
          {copied ? "Copied" : "Copy"}
        </button>
        <button type="button" onClick={onDone} className="rounded-full px-3 py-1.5 text-sm font-semibold text-ink/70 hover:bg-white">
          I've saved it
        </button>
      </div>
    </div>
  );
}

export default function MailIntegrationsPage() {
  const { staffUser } = useMe();
  const canManage = canManageEmail(staffUser);
  const [items, setItems] = useState<Integration[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);

  const load = () =>
    apiFetch<{ integrations: Integration[] }>(BASE)
      .then((r) => setItems(r.integrations))
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
        <h1 className="text-2xl font-bold text-brand-navy">Mail Integrations</h1>
        {canManage && (
          <button type="button" onClick={() => setCreating(true)} className="rounded-full bg-brand-blue px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#0b57cc]">
            + New Integration
          </button>
        )}
      </div>
      <p className="mt-1 text-sm text-ink/60">Client admin panels that open webmail through Webmail Connect. Each one can only grant its own client's mailboxes, plus any mailbox attached here.</p>
      {error && <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
      {secret && <SecretBox secret={secret} onDone={() => setSecret(null)} />}

      <div className="mt-6 space-y-3">
        {items.length === 0 && <p className="text-sm text-ink/60">No integrations yet.</p>}
        {items.map((i) => (
          <div key={i.id} className="rounded-2xl border border-ink/10 bg-white">
            <button type="button" onClick={() => setOpenId(openId === i.id ? null : i.id)} className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold text-brand-navy">{i.name}</span>
                <span className="block truncate text-xs text-ink/60">{i.businessName || i.clientName}</span>
              </span>
              <span className="text-xs text-ink/60">{i.grantCount} grant{i.grantCount === 1 ? "" : "s"}</span>
              <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${i.status === "active" ? "bg-emerald-50 text-emerald-700" : "bg-ink/5 text-ink/60"}`}>{i.status}</span>
            </button>
            {openId === i.id && <IntegrationDetail id={i.id} canManage={canManage} onChanged={load} onSecret={setSecret} />}
          </div>
        ))}
      </div>

      {creating && (
        <CreateIntegration
          onClose={() => setCreating(false)}
          onCreated={(s) => {
            setCreating(false);
            setSecret(s);
            load();
          }}
        />
      )}
    </div>
  );
}

function CreateIntegration({ onClose, onCreated }: { onClose: () => void; onCreated: (secret: string) => void }) {
  const [clients, setClients] = useState<ClientListRow[]>([]);
  const [clientId, setClientId] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchClients()
      .then(setClients)
      .catch((err: Error) => setError(err.message));
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const r = await apiFetch<{ secret: string }>(BASE, { method: "POST", body: JSON.stringify({ clientId, name }) });
      onCreated(r.secret);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the integration.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="New Mail Integration">
      <form onSubmit={submit} className="space-y-3">
        <label className="block text-sm">
          <span className="font-semibold text-ink/80">Client</span>
          <select value={clientId} onChange={(e) => setClientId(e.target.value)} className={inputClass} required>
            <option value="">Choose a client…</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.businessName || c.fullName}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="font-semibold text-ink/80">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Acme Corp Admin Panel" className={inputClass} required />
        </label>
        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <button type="submit" disabled={saving || !clientId || !name.trim()} className="rounded-full bg-brand-blue px-5 py-2 text-sm font-semibold text-white disabled:opacity-60">
          {saving ? "Creating…" : "Create and show secret"}
        </button>
      </form>
    </Modal>
  );
}

function IntegrationDetail({ id, canManage, onChanged, onSecret }: { id: string; canManage: boolean; onChanged: () => void; onSecret: (s: string) => void }) {
  const [detail, setDetail] = useState<{ integration: Integration; mailboxes: IntegrationMailbox[] } | null>(null);
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    apiFetch<{ integration: Integration; mailboxes: IntegrationMailbox[] }>(`${BASE}/${id}`)
      .then(setDetail)
      .catch((err: Error) => setError(err.message));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work.");
    }
  };

  if (!detail) return <p className="border-t border-ink/5 px-4 py-3 text-sm text-ink/60">{error ?? "Loading…"}</p>;
  const i = detail.integration;
  return (
    <div className="space-y-4 border-t border-ink/5 px-4 py-4 text-sm">
      <p className="text-xs text-ink/60">
        Integration id <code className="rounded bg-paper-alt px-1">{i.id}</code>
      </p>
      {canManage && (
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => run(() => apiFetch(`${BASE}/${id}`, { method: "PATCH", body: JSON.stringify({ status: i.status === "active" ? "disabled" : "active" }) }))} className="rounded-full border border-ink/15 px-3 py-1.5 font-semibold text-ink/80 hover:bg-paper-alt">
            {i.status === "active" ? "Disable" : "Enable"}
          </button>
          <button
            type="button"
            onClick={() => {
              if (window.confirm("Rotate the secret? The current one stops working immediately.")) void run(async () => onSecret((await apiFetch<{ secret: string }>(`${BASE}/${id}/rotate-secret`, { method: "POST", body: "{}" })).secret));
            }}
            className="rounded-full border border-ink/15 px-3 py-1.5 font-semibold text-ink/80 hover:bg-paper-alt"
          >
            Rotate secret
          </button>
        </div>
      )}
      <div>
        <p className="font-semibold text-ink/80">Mailboxes this integration may grant</p>
        {detail.mailboxes.length === 0 && <p className="mt-1 text-ink/60">None yet. Its client has no active hosted mailboxes, and none are attached.</p>}
        <ul className="mt-2 divide-y divide-ink/5">
          {detail.mailboxes.map((m) => (
            <li key={m.mailAccountId} className="flex flex-wrap items-center gap-2 py-2">
              <span className="min-w-0 flex-1 truncate">{m.emailAddress}</span>
              <span className="text-xs text-ink/60">{m.source === "attached" ? "attached by staff" : "client-hosted"}</span>
              <span className="text-xs text-ink/60">{m.grantCount} grant{m.grantCount === 1 ? "" : "s"}</span>
              {canManage && m.source === "attached" && (
                <button type="button" onClick={() => run(() => apiFetch(`${BASE}/${id}/mailboxes`, { method: "DELETE", body: JSON.stringify({ mailAccountId: m.mailAccountId }) }))} className="text-xs font-semibold text-red-700 hover:underline">
                  Detach
                </button>
              )}
            </li>
          ))}
        </ul>
        {canManage && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => apiFetch(`${BASE}/${id}/mailboxes`, { method: "POST", body: JSON.stringify({ address }) })).then(() => setAddress(""));
            }}
            className="mt-2 flex gap-2"
          >
            <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Attach another mailbox, e.g. sales@altasme.com" className={inputClass} />
            <button type="submit" disabled={!address.trim()} className="shrink-0 rounded-full bg-brand-blue px-4 py-2 font-semibold text-white disabled:opacity-60">
              Attach
            </button>
          </form>
        )}
      </div>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-red-800">{error}</p>}
    </div>
  );
}
