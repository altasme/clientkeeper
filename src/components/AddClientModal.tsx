import { useState } from "react";
import { Link } from "react-router-dom";
import Modal from "./Modal";
import { createClient, ApiError, type Stage } from "../lib/api";
import { STAGE_LABELS, ALL_STAGES } from "../lib/stageLabels";

const inputClass = "w-full rounded-lg border border-ink/15 px-3 py-2 text-sm outline-none focus:border-brand-blue";
const labelClass = "block text-xs font-semibold uppercase tracking-wide text-ink/50";

export default function AddClientModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (clientId: string) => void;
}) {
  const [fullName, setFullName] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [email, setEmail] = useState("");
  const [mobile, setMobile] = useState("");
  const [facebook, setFacebook] = useState("");
  const [currentWebsite, setCurrentWebsite] = useState("");
  const [initialStage, setInitialStage] = useState<Stage>("payment_received");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicateClientId, setDuplicateClientId] = useState<string | null>(null);

  const reset = () => {
    setFullName("");
    setBusinessName("");
    setEmail("");
    setMobile("");
    setFacebook("");
    setCurrentWebsite("");
    setInitialStage("payment_received");
    setError(null);
    setDuplicateClientId(null);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleSubmit = async () => {
    setError(null);
    setDuplicateClientId(null);
    setSubmitting(true);
    try {
      const { id } = await createClient({
        fullName: fullName.trim(),
        businessName: businessName.trim(),
        email: email.trim(),
        mobile: mobile.trim() || undefined,
        facebook: facebook.trim() || undefined,
        currentWebsite: currentWebsite.trim() || undefined,
        initialStage,
      });
      reset();
      onCreated(id);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const clientId = err.body?.clientId;
        setDuplicateClientId(typeof clientId === "string" ? clientId : null);
      }
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const canSubmit = fullName.trim() && businessName.trim() && email.trim();

  return (
    <Modal open={open} onClose={handleClose} title="Add Client">
      <div className="space-y-3">
        {error && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
            {duplicateClientId && (
              <>
                {" "}
                <Link to={`/clients/${duplicateClientId}`} onClick={handleClose} className="font-semibold underline">
                  View existing client &rarr;
                </Link>
              </>
            )}
          </p>
        )}

        <div>
          <label className={labelClass}>Client Name</label>
          <input type="text" value={fullName} onChange={(e) => setFullName(e.target.value)} className={`mt-1 ${inputClass}`} />
        </div>

        <div>
          <label className={labelClass}>Business Name</label>
          <input type="text" value={businessName} onChange={(e) => setBusinessName(e.target.value)} className={`mt-1 ${inputClass}`} />
        </div>

        <div>
          <label className={labelClass}>Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={`mt-1 ${inputClass}`} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelClass}>Mobile</label>
            <input type="text" value={mobile} onChange={(e) => setMobile(e.target.value)} className={`mt-1 ${inputClass}`} />
          </div>
          <div>
            <label className={labelClass}>Facebook</label>
            <input type="text" value={facebook} onChange={(e) => setFacebook(e.target.value)} className={`mt-1 ${inputClass}`} />
          </div>
        </div>

        <div>
          <label className={labelClass}>Existing Website (if any)</label>
          <input type="text" value={currentWebsite} onChange={(e) => setCurrentWebsite(e.target.value)} className={`mt-1 ${inputClass}`} />
        </div>

        <div>
          <label className={labelClass}>Starting Stage</label>
          <select value={initialStage} onChange={(e) => setInitialStage(e.target.value as Stage)} className={`mt-1 ${inputClass}`}>
            {ALL_STAGES.map((s) => (
              <option key={s} value={s}>
                {STAGE_LABELS[s]}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[11px] text-ink/40">Defaults to Payment Received. Pick a later stage when backfilling a client who's already further along.</p>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={handleClose} className="rounded-full px-4 py-2 text-sm font-semibold text-ink/50 hover:text-ink">
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSubmit || submitting}
            onClick={handleSubmit}
            className="rounded-full bg-brand-blue px-5 py-2 text-sm font-semibold text-white transition hover:bg-[#0b57cc] disabled:cursor-not-allowed disabled:bg-ink/10 disabled:text-ink/60"
          >
            {submitting ? "Adding..." : "Add Client"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
