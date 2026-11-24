// Mail settings: personal preferences (general / notifications / composer),
// identities + signatures, and -- for owner/admin -- mailbox management,
// per-staff access grants, and the business-wide security policy.
// No credential is ever displayed or editable here: SMTP passwords live
// only in Cloudflare secrets (see CLAUDE.md §32).

import { useEffect, useState, type ReactNode } from "react";
import RichTextEditor from "../RichTextEditor";
import { ApiError } from "../../lib/api";
import { mailApi, type Identity, type MailPolicy, type MailUserSettings, type Signature } from "../../lib/mailApi";
import { formatFullDate } from "../../lib/mailUtils";

type Tab = "general" | "notifications" | "composer" | "accounts" | "admin" | "security";

function Row({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:gap-4">
      <span className="text-sm font-medium text-ink sm:w-56 sm:shrink-0">
        {label}
        {hint && <span className="block text-xs font-normal text-ink/60">{hint}</span>}
      </span>
      <span className="min-w-0 flex-1">{children}</span>
    </label>
  );
}

const input = "w-full rounded-lg border border-ink/15 bg-white px-2 py-1.5 text-sm";

function SignatureEditor({ accountId, sig, onDone }: { accountId: string; sig?: Signature; onDone: () => void }) {
  const [name, setName] = useState(sig?.name ?? "");
  const [html, setHtml] = useState(sig?.bodyHtml ?? "");
  const [useForNew, setUseForNew] = useState(sig?.useForNew ?? true);
  const [useForReply, setUseForReply] = useState(sig?.useForReply ?? true);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setError(null);
    try {
      if (sig) await mailApi.updateSignature(sig.id, { name, bodyHtml: html, useForNew, useForReply });
      else await mailApi.createSignature(accountId, { name, bodyHtml: html, useForNew, useForReply });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save signature.");
    }
  };
  return (
    <div className="space-y-2 rounded-lg border border-ink/10 p-3">
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Signature name" aria-label="Signature name" className={input} />
      <RichTextEditor value={html} onChange={setHtml} toolbar="mail" minHeightClass="min-h-[100px]" placeholder="Name, title, phone, website… (links and images allowed)" />
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" checked={useForNew} onChange={(e) => setUseForNew(e.target.checked)} className="accent-brand-blue" /> Use for new messages</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={useForReply} onChange={(e) => setUseForReply(e.target.checked)} className="accent-brand-blue" /> Use for replies</label>
      </div>
      <p className="text-xs text-ink/60">Untick "Use for replies" on every signature to send replies without one.</p>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <div className="flex gap-2">
        <button type="button" onClick={() => void save()} className="rounded-full bg-brand-blue px-4 py-1.5 text-sm font-semibold text-white">Save signature</button>
        <button type="button" onClick={onDone} className="rounded-full px-3 py-1.5 text-sm text-ink/70">Cancel</button>
      </div>
    </div>
  );
}

