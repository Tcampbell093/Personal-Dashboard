import type { ExperienceRecommendation } from "@/lib/types";

function money(n: number): string {
  return `$${n.toLocaleString("en-US")}`;
}
function costRange(min: number | null, max: number | null): string {
  if (min == null && max == null) return "Cost varies";
  if (min != null && max != null) return min === max ? money(min) : `${money(min)}–${money(max)}`;
  return money((min ?? max) as number);
}
function duration(m: number | null): string | null {
  if (m == null) return null;
  if (m >= 90) return `~${Math.round((m / 60) * 10) / 10} hr`;
  return `~${m} min`;
}

/* A single recommendation concept. Presentational only — no selection control in
 * Build 2B.1. Styled to the Experiences (cyan→violet) identity; the AI result is
 * framed as a suggestion, with an explicit verification note. */
export function RecommendationCard({ rec }: { rec: ExperienceRecommendation }) {
  const dur = duration(rec.estimatedDurationMinutes);
  return (
    <div className="exp-rec-card">
      <div className="exp-rec-title">{rec.title}</div>
      <div className="exp-rec-desc">{rec.description}</div>

      <div className="exp-rec-why">
        <span className="exp-rec-why-label">Why it fits</span>
        {rec.whyItFits}
      </div>

      <div className="exp-rec-meta num">
        <span className="exp-rec-chip">{costRange(rec.estimatedCostMin, rec.estimatedCostMax)}</span>
        {dur && <span className="exp-rec-chip">{dur}</span>}
        {rec.physicalDifficulty && <span className="exp-rec-chip">{rec.physicalDifficulty}</span>}
        {rec.locationText && <span className="exp-rec-chip">{rec.locationText}</span>}
      </div>

      {rec.travelAssumption && (
        <div className="exp-rec-sub">Travel: {rec.travelAssumption}</div>
      )}

      {rec.assumptions.length > 0 && (
        <ul className="exp-rec-assumptions">
          {rec.assumptions.map((a, i) => (
            <li key={i}>{a}</li>
          ))}
        </ul>
      )}

      {rec.preparationNotes.length > 0 && (
        <div className="exp-rec-sub">
          Prep: {rec.preparationNotes.join("; ")}
        </div>
      )}

      <div className="exp-rec-verify">
        Concept based on your request. Confirm current hours, pricing, availability, and travel
        details before going.
      </div>
    </div>
  );
}
