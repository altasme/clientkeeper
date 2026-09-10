import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchClients, createBill, type ClientListRow, type ClientType } from "../lib/api";

const inputClass = "w-full rounded-lg border border-ink/15 px-3 py-2 text-sm outline-none focus:border-brand-blue";
// Same look as inputClass but WITHOUT w-full — inputClass's baked-in
// w-full fights with flex-1/w-32 when two inputs share a flex row (both
// set `width` directly, so whichever wins the cascade squashes the
// other's intended sizing). Used for the description/amount pair below.
const rowInputClass = "rounded-lg border border-ink/15 px-3 py-2 text-sm outline-none focus:border-brand-blue";
const labelClass = "block text-xs font-semibold uppercase tracking-wide text-ink/50";

// Mirrors clienthub's BillPage.tsx — reproduced verbatim, not guessed at,
// since it's a tax id (see that file's own note on the double dash).
const ALTAVENTURES_TIN = "717-659--00000";

interface LineItemRow {
  description: string;
  amount: string;
}

const MONEY_FORMATTER = new Intl.NumberFormat("en-US");
const DATE_FORMATTER = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });

function formatMoney(amount: number): string {
  return `₱${MONEY_FORMATTER.format(amount)}`;
}

interface PreviewLineItem {
  description: string;
  amount: number;
}