function IdentityAdmin({ identity, onChanged }: { identity: Identity; onChanged: () => void }) {
  const [f, setF] = useState({ displayName: identity.displayName, replyTo: identity.replyTo ?? "", smtpProfile: identity.smtpProfile ?? "", inboundEnabled: identity.inboundEnabled, outboundEnabled: identity.outboundEnabled, isActive: identity.isActive });
  const [staff, setStaff] = useState<{ id: string; email: string; fullName: string | null; role: string }[] | null>(null);
  const [grants, setGrants] = useState<Map<string, boolean>>(new Map());
  const [msg, setMsg] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open || staff) return;
    Promise.all([mailApi.staff(), mailApi.identityAccess(identity.id)])
      .then(([s, a]) => {
        setStaff(s.staff);
        setGrants(new Map(a.grants.map((g) => [g.userId, g.canSend])));
      })
      .catch((err) => setMsg(err instanceof ApiError ? err.message : "Couldn't load access list."));
  }, [open, staff, identity.id]);

  const saveFields = async () => {
    setMsg(null);
    try {
      await mailApi.updateIdentity(identity.id, f);
      setMsg("Saved.");
      onChanged();
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : "Couldn't save.");
    }
  };
  const saveAccess = async () => {
    setMsg(null);
    try {
      await mailApi.setIdentityAccess(identity.id, [...grants].map(([userId, canSend]) => ({ userId, canSend })));
      setMsg("Access saved.");
      onChanged();
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : "Couldn't save access.");
    }
  };

  return (
    <div className="rounded-xl border border-ink/10">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full min-w-0 items-center gap-2 px-4 py-3 text-left" aria-expanded={open}>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{identity.emailAddress}</span>
        {!identity.isActive && <span className="rounded bg-ink/10 px-1.5 text-[11px]">Inactive</span>}
        <span className="text-xs text-ink/60">{identity.accessCount ?? 0} with access</span>
        <span aria-hidden="true">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div className="space-y-1 border-t border-ink/10 px-4 py-3">
          <Row label="Display name"><input className={input} value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} /></Row>
          <Row label="Reply-To" hint="Optional"><input className={input} value={f.replyTo} onChange={(e) => setF({ ...f, replyTo: e.target.value })} /></Row>
          <Row label="SMTP profile" hint="Blank = default MAIL_SMTP_* relay; otherwise a key in MAIL_SMTP_PROFILES_JSON"><input className={input} value={f.smtpProfile} onChange={(e) => setF({ ...f, smtpProfile: e.target.value })} /></Row>
          <div className="flex flex-wrap gap-4 py-2 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" className="accent-brand-blue" checked={f.inboundEnabled} onChange={(e) => setF({ ...f, inboundEnabled: e.target.checked })} /> Receive mail</label>
            <label className="flex items-center gap-2"><input type="checkbox" className="accent-brand-blue" checked={f.outboundEnabled} onChange={(e) => setF({ ...f, outboundEnabled: e.target.checked })} /> Send mail</label>
            <label className="flex items-center gap-2"><input type="checkbox" className="accent-brand-blue" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} /> Active</label>
          </div>
          <button type="button" onClick={() => void saveFields()} className="rounded-full bg-brand-blue px-4 py-1.5 text-sm font-semibold text-white">Save mailbox</button>

          <div className="pt-4">
            <p className="text-sm font-semibold">Who can use this mailbox</p>
            <p className="text-xs text-ink/60">Nobody has access until granted here, including owners and admins.</p>
            {!staff ? (
              <p className="py-2 text-sm text-ink/60">Loading staff…</p>
            ) : (
              <ul className="mt-2 divide-y divide-ink/5">
                {staff.map((s) => {
                  const has = grants.has(s.id);
                  return (
                    <li key={s.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                      <label className="flex min-w-0 flex-1 items-center gap-2">
                        <input type="checkbox" className="accent-brand-blue" checked={has} onChange={(e) => {
                          const n = new Map(grants);
                          if (e.target.checked) n.set(s.id, true);
                          else n.delete(s.id);
                          setGrants(n);
                        }} />
                        <span className="min-w-0 truncate">{s.fullName || s.email} <span className="text-xs capitalize text-ink/60">· {s.role}</span></span>
                      </label>
                      {has && (
                        <label className="flex items-center gap-2 text-xs">
                          <input type="checkbox" className="accent-brand-blue" checked={grants.get(s.id)} onChange={(e) => setGrants(new Map(grants).set(s.id, e.target.checked))} /> Can send
                        </label>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            <button type="button" onClick={() => void saveAccess()} disabled={!staff} className="mt-2 rounded-full border border-brand-blue px-4 py-1.5 text-sm font-semibold text-brand-blue disabled:opacity-50">Save access</button>
          </div>
          {msg && <p className="pt-2 text-sm text-ink/70" role="status">{msg}</p>}
        </div>
      )}
    </div>
  );
}

export default function MailSettings({ onClose, onChanged, identities }: { onClose: () => void; onChanged: () => void; identities: Identity[] }) {
  const [tab, setTab] = useState<Tab>("general");
  const [settings, setSettings] = useState<MailUserSettings | null>(null);
  const [policy, setPolicy] = useState<MailPolicy | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [allIdentities, setAllIdentities] = useState<Identity[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [editingSig, setEditingSig] = useState<{ accountId: string; sig?: Signature } | null>(null);
  const [newId, setNewId] = useState({ emailAddress: "", displayName: "" });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    mailApi.settings().then((s) => {
      setSettings(s.user);
      setPolicy(s.policy);
      setIsAdmin(s.isAdmin);
      if (s.isAdmin) mailApi.identities(true).then((r) => setAllIdentities(r.identities)).catch(() => undefined);
    }).catch((err) => setStatus(err instanceof ApiError ? err.message : "Couldn't load settings."));
  }, [nonce]);

  const save = async (patch: { user?: Partial<MailUserSettings>; policy?: Partial<MailPolicy> }) => {
    setStatus(null);
    try {
      const r = await mailApi.saveSettings(patch);
      setSettings(r.user);
      setPolicy(r.policy);
      setStatus("Saved.");
      onChanged();
    } catch (err) {
      setStatus(err instanceof ApiError ? err.message : "Couldn't save.");
    }
  };
  const refreshAll = () => {
    setNonce((n) => n + 1);
    onChanged();
  };

  const tabs: [Tab, string][] = [["general", "General"], ["notifications", "Notifications"], ["composer", "Composer"], ["accounts", "Identities & signatures"], ...(isAdmin ? ([["admin", "Mailboxes & access"], ["security", "Security"]] as [Tab, string][]) : [])];
  const s = settings;

  return (
    <div role="dialog" aria-modal="true" aria-label="Mail settings" className="fixed inset-0 z-[65] flex flex-col bg-white md:inset-6 md:rounded-2xl md:shadow-2xl md:ring-1 md:ring-ink/10">
      <header className="flex shrink-0 items-center gap-3 border-b border-ink/10 px-4 py-3">
        <h2 className="flex-1 text-lg font-bold text-brand-navy">Mail settings</h2>
        {status && <span className="text-sm text-ink/70" role="status">{status}</span>}
        <button type="button" onClick={onClose} aria-label="Close settings" className="text-2xl leading-none text-ink/60 hover:text-ink">&times;</button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-ink/10 p-2 md:w-56 md:flex-col md:border-b-0 md:border-r">
          {tabs.map(([id, label]) => (
            <button key={id} type="button" onClick={() => setTab(id)} className={`shrink-0 rounded-lg px-3 py-2 text-left text-sm ${tab === id ? "bg-brand-blue text-white" : "text-ink/70 hover:bg-paper-alt"}`}>{label}</button>
          ))}
        </nav>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 md:p-6">
          {!s || !policy ? (
            <p className="text-sm text-ink/60">Loading…</p>
          ) : tab === "general" ? (
            <div className="max-w-2xl divide-y divide-ink/5">
              <Row label="Default mailbox">
                <select className={input} value={s.defaultAccountId ?? ""} onChange={(e) => void save({ user: { defaultAccountId: e.target.value || null } })}>
                  <option value="">All mailboxes (unified)</option>
                  {identities.map((i) => <option key={i.id} value={i.id}>{i.emailAddress}</option>)}
                </select>
              </Row>
              <Row label="Default folder">
                <select className={input} value={s.defaultFolder} onChange={(e) => void save({ user: { defaultFolder: e.target.value as MailUserSettings["defaultFolder"] } })}>
                  {["inbox", "starred", "sent", "drafts", "archive"].map((f) => <option key={f} value={f}>{f[0]!.toUpperCase() + f.slice(1)}</option>)}
                </select>
              </Row>
              <Row label="Sort order">
                <select className={input} value={s.sortOrder} onChange={(e) => void save({ user: { sortOrder: e.target.value as "newest" | "oldest" } })}>
                  <option value="newest">Newest first</option>
                  <option value="oldest">Oldest first</option>
                </select>
              </Row>
              <Row label="Message density">
                <select className={input} value={s.density} onChange={(e) => void save({ user: { density: e.target.value as "comfortable" | "compact" } })}>
                  <option value="comfortable">Comfortable (with preview)</option>
                  <option value="compact">Compact</option>
                </select>
              </Row>
              <Row label="Reading pane" hint="Desktop only">
                <select className={input} value={s.readingPane} onChange={(e) => void save({ user: { readingPane: e.target.value as "right" | "full" } })}>
                  <option value="right">Right of the list</option>
                  <option value="full">Full width (open replaces the list)</option>
                </select>
              </Row>
              <Row label="Check for new mail every" hint="Slower while the tab is in the background">
                <select className={input} value={s.refreshIntervalSec} onChange={(e) => void save({ user: { refreshIntervalSec: Number(e.target.value) } })}>
                  {[30, 45, 60, 120, 300].map((n) => <option key={n} value={n}>{n < 60 ? `${n} seconds` : `${n / 60} minute${n > 60 ? "s" : ""}`}</option>)}
                </select>
              </Row>
            </div>
          ) : tab === "notifications" ? (
            <div className="max-w-2xl space-y-3 text-sm">
              <label className="flex items-center gap-2"><input type="checkbox" className="accent-brand-blue" checked={s.notifyNewMail} onChange={(e) => void save({ user: { notifyNewMail: e.target.checked } })} /> Show a notice when new mail arrives</label>
              <label className="flex items-center gap-2"><input type="checkbox" className="accent-brand-blue" checked={s.sound} onChange={(e) => void save({ user: { sound: e.target.checked } })} /> Play a sound</label>
              <label className="flex items-center gap-2">
                <input type="checkbox" className="accent-brand-blue" checked={s.desktopNotifications} onChange={async (e) => {
                  const on = e.target.checked;
                  if (on && "Notification" in window && Notification.permission !== "granted") {
                    const p = await Notification.requestPermission();
                    if (p !== "granted") return setStatus("Desktop notifications were not allowed by the browser.");
                  }
                  void save({ user: { desktopNotifications: on } });
                }} /> Desktop notifications {!("Notification" in window) && <span className="text-xs text-ink/60">(not supported in this browser)</span>}
              </label>
              <label className="flex items-center gap-2"><input type="checkbox" className="accent-brand-blue" checked={s.unreadBadge} onChange={(e) => void save({ user: { unreadBadge: e.target.checked } })} /> Show unread count in the browser tab title</label>
            </div>
          ) : tab === "composer" ? (
            <div className="max-w-2xl divide-y divide-ink/5">
              <Row label="Formatting">
                <select className={input} value={s.composerFormat} onChange={(e) => void save({ user: { composerFormat: e.target.value as "rich" | "plain" } })}>
                  <option value="rich">Rich text</option>
                  <option value="plain">Plain text</option>
                </select>
              </Row>
              <Row label="Autosave drafts" hint="Drafts are always saved when you close the composer">
                <input type="checkbox" className="accent-brand-blue" checked={s.autosave} onChange={(e) => void save({ user: { autosave: e.target.checked } })} />
              </Row>
              <p className="py-3 text-sm text-ink/60">Signatures are set per identity under "Identities & signatures".</p>
            </div>
          ) : tab === "accounts" ? (
            <div className="max-w-3xl space-y-4">
              {identities.length === 0 && <p className="text-sm text-ink/60">You don't have access to any mailbox yet. Ask an owner or admin to grant it.</p>}
              {identities.map((i) => (
                <section key={i.id} className="rounded-xl border border-ink/10 p-4">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <h3 className="text-base font-semibold text-brand-navy">{i.displayName}</h3>
                    <span className="text-sm text-ink/60">{i.emailAddress}</span>
                  </div>
                  <dl className="mt-2 grid grid-cols-1 gap-1 text-sm sm:grid-cols-2">
                    <div><dt className="inline text-ink/60">Sending (SMTP): </dt><dd className={`inline font-semibold ${i.smtpStatus === "configured" && i.outboundEnabled ? "text-emerald-700" : "text-amber-700"}`}>{!i.outboundEnabled ? "Disabled" : i.smtpStatus === "configured" ? "Configured" : "Not configured"}</dd></div>
                    <div><dt className="inline text-ink/60">Receiving: </dt><dd className="inline font-semibold">{i.inboundEnabled ? (i.lastInboundAt ? `On · last mail ${formatFullDate(i.lastInboundAt)}` : "On · nothing received yet") : "Disabled"}</dd></div>
                    <div><dt className="inline text-ink/60">Reply-To: </dt><dd className="inline">{i.replyTo || "(same as address)"}</dd></div>
                    <div><dt className="inline text-ink/60">Your access: </dt><dd className="inline">{i.canSend ? "Read & send" : "Read only"}</dd></div>
                  </dl>
                  <div className="mt-3">
                    <p className="text-sm font-semibold">Signatures</p>
                    <ul className="mt-1 space-y-1">
                      {i.signatures.map((sig) => (
                        <li key={sig.id} className="flex flex-wrap items-center gap-2 text-sm">
                          <span className="min-w-0 flex-1 truncate">{sig.name}{sig.useForNew && <span className="ml-2 rounded bg-brand-blue/10 px-1.5 text-[11px]">new</span>}{sig.useForReply && <span className="ml-1 rounded bg-brand-blue/10 px-1.5 text-[11px]">reply</span>}</span>
                          {i.canSend && (
                            <>
                              <button type="button" className="text-xs font-semibold text-brand-blue" onClick={() => setEditingSig({ accountId: i.id, sig })}>Edit</button>
                              <button type="button" className="text-xs font-semibold text-red-700" onClick={() => window.confirm("Delete this signature?") && mailApi.deleteSignature(sig.id).then(refreshAll)}>Delete</button>
                            </>
                          )}
                        </li>
                      ))}
                      {i.signatures.length === 0 && <li className="text-sm text-ink/60">No signature.</li>}
                    </ul>
                    {editingSig?.accountId === i.id ? (
                      <div className="mt-2"><SignatureEditor accountId={i.id} sig={editingSig.sig} onDone={() => { setEditingSig(null); refreshAll(); }} /></div>
                    ) : (
                      i.canSend && <button type="button" onClick={() => setEditingSig({ accountId: i.id })} className="mt-2 text-sm font-semibold text-brand-blue">+ Add signature</button>
                    )}
                  </div>
                </section>
              ))}
            </div>
          ) : tab === "admin" ? (
            <div className="max-w-3xl space-y-3">
              <form className="flex flex-col gap-2 rounded-xl bg-paper-alt p-4 sm:flex-row" onSubmit={async (e) => {
                e.preventDefault();
                setStatus(null);
                try {
                  await mailApi.createIdentity(newId);
                  setNewId({ emailAddress: "", displayName: "" });
                  setStatus("Mailbox added. Grant access below.");
                  refreshAll();
                } catch (err) {
                  setStatus(err instanceof ApiError ? err.message : "Couldn't add mailbox.");
                }
              }}>
                <input className={input} placeholder="support@altasme.com" aria-label="New mailbox address" value={newId.emailAddress} onChange={(e) => setNewId({ ...newId, emailAddress: e.target.value })} />
                <input className={input} placeholder="Display name" aria-label="New mailbox display name" value={newId.displayName} onChange={(e) => setNewId({ ...newId, displayName: e.target.value })} />
                <button type="submit" className="shrink-0 rounded-full bg-brand-blue px-4 py-1.5 text-sm font-semibold text-white">Add mailbox</button>
              </form>
              <p className="text-xs text-ink/60">Receiving also requires an Email Routing rule in Cloudflare sending this address to the mail worker. Sending requires the SMTP secrets to be set (CLAUDE.md §32).</p>
              {allIdentities.map((i) => <IdentityAdmin key={i.id} identity={i} onChanged={refreshAll} />)}
            </div>
          ) : (
            <form className="max-w-2xl divide-y divide-ink/5" onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              const mb = (k: string) => Math.round(Number(fd.get(k)) * 1024 * 1024);
              void save({ policy: {
                maxAttachmentBytes: mb("maxAttachmentMb"),
                maxTotalAttachmentBytes: mb("maxTotalMb"),
                maxAttachmentCount: Number(fd.get("maxAttachmentCount")),
                maxRecipients: Number(fd.get("maxRecipients")),
                sendsPerHourPerUser: Number(fd.get("sendsPerHourPerUser")),
                remoteImagePolicy: fd.get("remoteImagePolicy") as MailPolicy["remoteImagePolicy"],
              } });
            }}>
              <Row label="Max size per attachment (MB)" hint="1–25"><input name="maxAttachmentMb" type="number" min={1} max={25} defaultValue={policy.maxAttachmentBytes / 1048576} className={input} /></Row>
              <Row label="Max total attachments (MB)" hint="1–30"><input name="maxTotalMb" type="number" min={1} max={30} defaultValue={policy.maxTotalAttachmentBytes / 1048576} className={input} /></Row>
              <Row label="Max attachments per message"><input name="maxAttachmentCount" type="number" min={1} max={20} defaultValue={policy.maxAttachmentCount} className={input} /></Row>
              <Row label="Max recipients per message"><input name="maxRecipients" type="number" min={1} max={100} defaultValue={policy.maxRecipients} className={input} /></Row>
              <Row label="Send limit per staff member per hour"><input name="sendsPerHourPerUser" type="number" min={1} max={1000} defaultValue={policy.sendsPerHourPerUser} className={input} /></Row>
              <Row label="Remote images" hint="Remote images can track when an email is opened">
                <select name="remoteImagePolicy" defaultValue={policy.remoteImagePolicy} className={input}>
                  <option value="block">Block, with a "Load remote images" button</option>
                  <option value="never">Always block</option>
                  <option value="allow">Always load</option>
                </select>
              </Row>
              <div className="pt-4"><button type="submit" className="rounded-full bg-brand-blue px-5 py-2 text-sm font-semibold text-white">Save security settings</button></div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
