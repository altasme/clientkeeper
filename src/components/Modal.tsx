import { useEffect, useRef, type ReactNode } from "react";

export default function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // onClose is read through a ref, not put in the effect's dependency
  // array, on purpose. AddClientModal (the one caller today) passes an
  // inline onClose, and its own state changes on every keystroke while
  // typing into any field, so a new onClose reference gets created on
  // every render. If the effect depended on [open, onClose], it would
  // re-run on every keystroke too and re-focus the close button each
  // time, yanking focus out of whatever field the user just typed into
  // (this is exactly what "click a field, then it glitches" looks like).
  // Keying the effect on [open] alone means it only runs once when the
  // dialog actually opens or closes, while the ref keeps the Escape
  // handler calling whatever onClose is current.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    closeButtonRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
      onClick={onClose}
    >
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <h2 id="modal-title" className="text-lg font-bold text-brand-navy">
            {title}
          </h2>
          <button ref={closeButtonRef} type="button" onClick={onClose} aria-label="Close" className="text-ink/40 hover:text-ink">
            &times;
          </button>
        </div>
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}
