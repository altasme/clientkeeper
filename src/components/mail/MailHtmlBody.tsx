// Renders an email body that the SERVER has already sanitized
// (@altasme/webmail-kit's sanitize.ts) inside a second isolation layer:
//  - <iframe sandbox> WITHOUT allow-scripts: nothing in the email can ever
//    execute, even if the sanitizer missed something.
//  - allow-same-origin is granted only so (a) cookie-authenticated cid:
//    inline images load from /api/app/mail/attachments/:id/preview and (b)
//    this component can measure the content height. Without allow-scripts
//    that combination is safe -- the dangerous pairing is scripts + same-origin.
//  - allow-popups(-to-escape-sandbox): links (forced to target=_blank by
//    the sanitizer) open in a normal new tab.
//  - A CSP <meta> inside the document: script-src none, images only from
//    self/data (plus http/https when remote images were explicitly allowed).
// Plain-text-only emails are rendered as escaped React text, no iframe.

import { useEffect, useRef, useState } from "react";

const BASE_CSS = `body{margin:0;padding:4px 2px;font:14px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif;color:#0A0F1C;overflow-wrap:break-word;word-break:break-word}
img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap}blockquote{margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex;color:#555}a{color:#0D68EF}`;

export default function MailHtmlBody({ html, text, remoteAllowed }: { html: string; text: string; remoteAllowed: boolean }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(120);

  useEffect(() => {
    const frame = ref.current;
    if (!frame || !html) return;
    let observer: ResizeObserver | null = null;
    const measure = () => {
      const doc = frame.contentDocument;
      if (doc?.documentElement) setHeight(Math.max(40, Math.min(doc.documentElement.scrollHeight + 8, 20000)));
    };
    const onLoad = () => {
      measure();
      const doc = frame.contentDocument;
      if (doc?.body && "ResizeObserver" in window) {
        observer = new ResizeObserver(measure);
        observer.observe(doc.body);
      }
      doc?.querySelectorAll("img").forEach((img) => img.addEventListener("load", measure));
    };
    frame.addEventListener("load", onLoad);
    return () => {
      frame.removeEventListener("load", onLoad);
      observer?.disconnect();
    };
  }, [html]);

  if (!html) {
    return <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-ink/90">{text || "(no content)"}</pre>;
  }

  const imgSrc = remoteAllowed ? "'self' data: https: http:" : "'self' data:";
  const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; img-src ${imgSrc}; style-src 'unsafe-inline'; font-src data:; form-action 'none'"><base target="_blank"><style>${BASE_CSS}</style></head><body>${html}</body></html>`;

  return (
    <iframe
      ref={ref}
      title="Email content"
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      style={{ height }}
      className="block w-full border-0"
    />
  );
}
