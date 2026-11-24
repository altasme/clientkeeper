import type { Counts, FolderId, Identity, Label } from "../../lib/mailApi";

export const FOLDERS: { id: FolderId; label: string; icon: string }[] = [
  { id: "inbox", label: "Inbox", icon: "📥" },
  { id: "starred", label: "Starred", icon: "★" },
  { id: "sent", label: "Sent", icon: "📤" },
  { id: "drafts", label: "Drafts", icon: "📝" },
  { id: "archive", label: "Archive", icon: "🗄" },
  { id: "junk", label: "Junk", icon: "⚠" },
  { id: "trash", label: "Trash", icon: "🗑" },
];

interface Props {
  identities: Identity[];
  accountId: string;
  folder: string;
  labelId: string | null;
  labels: Label[];
  counts: Counts | null;
  canCompose: boolean;
  onAccount: (id: string) => void;
  onFolder: (f: FolderId) => void;
  onLabel: (id: string) => void;
  onCompose: () => void;
  onManageLabels: () => void;
  onSettings: () => void;
}

function sumFolder(counts: Counts | null, accountIds: string[], folder: string, key: "total" | "unread") {
  if (!counts) return 0;
  return accountIds.reduce((s, id) => s + (counts.accounts[id]?.[folder]?.[key] ?? 0), 0);
}

export default function MailSidebar(p: Props) {
  const scopeIds = p.accountId === "all" ? p.identities.map((i) => i.id) : [p.accountId];
  const item = (active: boolean) => `flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm ${active ? "bg-brand-blue text-white" : "text-ink/75 hover:bg-paper-alt"}`;
  const failed = sumFolder(p.counts, scopeIds, "failed", "total");

  return (
    <nav aria-label="Mail folders" className="flex h-full flex-col gap-3 overflow-y-auto p-3">
      <button type="button" onClick={p.onCompose} disabled={!p.canCompose} title={p.canCompose ? undefined : "You don't have send access to any mailbox"} className="rounded-full bg-brand-blue px-4 py-3 text-sm font-semibold text-white shadow hover:bg-[#0b57cc] disabled:opacity-50">
        ✎ Compose
      </button>

      {p.identities.length > 1 && (
        <label className="block">
          <span className="sr-only">Mailbox</span>
          <select value={p.accountId} onChange={(e) => p.onAccount(e.target.value)} className="w-full rounded-lg border border-ink/15 bg-white px-2 py-2 text-sm">
            <option value="all">All mailboxes (unified)</option>
            {p.identities.map((i) => (
              <option key={i.id} value={i.id}>
                {i.emailAddress}
                {p.counts?.accounts[i.id]?.inbox?.unread ? ` (${p.counts.accounts[i.id]!.inbox!.unread})` : ""}
              </option>
            ))}
          </select>
        </label>
      )}
      {p.identities.length === 1 && <p className="truncate px-1 text-xs font-semibold text-ink/60">{p.identities[0]!.emailAddress}</p>}

      <ul className="space-y-0.5">
        {FOLDERS.map((f) => {
          const active = !p.labelId && p.folder === f.id;
          const unread = f.id === "sent" || f.id === "trash" || f.id === "drafts" ? 0 : sumFolder(p.counts, scopeIds, f.id, "unread");
          const total = f.id === "drafts" ? sumFolder(p.counts, scopeIds, "drafts", "total") : 0;
          return (
            <li key={f.id}>
              <button type="button" onClick={() => p.onFolder(f.id)} className={item(active)} aria-current={active ? "page" : undefined}>
                <span className="w-5 text-center" aria-hidden="true">{f.icon}</span>
                <span className="flex-1">{f.label}</span>
                {f.id === "sent" && failed > 0 && <span className={`rounded-full px-1.5 text-[11px] font-bold ${active ? "bg-white/25" : "bg-red-100 text-red-700"}`} title="Failed sends">{failed}!</span>}
                {unread > 0 && <span className={`text-xs font-bold ${active ? "text-white" : "text-brand-navy"}`}>{unread}</span>}
                {total > 0 && <span className={`text-xs ${active ? "text-white/80" : "text-ink/60"}`}>{total}</span>}
              </button>
            </li>
          );
        })}
      </ul>

      <div>
        <div className="flex items-center justify-between px-3 pb-1 pt-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink/60">Labels</span>
          <button type="button" onClick={p.onManageLabels} className="text-xs font-semibold text-brand-blue hover:underline">Manage</button>
        </div>
        {p.labels.length === 0 && <p className="px-3 text-xs text-ink/60">No labels yet.</p>}
        <ul className="space-y-0.5">
          {p.labels.map((l) => {
            const active = p.labelId === l.id;
            const unread = p.counts?.labels[l.id]?.unread ?? 0;
            return (
              <li key={l.id}>
                <button type="button" onClick={() => p.onLabel(l.id)} className={item(active)} aria-current={active ? "page" : undefined}>
                  <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: l.color }} />
                  <span className="min-w-0 flex-1 truncate">{l.name}</span>
                  {unread > 0 && <span className="text-xs font-bold">{unread}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <button type="button" onClick={p.onSettings} className="mt-auto rounded-lg px-3 py-2 text-left text-sm text-ink/70 hover:bg-paper-alt">⚙ Mail settings</button>
    </nav>
  );
}
