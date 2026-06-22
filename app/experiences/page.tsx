import { getCurrentUserId } from "@/lib/auth";
import {
  getHomeArea,
  listRequests,
  toRequestViews,
  interpretationSummary,
} from "@/lib/services/experience-requests";
import {
  listPlanned,
  listHistory,
  xpSummary,
  toExperienceViews,
} from "@/lib/services/experiences";
import { RequestForm } from "@/components/experiences/request-form";
import { InterpretationSummary } from "@/components/experiences/interpretation-summary";
import { ConstraintEditor } from "@/components/experiences/constraint-editor";
import { PlanForm } from "@/components/experiences/plan-form";
import { PlannedList } from "@/components/experiences/planned-list";
import { OutcomeForm } from "@/components/experiences/outcome-form";

// Always render fresh; this page never serves cached or mock personal data.
export const dynamic = "force-dynamic";

function money(n: number | null): string {
  return n == null ? "—" : n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}
function shortDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso + "T00:00:00").toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
const STATUS_LABEL: Record<string, string> = {
  completed: "Completed",
  cancelled: "Cancelled",
  not_completed: "Not completed",
};

function Header() {
  return (
    <header className="topbar">
      <span className="wordmark">
        Experiences<span className="dot">.</span>
      </span>
      <span className="topbar-right">
        <a className="navlink" href="/">
          ← Dashboard
        </a>
      </span>
    </header>
  );
}

export default async function ExperiencesPage() {
  const userId = await getCurrentUserId();

  let homeArea: string | null;
  let requests, planned, history, xp;
  try {
    [homeArea, requests, planned, history, xp] = await Promise.all([
      getHomeArea(userId),
      listRequests(userId).then(toRequestViews),
      listPlanned(userId).then(toExperienceViews),
      listHistory(userId).then(toExperienceViews),
      xpSummary(userId),
    ]);
  } catch (err) {
    // Explicit error state — never fabricate mock experiences (spec §12).
    console.error("ExperiencesPage: load failed.", err);
    return (
      <div className="shell">
        <Header />
        <div className="exp-error">
          <b>Experiences are currently unavailable.</b> The database could not be
          reached, so nothing can be shown. This page never displays mock or
          placeholder experiences. Please try again later.
        </div>
      </div>
    );
  }

  // Requests still being shaped into a plan (draft or AI-interpreted). Once a
  // plan exists the request is `planned` and lives under Planned experiences.
  const openRequests = requests.filter((r) => r.status !== "planned");

  // UI hint only — the server enforces the full enablement + cost gate at call
  // time. AI stays off unless deliberately configured (no key, no auto-enable).
  const aiAvailable =
    !!process.env.ANTHROPIC_API_KEY && process.env.AI_AUTOMATION_ENABLED === "true";

  return (
    <div className="shell">
      <Header />

      <div className="mockbanner">
        Your private experiences. Nothing here is shared or published. AI assists
        only when you ask it to — it never decides, publishes, or spends for you.
      </div>

      {/* 1 — New experience request */}
      <section className="tier">
        <div className="tier-head">
          <span className="tier-tick" style={{ background: "var(--explore)" }} />
          <span className="tier-name">New experience request</span>
        </div>
        <div className="card edge-explore">
          <RequestForm homeArea={homeArea} aiAvailable={aiAvailable} />
        </div>
      </section>

      {/* 2 — Interpreted details + manual plan creation */}
      <section className="tier">
        <div className="tier-head">
          <span className="tier-tick" style={{ background: "var(--aware)" }} />
          <span className="tier-name">Plan a request</span>
          <span className="tier-sub">in progress — not yet planned</span>
        </div>
        {openRequests.length === 0 && (
          <div className="empty">No requests in progress. Start one above.</div>
        )}
        {openRequests.map((r) => (
          <div className="card edge-aware" key={r.id} style={{ marginBottom: "var(--gap)" }}>
            <div className="exp-reqtext">“{r.requestText}”</div>
            <InterpretationSummary
              request={r}
              summary={interpretationSummary(r)}
              aiAvailable={aiAvailable}
            />
            <details className="exp-disclosure">
              <summary>Review details</summary>
              <ConstraintEditor request={r} />
            </details>
            <PlanForm requestId={r.id} defaultLocation={r.startingLocation} />
          </div>
        ))}
      </section>

      {/* 3 — Planned experiences */}
      <section className="tier">
        <div className="tier-head">
          <span className="tier-tick" style={{ background: "var(--act)" }} />
          <span className="tier-name">Planned experiences</span>
        </div>
        <PlannedList experiences={planned} />
      </section>

      {/* 4 — Resolved history (read-only + outcome correction) */}
      <section className="tier">
        <div className="tier-head">
          <span className="tier-tick" />
          <span className="tier-name">Experience history</span>
          <span className="tier-sub">resolved — outcome details correctable</span>
        </div>
        {history.length === 0 && <div className="empty">No resolved experiences yet.</div>}
        {history.map((e) => (
          <div className="card" key={e.id} style={{ marginBottom: "var(--gap)" }}>
            <div className="row" style={{ borderTop: "none" }}>
              <div>
                <div className="main">{e.title}</div>
                <div className="sub">
                  {STATUS_LABEL[e.status] ?? e.status}
                  {e.plannedDate ? ` · ${shortDate(e.plannedDate)}` : ""}
                  {e.actualCost != null ? ` · actual ${money(e.actualCost)}` : ""}
                  {e.rating != null ? ` · ${e.rating}/5` : ""}
                </div>
                {e.reflection && <div className="sub">“{e.reflection}”</div>}
                {e.nonCompletionReason && <div className="sub">Reason: {e.nonCompletionReason}</div>}
              </div>
              <div className="right">
                <span className="badge good">{e.adventureXp} XP</span>
              </div>
            </div>
            <OutcomeForm experience={e} mode="correct" />
          </div>
        ))}
      </section>

      {/* 5 — Adventure XP summary */}
      <section className="tier">
        <div className="tier-head">
          <span className="tier-tick" style={{ background: "var(--good)" }} />
          <span className="tier-name">Adventure XP</span>
        </div>
        <div className="card">
          <div className="figure num" style={{ color: "var(--good)" }}>
            {xp.total} XP
          </div>
          <div className="sub">{xp.completedCount} completed experience(s)</div>
        </div>
      </section>
    </div>
  );
}
