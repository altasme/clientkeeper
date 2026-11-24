import { useState } from "react";
import Modal from "../Modal";
import { ApiError } from "../../lib/api";
import { mailApi, type Identity, type Label } from "../../lib/mailApi";

const PALETTE = ["#0D68EF", "#02256F", "#16A34A", "#D97706", "#DC2626", "#7C3AED", "#DB2777", "#0891B2", "#4B5563"];

export default function MailLabelManager({ open, onClose, identities, labels, defaultAccountId, onChanged }: { open: boolean; onClose: () => void; identities: Identity[]; labels: Label[]; defaultAccountId: string; onChanged: () => void }) {
  const [accountId, setAccountId] = useState(defaultAccountId !== "all" ? defaultAccountId : identities[0]?.id ?? "");
  const [name, setName] = useState("");
  const [color, setColor] = useState(PALETTE[0]!);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; name: string; color: string } | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    }
  };

  const accountLabels = labels.filter((l) => l.accountId === accountId);

  return (
    <Modal open={open} onClose={onClose} title="Labels">
      {identities.length > 1 && (
        <select value={accountId} onChange={(e) => setAccountId(e.target.value)} aria-label="Mailbox" className="mb-3 w-full rounded-lg border border-ink/15 px-2 py-2 text-sm">
          {identities.map((i) => <option key={i.id} value={i.id}>{i.emailAddress}</option>)}
        </select>
      )}
      <ul className="space-y-1">
        {accountLabels.length === 0 && <li className="text-sm text-ink/60">No labels in this mailbox.</li>}
        {accountLabels.map((l) =>
          editing?.id === l.id ? (
            <li key={l.id} className="flex flex-wrap items-center gap-2">
              <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} aria-label="Label name" className="min-w-0 flex-1 rounded-lg border border-ink/15 px-2 py-1 text-sm" />
              <input type="color" value={editing.color} onChange={(e) => setEditing({ ...editing, color: e.target.value })} aria-label="Label color" className="h-8 w-8" />
              <button type="button" className="text-sm font-semibold text-brand-blue" onClick={() => run(async () => { await mailApi.updateLabel(l.id, { name: editing.name, color: editing.color }); setEditing(null); })}>Save</button>
              <button type="button" className="text-sm text-ink/60" onClick={() => setEditing(null)}>Cancel</button>
            </li>
          ) : (
            <li key={l.id} className="flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-paper-alt">
              <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: l.color }} />
              <span className="min-w-0 flex-1 truncate text-sm">{l.name}</span>
              <button type="button" className="text-xs font-semibold text-brand-blue" onClick={() => setEditing({ id: l.id, name: l.name, color: l.color })}>Edit</button>
              <button type="button" className="text-xs font-semibold text-red-700" onClick={() => window.confirm(`Delete label "${l.name}"? Messages keep their folders; only the label is removed.`) && run(() => mailApi.deleteLabel(l.id))}>Delete</button>
            </li>
          )
        )}
      </ul>
      <form
        className="mt-4 border-t border-ink/10 pt-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          void run(async () => {
            await mailApi.createLabel({ accountId, name: name.trim(), color });
            setName("");
          });
        }}
      >
        <p className="text-xs font-semibold text-ink/60">New label</p>
        <div className="mt-2 flex gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="Label name" aria-label="New label name" className="min-w-0 flex-1 rounded-lg border border-ink/15 px-2 py-1.5 text-sm" />
          <button type="submit" className="shrink-0 rounded-full bg-brand-blue px-4 py-1.5 text-sm font-semibold text-white">Add</button>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Label color">
          {PALETTE.map((c) => (
            <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={c} onClick={() => setColor(c)} className={`h-6 w-6 rounded-full ${color === c ? "ring-2 ring-offset-2 ring-ink/50" : ""}`} style={{ backgroundColor: c }} />
          ))}
        </div>
      </form>
      {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
    </Modal>
  );
}
