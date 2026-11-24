// Server-side sanitizer for UNTRUSTED inbound email HTML, built on the
// Workers runtime's native HTMLRewriter (a streaming HTML parser that ships
// with Workers/Pages Functions) -- zero new dependencies, and a real
// parser rather than regexes, which is what makes it safe.
//
// Allowlist, not blocklist: only the formatting tags/attributes below
// survive. Dropped with their content: script/style-less executable
// containers (script, iframe, object, embed, form controls, svg, math,
// template, noscript, link/meta/base, title, media). Unknown tags (incl.
// html/head/body) are unwrapped
// (their text is kept). Every on* handler, id/name, and any attribute not
// on the list is removed. Links keep only http/https/mailto/tel and are
// forced to open in a new tab with noopener/noreferrer. <style> blocks are
// kept for layout but stripped of @import, expression(), behavior,
// -moz-binding, javascript: and (unless remote content is allowed) url().
//
// Remote images (tracking pixels) are blocked by default: http(s) <img src>
// and background images are removed and counted, so the UI can offer
// "Load remote images" per the business-wide remoteImagePolicy. cid:
// inline images are rewritten to the authenticated attachment preview
// route. data:image (png/jpeg/gif/webp only) is allowed.
//
// This is layer one. Layer two is in the browser: the result is rendered
// inside <iframe sandbox="allow-same-origin allow-popups ..."> WITHOUT
// allow-scripts, plus a CSP <meta> with script-src none
// (src/components/mail/MailHtmlBody.tsx) -- so even a sanitizer miss
// cannot execute script.

const ALLOWED_TAGS = new Set([
  "a", "abbr", "address", "article", "b", "big", "blockquote", "br", "caption", "center", "cite", "code", "col", "colgroup", "dd", "del",
  "div", "dl", "dt", "em", "figcaption", "figure", "font", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "i", "img", "ins",
  "kbd", "li", "main", "mark", "ol", "p", "pre", "q", "s", "section", "small", "span", "strike", "strong", "style", "sub", "sup", "table",
  "tbody", "td", "tfoot", "th", "thead", "tr", "tt", "u", "ul", "wbr",
]);

const DROP_WITH_CONTENT = new Set([
  "script", "iframe", "frame", "frameset", "object", "embed", "applet", "form", "input", "button", "select", "textarea", "option", "optgroup",
  "svg", "math", "noscript", "template", "link", "meta", "base", "audio", "video", "source", "track", "canvas", "title", "xml", "param", "dialog",
  "portal",
]);

const ALLOWED_ATTRS = new Set([
  "style", "class", "dir", "lang", "title", "align", "valign", "width", "height", "bgcolor", "color", "border", "cellpadding", "cellspacing",
  "colspan", "rowspan", "face", "size", "alt", "href", "src", "background", "start", "type", "span", "nowrap",
]);

export interface SanitizeOptions {
  allowRemoteImages: boolean;
  /** content-id (no angle brackets, lowercased) -> URL to use for cid: images */
  cidMap: Map<string, string>;
}

export interface SanitizeResult {
  html: string;
  remoteImagesBlocked: number;
}

const SAFE_DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i;

function sanitizeUrlForLink(href: string): string | null {
  // eslint-disable-next-line no-control-regex
  const v = href.trim().replace(/[\u0000-\u001f\u007f\s]+/g, "");
  if (/^(https?:|mailto:|tel:)/i.test(v)) return href.trim();
  if (v.startsWith("#")) return null; // in-document anchors are useless inside the iframe
  return null;
}

export function sanitizeCss(css: string, allowRemote: boolean): { css: string; blocked: number } {
  let blocked = 0;
  let out = css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/@import[^;]*;?/gi, "")
    .replace(/expression\s*\(/gi, "x(")
    .replace(/javascript\s*:/gi, "")
    .replace(/vbscript\s*:/gi, "")
    .replace(/behavior\s*:/gi, "x:")
    .replace(/-moz-binding\s*:/gi, "x:")
    .replace(/position\s*:\s*fixed/gi, "position:static");
  out = out.replace(/url\s*\(\s*(['"]?)(.*?)\1\s*\)/gi, (_m, _q, url: string) => {
    const u = url.trim();
    if (SAFE_DATA_IMAGE.test(u)) return `url("${u}")`;
    if (allowRemote && /^https?:/i.test(u)) return `url("${u.replace(/["\\]/g, "")}")`;
    if (/^https?:/i.test(u)) blocked++;
    return "none";
  });
  return { css: out, blocked };
}

export async function sanitizeEmailHtml(html: string, opts: SanitizeOptions): Promise<SanitizeResult> {
  if (!html) return { html: "", remoteImagesBlocked: 0 };
  let blocked = 0;
  let styleBuffer = "";

  const rewriter = new HTMLRewriter()
    .onDocument({
      comments(c) {
        c.remove();
      },
    })
    .on("*", {
      element(el) {
        const tag = el.tagName.toLowerCase();
        if (DROP_WITH_CONTENT.has(tag)) {
          el.remove();
          return;
        }
        if (!ALLOWED_TAGS.has(tag)) {
          el.removeAndKeepContent();
          return;
        }
        const attrs = [...el.attributes];
        for (const [rawName, value] of attrs) {
          const name = rawName.toLowerCase();
          if (!ALLOWED_ATTRS.has(name)) {
            el.removeAttribute(rawName);
            continue;
          }
          if (name === "style") {
            const r = sanitizeCss(value, opts.allowRemoteImages);
            blocked += r.blocked;
            el.setAttribute("style", r.css);
          } else if (name === "href") {
            const safe = tag === "a" ? sanitizeUrlForLink(value) : null;
            if (safe) el.setAttribute("href", safe);
            else el.removeAttribute(rawName);
          } else if (name === "src" || name === "background") {
            if (tag !== "img" && name === "src") {
              el.removeAttribute(rawName);
              continue;
            }
            const v = value.trim();
            if (/^cid:/i.test(v)) {
              const url = opts.cidMap.get(v.slice(4).replace(/[<>]/g, "").toLowerCase());
              if (url) el.setAttribute(name, url);
              else el.removeAttribute(rawName);
            } else if (SAFE_DATA_IMAGE.test(v)) {
              // keep
            } else if (/^https?:/i.test(v)) {
              if (!opts.allowRemoteImages) {
                el.removeAttribute(rawName);
                if (name === "src") el.setAttribute("alt", "[remote image blocked]");
                blocked++;
              }
            } else {
              el.removeAttribute(rawName);
            }
          }
        }
        if (tag === "a") {
          el.setAttribute("target", "_blank");
          el.setAttribute("rel", "noopener noreferrer nofollow");
        }
        if (tag === "img") el.setAttribute("referrerpolicy", "no-referrer");
      },
    })
    .on("style", {
      text(t) {
        styleBuffer += t.text;
        if (t.lastInTextNode) {
          const r = sanitizeCss(styleBuffer, opts.allowRemoteImages);
          blocked += r.blocked;
          // Never let the CSS close its own <style> element early.
          t.replace(r.css.replace(/<\/?style/gi, ""), { html: true });
          styleBuffer = "";
        } else {
          t.remove();
        }
      },
    });

  const out = await rewriter.transform(new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })).text();
  return { html: out, remoteImagesBlocked: blocked };
}

/** For outbound composer HTML authored by staff: same sanitizer, remote images allowed (staff chose them). */
export async function sanitizeOutboundHtml(html: string): Promise<string> {
  const r = await sanitizeEmailHtml(html, { allowRemoteImages: true, cidMap: new Map() });
  return r.html;
}
