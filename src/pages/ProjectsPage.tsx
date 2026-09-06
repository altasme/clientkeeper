import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchProjects, type ProjectListRow } from "../lib/api";
import { STAGE_LABELS, ALL_STAGES } from "../lib/stageLabels";

export default function ProjectsPage() {
  const [projects, setProjects] = useState<ProjectListRow[]>([]);
  const [stage, setStage] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetchProjects(stage || undefined)
      .then(setProjects)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [stage]);

  return (
    <div>
      <h1 className="text-2xl font-bold text-brand-navy">Projects</h1>
      <div className="mt-4">
        <select value={stage} onChange={(e) => setStage(e.target.value)} className="rounded-lg border border-ink/15 px-3 py-2 text-sm">
          <option value="">All stages</option>
          {ALL_STAGES.map((s) => (
            <option key={s} value={s}>
              {STAGE_LABELS[s]}
            </option>
          ))}
        </select>
      </div>

      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      <div className="mt-4 overflow-x-auto rounded-xl border border-ink/10 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-ink/10 text-xs uppercase tracking-wide text-ink/40">
            <tr>
              <th className="px-4 py-3">Client</th>
              <th className="px-4 py-3">Business</th>
              <th className="px-4 py-3">Stage</th>
              <th className="px-4 py-3">Website</th>
              <th className="px-4 py-3">Updated</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => (
              <tr key={p.id} className="border-b border-ink/5 last:border-0 hover:bg-paper-alt">
                <td className="px-4 py-3">
                  <Link to={`/clients/${p.clientId}`} className="font-semibold text-brand-blue hover:underline">
                    {p.clientFullName}
                  </Link>
                </td>
                <td className="px-4 py-3 text-ink/70">{p.businessName}</td>
                <td className="px-4 py-3 text-ink/70">{STAGE_LABELS[p.stage]}</td>
                <td className="px-4 py-3 text-ink/50">
                  {p.websiteUrl ? (
                    <a href={p.websiteUrl} target="_blank" rel="noreferrer" className="text-brand-blue hover:underline">
                      View
                    </a>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-4 py-3 text-ink/50">{new Date(p.updatedAt).toLocaleDateString()}</td>
              </tr>
            ))}
            {!loading && projects.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-ink/40">
                  No projects match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