// A live preview of the public /bill/:token page, rendered from the
// form's current in-progress state — no bill exists yet at this point
// (that only happens on submit), so the bill number and link are shown
// as placeholders rather than real values.
function BillPreview({
  clientType,
  recipientName,
  recipientContactPerson,
  recipientTin,
  scopeDescription,
  lineItems,
  total,
  validityDays,
  notes,
}: {
  clientType: ClientType;
  recipientName: string;
  recipientContactPerson: string;
  recipientTin: string;
  scopeDescription: string;
  lineItems: PreviewLineItem[];
  total: number;
  validityDays: string;
  notes: string;
}) {
  const today = new Date();
  const days = Number(validityDays) || 7;
  const expires = new Date(today.getTime() + days * 24 * 60 * 60 * 1000);

  return (
    <div className="rounded-2xl border border-ink/10 bg-white p-6 shadow-sm">
      <div className="mb-4 flex justify-center">
        <img src="/images/brand/altaventures-logo.png" alt="Altaventures" width={838} height={105} className="h-5 w-auto" />
      </div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-extrabold text-brand-navy">Bill of Service</h2>
          <p className="mt-1 text-xs text-ink/50">
            No: <span className="font-semibold text-ink/70">(assigned on save)</span> | Date: <span className="font-semibold text-ink/70">{DATE_FORMATTER.format(today)}</span>
          </p>
          <p className="text-xs text-ink/50">Terms: Valid until {DATE_FORMATTER.format(expires)}</p>
        </div>
        <span className="rounded-full bg-amber-100 px-3 py-1 text-[10px] font-bold uppercase tracking-wide text-amber-700">Preview</span>
      </div>

      <div className="mt-5 grid gap-3 border-y border-ink/10 py-4 text-xs sm:grid-cols-2">
        <div>
          <p className="font-semibold uppercase tracking-wide text-ink/40">From</p>
          <p className="mt-1 font-semibold text-brand-navy">Altaventures</p>
          <p className="text-ink/50">TIN: {ALTAVENTURES_TIN}</p>
        </div>
        <div>
          <p className="font-semibold uppercase tracking-wide text-ink/40">To</p>
          <p className="mt-1 font-semibold text-brand-navy">{recipientName.trim() || "—"}</p>
          {clientType === "corporate" && recipientContactPerson.trim() && <p className="text-ink/50">Attn: {recipientContactPerson}</p>}
          {clientType === "corporate" && recipientTin.trim() && <p className="text-ink/50">TIN: {recipientTin}</p>}
        </div>
      </div>

      <div className="mt-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink/40">Service Scope and Description</p>
        {scopeDescription.trim() && <p className="mt-2 text-xs text-ink/70">{scopeDescription}</p>}

        {lineItems.length > 0 ? (
          <div className="mt-3 divide-y divide-ink/10">
            {lineItems.map((item, i) => (
              <div key={i} className="flex items-center justify-between py-2 text-xs">
                <p className="text-ink/80">{item.description}</p>
                <p className="font-semibold text-brand-navy">{formatMoney(item.amount)}</p>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-3 text-xs text-ink/40">Add a line item to see it here.</p>
        )}

        <div className="mt-2 flex items-center justify-between border-t-2 border-brand-navy pt-2">
          <p className="text-xs font-bold text-brand-navy">Total Amount Payable</p>
          <p className="text-lg font-extrabold text-brand-navy">{formatMoney(total)}</p>
        </div>
      </div>

      {notes.trim() && (
        <div className="mt-4 rounded-lg bg-paper-alt p-3">
          <p className="text-xs text-ink/60">{notes}</p>
        </div>
      )}

      <div className="mt-6">
        <div className="inline-flex w-full items-center justify-center rounded-full bg-brand-blue/40 px-6 py-3 text-sm font-semibold text-white">Make a Payment Now &rarr;</div>
        <p className="mt-2 text-center text-[11px] text-ink/40">The real, shareable link appears here once you save this bill.</p>
      </div>
    </div>
  );
}

export default function NewBillPage() {
  const navigate = useNavigate();

  const [clientQuery, setClientQuery] = useState("");
  const [clientResults, setClientResults] = useState<ClientListRow[]>([]);
  const [selectedClient, setSelectedClient] = useState<ClientListRow | null>(null);
  const [showClientResults, setShowClientResults] = useState(false);

  const [clientType, setClientType] = useState<ClientType>("individual");
  const [recipientName, setRecipientName] = useState("");
  const [recipientContactPerson, setRecipientContactPerson] = useState("");
  const [recipientTin, setRecipientTin] = useState("");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [scopeDescription, setScopeDescription] = useState("");
  const [notes, setNotes] = useState("");
  const [validityDays, setValidityDays] = useState("7");
  const [lineItems, setLineItems] = useState<LineItemRow[]>([{ description: "", amount: "" }]);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!clientQuery.trim()) {
      setClientResults([]);
      return;
    }
    const handle = setTimeout(() => {
      fetchClients({ q: clientQuery })
        .then(setClientResults)
        .catch(() => setClientResults([]));
    }, 250);
    return () => clearTimeout(handle);
  }, [clientQuery]);

  const handleSelectClient = (client: ClientListRow) => {
    setSelectedClient(client);
    setRecipientName(client.fullName);
    setRecipientEmail(client.email);
    setClientQuery(`${client.fullName} — ${client.businessName}`);
    setShowClientResults(false);
  };

  const clearSelectedClient = () => {
    setSelectedClient(null);
    setClientQuery("");
    setRecipientName("");
    setRecipientEmail("");
  };

  const updateLineItem = (index: number, field: keyof LineItemRow, value: string) => {
    setLineItems((items) => items.map((item, i) => (i === index ? { ...item, [field]: value } : item)));
  };

  const addLineItem = () => setLineItems((items) => [...items, { description: "", amount: "" }]);
  const removeLineItem = (index: number) => setLineItems((items) => items.filter((_, i) => i !== index));

  const validLineItems = lineItems
    .map((item) => ({ description: item.description.trim(), amount: Number(item.amount) }))
    .filter((item) => item.description && Number.isFinite(item.amount) && item.amount > 0);

  const total = validLineItems.reduce((sum, item) => sum + item.amount, 0);

  const GANAP_MINIMUM_AMOUNT_PHP = 200;
  const belowMinimum = validLineItems.length > 0 && total < GANAP_MINIMUM_AMOUNT_PHP;
  const canSubmit = recipientName.trim() && validLineItems.length > 0 && !belowMinimum;

  const handleSubmit = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const { id } = await createBill({
        clientId: selectedClient?.id,
        clientType,
        recipientName: recipientName.trim(),
        recipientContactPerson: clientType === "corporate" ? recipientContactPerson.trim() || undefined : undefined,
        recipientTin: clientType === "corporate" ? recipientTin.trim() || undefined : undefined,
        recipientEmail: recipientEmail.trim() || undefined,
        scopeDescription: scopeDescription.trim() || undefined,
        notes: notes.trim() || undefined,
        validityDays: Number(validityDays) || 7,
        lineItems: validLineItems,
      });
      navigate(`/billing/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <h1 className="text-2xl font-bold text-brand-navy">New Bill of Service</h1>
      <p className="mt-1 text-sm text-ink/60">This generates a unique payment link you can send to the client.</p>

      {error && <p className="mt-4 max-w-2xl rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-5 rounded-2xl border border-ink/10 bg-white p-6">
          <div className="relative">
            <label className={labelClass}>Link to an Existing Client (optional)</label>
            {selectedClient ? (
              <div className="mt-1 flex items-center justify-between rounded-lg border border-brand-blue/30 bg-brand-blue/5 px-3 py-2 text-sm">
                <span className="font-semibold text-brand-navy">
                  {selectedClient.fullName} — {selectedClient.businessName}
                </span>
                <button type="button" onClick={clearSelectedClient} className="text-xs font-semibold text-ink/50 hover:text-ink">
                  Clear
                </button>
              </div>
            ) : (
              <>
                <input
                  type="text"
                  value={clientQuery}
                  onChange={(e) => {
                    setClientQuery(e.target.value);
                    setShowClientResults(true);
                  }}
                  onFocus={() => setShowClientResults(true)}
                  placeholder="Search name, business, or email"
                  className={`mt-1 ${inputClass}`}
                />
                {showClientResults && clientResults.length > 0 && (
                  <div className="absolute z-10 mt-1 w-full rounded-lg border border-ink/10 bg-white shadow-lg">
                    {clientResults.map((client) => (
                      <button
                        key={client.id}
                        type="button"
                        onClick={() => handleSelectClient(client)}
                        className="block w-full px-3 py-2 text-left text-sm hover:bg-paper-alt"
                      >
                        <span className="font-semibold text-brand-navy">{client.fullName}</span> <span className="text-ink/50">— {client.businessName}</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
            <p className="mt-1 text-[11px] text-ink/40">Leave blank to bill someone who isn't a tracked client yet — enter their name below instead.</p>
          </div>

          <div>
            <label className={labelClass}>Client Type</label>
            <div className="mt-1 flex gap-2">
              {(["individual", "corporate"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setClientType(t)}
                  className={`rounded-full px-4 py-1.5 text-sm font-semibold capitalize transition ${
                    clientType === t ? "bg-brand-blue text-white" : "border border-ink/15 text-ink/60 hover:border-brand-blue hover:text-brand-blue"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className={labelClass}>{clientType === "corporate" ? "Company Name" : "Client Name"}</label>
            <input type="text" value={recipientName} onChange={(e) => setRecipientName(e.target.value)} className={`mt-1 ${inputClass}`} />
          </div>

          {clientType === "corporate" && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelClass}>Contact Person</label>
                <input type="text" value={recipientContactPerson} onChange={(e) => setRecipientContactPerson(e.target.value)} className={`mt-1 ${inputClass}`} />
              </div>
              <div>
                <label className={labelClass}>Client TIN (optional)</label>
                <input type="text" value={recipientTin} onChange={(e) => setRecipientTin(e.target.value)} className={`mt-1 ${inputClass}`} />
              </div>
            </div>
          )}

          <div>
            <label className={labelClass}>Recipient Email (optional)</label>
            <input type="email" value={recipientEmail} onChange={(e) => setRecipientEmail(e.target.value)} className={`mt-1 ${inputClass}`} />
            <p className="mt-1 text-[11px] text-ink/40">
              {selectedClient ? "Defaults to this client's account email. Change it to bill a different contact." : "Not required — the link works without one, but it's needed for ganap.net's receipt if you have it."}
            </p>
          </div>

          <div>
            <label className={labelClass}>Service Scope and Description (optional)</label>
            <textarea value={scopeDescription} onChange={(e) => setScopeDescription(e.target.value)} rows={3} className={`mt-1 ${inputClass}`} />
          </div>

          <div>
            <label className={labelClass}>Line Items</label>
            <div className="mt-2 space-y-2">
              {lineItems.map((item, i) => (
                <div key={i} className="flex gap-2">
                  <input
                    type="text"
                    placeholder="Description"
                    value={item.description}
                    onChange={(e) => updateLineItem(i, "description", e.target.value)}
                    className={`min-w-0 flex-1 ${rowInputClass}`}
                  />
                  <input
                    type="number"
                    min="0"
                    step="1"
                    placeholder="Amount"
                    value={item.amount}
                    onChange={(e) => updateLineItem(i, "amount", e.target.value)}
                    className={`w-28 shrink-0 ${rowInputClass}`}
                  />
                  <button
                    type="button"
                    onClick={() => removeLineItem(i)}
                    disabled={lineItems.length === 1}
                    className="shrink-0 rounded-lg px-2 text-ink/40 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-30"
                    aria-label="Remove line item"
                  >
                    &times;
                  </button>
                </div>
              ))}
            </div>
            <button type="button" onClick={addLineItem} className="mt-2 text-xs font-semibold text-brand-blue hover:underline">
              + Add Line Item
            </button>
          </div>

          <div className="flex items-center justify-between border-t border-ink/10 pt-3">
            <p className="text-sm font-bold text-brand-navy">Total Amount Payable</p>
            <p className="text-lg font-extrabold text-brand-navy">{formatMoney(total)}</p>
          </div>
          {belowMinimum && (
            <p className="text-xs text-red-600">The total must be at least ₱{GANAP_MINIMUM_AMOUNT_PHP} (ganap.net's payment minimum).</p>
          )}

          <div>
            <label className={labelClass}>Expires After (days)</label>
            <input
              type="number"
              min="1"
              max="365"
              value={validityDays}
              onChange={(e) => setValidityDays(e.target.value)}
              className={`mt-1 w-32 ${rowInputClass}`}
            />
          </div>

          <div>
            <label className={labelClass}>Notes (optional)</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={`mt-1 ${inputClass}`} placeholder="Payment terms, instructions, etc." />
          </div>

          <div className="flex justify-end pt-2">
            <button
              type="button"
              disabled={!canSubmit || submitting}
              onClick={handleSubmit}
              className="rounded-full bg-brand-blue px-6 py-2.5 text-sm font-semibold text-white transition hover:bg-[#0b57cc] disabled:cursor-not-allowed disabled:bg-ink/10 disabled:text-ink/60"
            >
              {submitting ? "Creating..." : "Generate Bill of Service"}
            </button>
          </div>
        </div>

        <div className="lg:sticky lg:top-6 lg:self-start">
          <p className={`${labelClass} mb-2`}>Preview</p>
          <BillPreview
            clientType={clientType}
            recipientName={recipientName}
            recipientContactPerson={recipientContactPerson}
            recipientTin={recipientTin}
            scopeDescription={scopeDescription}
            lineItems={validLineItems}
            total={total}
            validityDays={validityDays}
            notes={notes}
          />
        </div>
      </div>
    </div>
  );
}
