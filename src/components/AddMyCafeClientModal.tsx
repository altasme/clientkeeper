import { useState } from "react";
import { Link } from "react-router-dom";
import Modal from "./Modal";
import { createMyCafeClient, ApiError } from "../lib/api";

const inputClass = "w-full rounded-lg border border-ink/15 px-3 py-2 text-sm outline-none focus:border-brand-blue";
const labelClass = "block text-xs font-semibold uppercase tracking-wide text-ink/50";

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export default function AddMyCafeClientModal({
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
  const [storeName, setStoreName] = useState("");
  const [email, setEmail] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicateClientId, setDuplicateClientId] = useState<string | null>(null);

  const reset = () => {
    setFullName("");
    setBusinessName("");
    setStoreName("");
    setEmail("");
    setSlug("");
    setSlugTouched(false);
    setError(null);
    setDuplicateClientId(null);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleBusinessNameChange = (value: string) => {
    setBusinessName(value);
    if (!slugTouched) setSlug(slugify(value));
  };

  const handleSubmit = async () => {
    setError(null);
    setDuplicateClientId(null);
    setSubmitting(true);
    try {
      const { id } = await createMyCafeClient({
        fullName: fullName.trim(),
        businessName: businessName.trim(),
        storeName: storeName.trim(),
        email: email.trim(),
        slug: slug.trim(),
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

  const canSubmit = fullName.trim() && businessName.trim() && storeName.trim() && email.trim() && slug.trim();

  return (
    <Modal open={open} onClose={handleClose} title="Add MyCafe Client">
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
          <label className={labelClass}>Owner Name</label>
          <input type="text" value={fullName} onChange={(e) => setFullName(e.target.value)} className={`mt-1 ${inputClass}`} />
        </div>

        <div>
          <label className={labelClass}>Business Name</label>
          <input
            type="text"
            value={businessName}
            onChange={(e) => handleBusinessNameChange(e.target.value)}
            className={`mt-1 ${inputClass}`}
          />
        </div>

        <div>
          <label className={labelClass}>Store Name</label>
          <input
            type="text"
            value={storeName}
            onChange={(e) => setStoreName(e.target.value)}
            placeholder="e.g. Business Name - Branch"
            className={`mt-1 ${inputClass}`}
          />
        </div>

        <div>
          <label className={labelClass}>Owner Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={`mt-1 ${inputClass}`} />
          <p className="mt-1 text-[11px] text-ink/40">
            Must match exactly what the owner signs into WorkOS with, later, from the POS Settings screen.
          </p>
        </div>

        <div>
          <label className={labelClass}>Slug</label>
          <input
            type="text"
            value={slug}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(slugify(e.target.value));
            }}
            className={`mt-1 ${inputClass}`}
          />
          <p className="mt-1 text-[11px] text-ink/40">A unique, URL-safe id for this cafe. Auto-filled from the business name.</p>
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
