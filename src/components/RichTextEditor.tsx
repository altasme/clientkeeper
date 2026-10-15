// A small, dependency-free rich text editor for the proposal generator
// (CLAUDEproposalquestionnaire.md's "free-text rich-text editor...
// headings, paragraphs, bold/italic, lists, links, tables where
// practical"). Deliberately NOT a heavy editor framework (Tiptap/Slate/
// Quill) -- this app has no rich-text dependency anywhere today, and a
// plain contentEditable + document.execCommand toolbar covers every
// explicitly-requested formatting need for an internal single-operator
// tool at a fraction of the bundle/complexity cost. execCommand is a
// deprecated API but still broadly supported for these exact basic
// commands across current browsers; if it ever needs replacing, this is
// the one component that would change.
import { useEffect, useRef } from "react";

interface Props {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
}

function exec(command: string, value?: string) {
  document.execCommand(command, false, value);
}

const BUTTONS: Array<{ label: string; title: string; run: () => void }> = [
  { label: "B", title: "Bold", run: () => exec("bold") },
  { label: "I", title: "Italic", run: () => exec("italic") },
  { label: "U", title: "Underline", run: () => exec("underline") },
  { label: "H2", title: "Heading", run: () => exec("formatBlock", "<h2>") },
  { label: "H3", title: "Subheading", run: () => exec("formatBlock", "<h3>") },
  { label: "¶", title: "Paragraph", run: () => exec("formatBlock", "<p>") },
  { label: "• List", title: "Bulleted list", run: () => exec("insertUnorderedList") },
  { label: "1. List", title: "Numbered list", run: () => exec("insertOrderedList") },
];

export default function RichTextEditor({ value, onChange, placeholder }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  // Starts as `null`, never `value` -- the contentEditable div's actual DOM
  // content always starts empty on mount regardless of what `value` already
  // is (there's no defaultValue/dangerouslySetInnerHTML equivalent here), so
  // the first sync must always run once to populate it. Initializing this to
  // `value` instead caused a real bug: when the parent already had the
  // content loaded before this component first mounted (e.g. editing an
  // existing proposal), `value` on mount equaled this ref's initial value,
  // so the "only push `value` in when it changes from outside" guard below
  // skipped its first run entirely and the editor rendered permanently
  // blank even though `value` itself was correct the whole time.
  const lastValue = useRef<string | null>(null);

  // Only push `value` into the DOM when it changes from OUTSIDE this
  // component (e.g. loading a different proposal, or the initial mount
  // above) -- never on every keystroke, which would fight the browser's
  // own cursor position.
  useEffect(() => {
    if (ref.current && value !== lastValue.current) {
      ref.current.innerHTML = value;
      lastValue.current = value;
    }
  }, [value]);

  const handleInput = () => {
    if (!ref.current) return;
    lastValue.current = ref.current.innerHTML;
    onChange(ref.current.innerHTML);
  };

  const handleLink = () => {
    const url = window.prompt("Link URL:");
    if (url) exec("createLink", url);
    handleInput();
  };

  const handleTable = () => {
    const rows = Number(window.prompt("Number of rows:", "2")) || 2;
    const cols = Number(window.prompt("Number of columns:", "2")) || 2;
    const cell = `<td style="border:1px solid #ccc;padding:6px;">&nbsp;</td>`;
    const row = `<tr>${cell.repeat(cols)}</tr>`;
    const table = `<table style="border-collapse:collapse;width:100%;">${row.repeat(rows)}</table><p></p>`;
    exec("insertHTML", table);
    handleInput();
  };

  return (
    <div className="rounded-lg border border-ink/15 bg-white">
      <div className="flex flex-wrap items-center gap-1 border-b border-ink/10 p-2">
        {BUTTONS.map((btn) => (
          <button
            key={btn.label}
            type="button"
            title={btn.title}
            onMouseDown={(e) => e.preventDefault()} // keep focus/selection in the editor
            onClick={() => {
              btn.run();
              handleInput();
            }}
            className="rounded px-2 py-1 text-xs font-semibold text-ink/70 hover:bg-ink/5"
          >
            {btn.label}
          </button>
        ))}
        <button type="button" title="Insert link" onMouseDown={(e) => e.preventDefault()} onClick={handleLink} className="rounded px-2 py-1 text-xs font-semibold text-ink/70 hover:bg-ink/5">
          Link
        </button>
        <button type="button" title="Insert table" onMouseDown={(e) => e.preventDefault()} onClick={handleTable} className="rounded px-2 py-1 text-xs font-semibold text-ink/70 hover:bg-ink/5">
          Table
        </button>
      </div>
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        onInput={handleInput}
        onBlur={handleInput}
        data-placeholder={placeholder}
        className="proposal-content min-h-[320px] p-4 text-sm text-ink/90 focus:outline-none empty:before:text-ink/30 empty:before:content-[attr(data-placeholder)]"
      />
    </div>
  );
}
