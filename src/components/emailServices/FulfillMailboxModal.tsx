// "Fulfill manually" dialog for EmailServiceDetailPage (CLAUDE.md §35).
// Staff create the mailbox in Z.com's own dashboard, then record it here:
// Z.com's ids plus the SMTP profile key the mail worker will use for it.
// There is deliberately no password field: the mailbox password lives in
// Z.com, and the SMTP login goes into the mail worker's
// MAIL_SMTP_PROFILES_JSON secret, never into ClientKeeper.

import { useEffect, useState, type FormEvent } from "react";
import Modal from "../Modal";
import { defaultSmtpProfileKey, fulfillEmailMailbox, type EmailMailbox } from "../../lib/emailServicesApi";

const inputClass = "w-full rounded-lg border border-ink/15 px-3 py-2 text-sm outline-none focus:border-brand-blue";
const primaryBtn = "rounded-full bg-brand-blue px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#0b57cc] disabled:opacity-50";

export default function FulfillMailboxModal({
  serviceId,
  serviceProviderId,
  mailbox,
  onClose,
  onDone,
}: {
  serviceId: string;
  serviceProviderId: string | null;
  mailbox: EmailMailbox | null;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [providerMailboxId, setProviderMailboxId] = useState("");
  const [providerServiceId, setProviderServiceId] = useState("");
  const [smtpProfileKey, setSmtpProfileKey] = useState("");
  const [createBridge, setCreateBridge] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!mailbox) return;
    setProviderMailboxId(mailbox.providerMailboxId ?? "");
    setProviderServiceId(mailbox.providerServiceId ?? serviceProviderId ?? "");
    setSmtpProfileKey(defaultSmtpProfileKey(serviceId, mailbox.address));
    setCreateBridge(true);
    setError(null);
  }, [mailbox, serviceId, serviceProviderId]);

  if (!mailbox) return null;
  const domain = mailbox.address.split("@")[1] ?? "";
  const key = smtpProfileKey.trim() || "(enter a key above)";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!providerMailboxId.trim()) {
      setError("Z.com mailbox id is required.");
      return;
    }
    if (createBridge && !smtpProfileKey.trim()) {
      setError("SMTP profile key is required to create the webmail bridge account.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await fulfillEmailMailbox(serviceId, mailbox.id, {
        providerMailboxId: providerMailboxId.trim(),
        providerServiceId: providerServiceId.trim() || undefined,
        smtpProfileKey: createBridge ? smtpProfileKey.trim() : undefined,
        createBridgeAccount: createBridge,
      });
      onDone(
        r.smtpProfile
          ? `${mailbox.address} is active and linked to webmail. SMTP profile key: "${r.smtpProfile}".`
          : `${mailbox.address} is active.`
      );
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={`Fulfill ${mailbox.address} manually`}>
      <form onSubmit={submit} className="space-y-3">
        <p className="text-sm text-ink/60">Records a mailbox you created yourself in Z.com's dashboard. Nothing is sent to Z.com from here.</p>
        <div>
          <label className="text-xs font-semibold text-ink/60" htmlFor="fulfill-mailbox-id">
            Z.com mailbox id
          </label>
          <input id="fulfill-mailbox-id" className={`${inputClass} mt-1`} autoComplete="off" value={providerMailboxId} onChange={(e) => setProviderMailboxId(e.target.value)} />
        </div>
        <div>
          <label className="text-xs font-semibold text-ink/60" htmlFor="fulfill-service-id">
            Z.com service id (optional)
          </label>
          <input id="fulfill-service-id" className={`${inputClass} mt-1`} autoComplete="off" value={providerServiceId} onChange={(e) => setProviderServiceId(e.target.value)} />
        </div>
        <label className="flex items-start gap-2 text-sm text-ink/80">
          <input type="checkbox" className="mt-1" checked={createBridge} onChange={(e) => setCreateBridge(e.target.checked)} />
          <span>Create webmail bridge account (so this mailbox appears in /mail and syncs from Z.com)</span>
        </label>
        {createBridge && (
          <div>
            <label className="text-xs font-semibold text-ink/60" htmlFor="fulfill-smtp-key">
              SMTP profile key
            </label>
            <input id="fulfill-smtp-key" className={`${inputClass} mt-1 font-mono`} autoComplete="off" value={smtpProfileKey} onChange={(e) => setSmtpProfileKey(e.target.value)} />
            <p className="mt-1 text-xs text-ink/50">A name only, not a password. Lowercase letters, numbers, dots, dashes, underscores.</p>
          </div>
        )}

        <div className="rounded-xl border border-ink/10 bg-paper-alt p-3 text-xs text-ink/70">
          <p className="mb-1 font-semibold text-ink/80">Runbook</p>
          <ol className="list-decimal space-y-1 pl-4">
            <li>
              Create the mailbox <span className="font-mono">{mailbox.address}</span> in Z.com's own dashboard.
            </li>
            <li>Set its password there. Never type it into ClientKeeper.</li>
            <li>Copy the Z.com mailbox id (and service id) into the fields above, then click Fulfill.</li>
            {createBridge && (
              <li>
                Give Claude the SMTP host, port, username and password for {mailbox.address}, and this exact profile key: <span className="font-mono">"{key}"</span>. It goes into the mail worker's{" "}
                <span className="font-mono">MAIL_SMTP_PROFILES_JSON</span> secret, then the worker is redeployed. Until then, sending from this mailbox in /mail fails with "not configured".
              </li>
            )}
            <li>
              Altaventures manages DNS for <span className="font-mono">{domain}</span>: once you confirm the mailbox is live in Z.com, Claude publishes its MX, SPF and DKIM records (from Z.com's settings) in Cloudflare, if
              they aren't there already.
            </li>
          </ol>
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="rounded-full px-4 py-2 text-sm font-semibold text-ink/60 hover:bg-paper-alt">
            Cancel
          </button>
          <button type="submit" disabled={busy} className={primaryBtn}>
            {busy ? "Working…" : "Fulfill"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
