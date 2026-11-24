// Safe preview: images, PDF and plain text only (the server refuses any
// other type with 415). The preview URL is the authenticated, same-origin
// route -- there is no public link to a mail attachment anywhere.

import { useEffect, useState } from "react";
import { mailApi, type AttachmentInfo } from "../../lib/mailApi";
import { formatBytes } from "../../lib/mailUtils";

export const PREVIEWABLE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain", "text/csv"]);

export default function MailAttachmentPreview({ attachment, onClose }: { attachment: AttachmentInfo; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const url = mailApi.previewUrl(attachment.id);
  const type = attachment.mimeType;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (!type.startsWith("text/")) return;
    fetch(url, { credentials: "same-origin" })
      .then(async (r) => (r.ok ? setText((await r.text()).slice(0, 500_000)) : setError("Couldn't load the preview.")))
      .catch(() => setError("Couldn't load the preview."));
  }, [type, url]);

  return (
    <div role="dialog" aria-modal="true" aria-label={`Preview ${attachment.filename}`} className="fixed inset-0 z-[80] flex flex-col bg-black/80" onClick={onClose}>
      <div className="flex items-center gap-3 px-4 py-3 text-white" onClick={(e) => e.stopPropagation()}>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{attachment.filename}</span>
        <span className="shrink-0 text-xs text-white/70">{formatBytes(attachment.size)}</span>
        <a href={mailApi.downloadUrl(attachment.id)} className="shrink-0 rounded-full bg-white/15 px-3 py-1.5 text-xs font-semibold hover:bg-white/25">
          Download
        </a>
        <button type="button" onClick={onClose} aria-label="Close preview" className="shrink-0 text-2xl leading-none text-white/80 hover:text-white" autoFocus>
          &times;
        </button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4" onClick={(e) => e.stopPropagation()}>
        {error ? (
          <p className="text-sm text-white">{error}</p>
        ) : type.startsWith("image/") ? (
          <img src={url} alt={attachment.filename} className="max-h-full max-w-full object-contain" />
        ) : type === "application/pdf" ? (
          <iframe src={url} title={attachment.filename} className="h-full w-full max-w-5xl rounded bg-white" />
        ) : (
          <pre className="max-h-full w-full max-w-4xl overflow-auto whitespace-pre-wrap break-words rounded bg-white p-4 text-xs text-ink">{text ?? "Loading…"}</pre>
        )}
      </div>
    </div>
  );
}
