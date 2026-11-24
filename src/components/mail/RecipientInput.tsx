// Recipient chips: Enter / comma / semicolon / Tab / blur commit the typed
// text, pasting a list splits it, Backspace on an empty input removes the
// last chip. Invalid addresses stay visible as red chips (never silently
// dropped) and block Send until fixed.

import { useState, type KeyboardEvent } from "react";
import type { Addr } from "../../lib/mailApi";
import { isValidEmail, parseRecipients } from "../../lib/mailUtils";

export default function RecipientInput({ label, value, onChange, autoFocus }: { label: string; value: Addr[]; onChange: (v: Addr[]) => void; autoFocus?: boolean }) {
  const [text, setText] = useState("");

  const commit = (raw: string) => {
    const parsed = parseRecipients(raw);
    if (!parsed.length) return;
    const existing = new Set(value.map((v) => v.email.toLowerCase()));
    const next = [...value];
    for (const p of parsed) {
      if (existing.has(p.email.toLowerCase())) continue;
      existing.add(p.email.toLowerCase());
      next.push({ name: p.name, email: p.email });
    }
    onChange(next);
    setText("");
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === "Enter" || e.key === "," || e.key === ";" || e.key === "Tab") && text.trim()) {
      e.preventDefault();
      commit(text);
    } else if (e.key === "Backspace" && !text && value.length) {
      onChange(value.slice(0, -1));
    }
  };

  return (
    <div className="flex min-w-0 items-start gap-2 border-b border-ink/10 px-3 py-1.5">
      <span className="w-10 shrink-0 pt-1.5 text-xs font-semibold text-ink/60">{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        {value.map((r) => {
          const valid = isValidEmail(r.email);
          return (
            <span
              key={r.email}
              title={valid ? r.email : `"${r.email}" is not a valid email address`}
              className={`inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-xs ${valid ? "bg-brand-blue/10 text-brand-navy" : "bg-red-100 text-red-700 ring-1 ring-red-300"}`}
            >
              <span className="truncate">{r.name ? `${r.name} <${r.email}>` : r.email}</span>
              <button type="button" aria-label={`Remove ${r.email}`} onClick={() => onChange(value.filter((x) => x.email !== r.email))} className="text-ink/50 hover:text-ink">
                &times;
              </button>
            </span>
          );
        })}
        <input
          type="email"
          multiple
          autoFocus={autoFocus}
          aria-label={`${label} recipients`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          onBlur={() => text.trim() && commit(text)}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData("text");
            if (/[,;\n]/.test(pasted)) {
              e.preventDefault();
              commit(text + pasted);
            }
          }}
          className="min-w-[8rem] flex-1 bg-transparent py-1 text-sm focus:outline-none"
        />
      </div>
    </div>
  );
}
