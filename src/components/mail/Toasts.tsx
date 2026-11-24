import { useCallback, useState } from "react";

export interface Toast {
  id: number;
  text: string;
  tone: "info" | "error" | "success";
  action?: { label: string; run: () => void };
}

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (text: string, tone: Toast["tone"] = "info", action?: Toast["action"]) => {
      const id = Date.now() + Math.random();
      setToasts((t) => [...t.slice(-3), { id, text, tone, action }]);
      setTimeout(() => dismiss(id), tone === "error" ? 9000 : 5000);
    },
    [dismiss]
  );
  return { toasts, push, dismiss };
}

export function ToastStack({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number) => void }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[70] flex flex-col items-center gap-2 px-4" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.tone === "error" ? "alert" : "status"}
          className={`pointer-events-auto flex max-w-md items-center gap-3 rounded-xl px-4 py-2.5 text-sm shadow-lg ${
            t.tone === "error" ? "bg-red-700 text-white" : t.tone === "success" ? "bg-emerald-700 text-white" : "bg-brand-navy-deep text-white"
          }`}
        >
          <span className="min-w-0 break-words">{t.text}</span>
          {t.action && (
            <button
              type="button"
              onClick={() => {
                t.action!.run();
                dismiss(t.id);
              }}
              className="shrink-0 font-semibold underline"
            >
              {t.action.label}
            </button>
          )}
          <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)} className="shrink-0 text-white/70 hover:text-white">
            &times;
          </button>
        </div>
      ))}
    </div>
  );
}
