import { loadDashboard } from "@/lib/services/dashboard";
import { tierForTask, tierForOpportunity } from "@/lib/briefing";
import { AddTaskForm, TaskActions } from "@/components/tasks";
import { AddObligationForm, ObligationActions } from "@/components/obligations";
import { FinanceManager } from "@/components/finances";
import {
  Badge,
  Card,
  Empty,
  MockTag,
  label,
  money,
  shortDate,
  tone,
} from "@/components/ui";

// Always render fresh in Phase 1 (mock data is cheap; no caching surprises).
export const dynamic = "force-dynamic";

const TODAY = new Date();
const longDate = TODAY.toLocaleDateString("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
});

export default async function DashboardPage() {
  const d = await loadDashboard();

  // Only open tasks are triaged; completed/cancelled ones drop off the board.
  const openTasks = d.tasks.filter(
    (t) => t.status !== "completed" && t.status !== "cancelled",
  );
  const actTasks = openTasks.filter((t) => tierForTask(t) === "act_today");
  const awareTasks = openTasks.filter((t) => tierForTask(t) === "be_aware");
  const exploreTasks = openTasks.filter((t) => tierForTask(t) === "explore");
  const actOpps = d.opportunities.filter((o) => tierForOpportunity(o) === "act_today");
  const awareOpps = d.opportunities.filter((o) => tierForOpportunity(o) === "be_aware");
  // Only still-open obligations stay on the board.
  const openObligations = d.obligations.filter(
    (o) => o.status !== "done" && o.status !== "cancelled" && o.status !== "missed",
  );

  return (
    <div className="shell">
      <header className="topbar">
        <span className="wordmark">
          Personal Command Center<span className="dot">.</span>
        </span>
        <span className="date num">{longDate}</span>
      </header>

      {d.tasksLive || d.obligationsLive || d.financesLive ? (
        <div className="mockbanner">
          <b>
            {[
              d.tasksLive && "Tasks",
              d.obligationsLive && "obligations",
              d.financesLive && "finances",
            ]
              .filter(Boolean)
              .join(", ")}{" "}
            are live
          </b>{" "}
          from your database — add and edit below. Signals, opportunities, jobs,
          and interests still show mock data until those verticals are wired.
        </div>
      ) : (
        <div className="mockbanner">
          Showing <b>mock data</b>. Nothing here is connected to a database, a
          calendar, or any external source yet. Connect Neon and seed to go live.
        </div>
      )}

      {/* HERO — the day in one line */}
      <section className="hero">
        <div className="eyebrow">Daily briefing</div>
        <div className="line">{d.briefing.summary}</div>
        <div className="meta">
          <span>
            Top task: <b>{d.briefing.mostImportantTask}</b>
          </span>
          <span>
            Next up: <b>{d.briefing.mostImportantObligation}</b>
          </span>
          <span>
            Opportunity: <b>{d.briefing.mostRelevantOpportunity}</b>
          </span>
        </div>
        {d.briefing.warning && <div className="warn">⚠ {d.briefing.warning}</div>}
      </section>

      {/* ============================== ACT TODAY ============================ */}
      <section className="tier tier-act">
        <div className="tier-head">
          <span className="tier-tick" />
          <span className="tier-name">Act today</span>
          <span className="tier-sub">due now, closing, or overdue</span>
        </div>
        <div className="grid">
          <Card title="Do today" edge="act">
            {d.tasksLive && <AddTaskForm />}
            {actTasks.length === 0 && <Empty>Nothing is due today. Breathe.</Empty>}
            {actTasks.map((t) => (
              <div className="row" key={t.id}>
                <div>
                  <div className="main">{t.title}</div>
                  <div className="sub">
                    {t.category ?? "Uncategorized"}
                    {t.dueTime ? ` · ${t.dueTime}` : ""}
                  </div>
                </div>
                <div className="right">
                  <Badge variant={tone(t.priority)}>{t.priority}</Badge>
                  {d.tasksLive && <TaskActions task={t} />}
                </div>
              </div>
            ))}
          </Card>

          <Card title="Opportunity radar — closing" edge="act">
            {actOpps.length === 0 && (
              <Empty>No opportunities closing today.</Empty>
            )}
            {actOpps.map((o) => (
              <div className="row" key={o.id}>
                <div>
                  <div className="main">
                    {o.title} <MockTag />
                  </div>
                  <div className="sub">{o.summary}</div>
                </div>
                <div className="right">
                  <Badge variant="act">closes {shortDate(o.timeWindowEnd)}</Badge>
                </div>
              </div>
            ))}
          </Card>
        </div>
      </section>

      {/* ============================== BE AWARE ============================= */}
      <section className="tier tier-aware">
        <div className="tier-head">
          <span className="tier-tick" />
          <span className="tier-name">Be aware</span>
          <span className="tier-sub">this week — obligations, money, signals</span>
        </div>
        <div className="grid cols-3">
          <Card title="Upcoming obligations" edge="aware" className="span-2">
            {d.obligationsLive && <AddObligationForm />}
            {openObligations.length === 0 && <Empty>Calendar is clear.</Empty>}
            {openObligations.map((o) => (
              <div className="row" key={o.id}>
                <div>
                  <div className="main">{o.title}</div>
                  <div className="sub">
                    {label(o.type)}
                    {o.location ? ` · ${o.location}` : ""}
                  </div>
                </div>
                <div className="right">
                  <span className="num">
                    {shortDate(o.startDate)}
                    {o.startTime ? ` · ${o.startTime}` : ""}
                  </span>
                  {d.obligationsLive && <ObligationActions obligation={o} />}
                </div>
              </div>
            ))}
          </Card>

          <Card title="Financial outlook" edge="aware">
            <div className="figure num">{money(d.finances.estimatedRemaining)}</div>
            <div className="sub" style={{ marginBottom: 10 }}>
              estimated remaining before payday
            </div>
            <div className="statline num">
              <span className="k">Accounts total</span>
              <span>{money(d.finances.accountsTotal)}</span>
            </div>
            <div className="statline num">
              <span className="k">Bills before payday</span>
              <span>{money(d.finances.billsDueBeforePayday)}</span>
            </div>
            <div className="statline num">
              <span className="k">Due in 30 days</span>
              <span>{money(d.finances.due30)}</span>
            </div>
            <div className="statline num">
              <span className="k">Overdue</span>
              <span style={{ color: d.finances.overdueCount ? "var(--act)" : undefined }}>
                {d.finances.overdueCount}
              </span>
            </div>
          </Card>
        </div>

        <div className="grid" style={{ marginTop: "var(--gap)" }}>
          <Card title="Local intelligence — signals" edge="aware" className="span-2">
            {d.signals.map((s) => (
              <div className="row" key={s.id}>
                <div>
                  <div className="main">
                    {s.title} {s.isMock && <MockTag />}
                  </div>
                  <div className="sub">
                    {label(s.type)}
                    {s.location ? ` · ${s.location}` : ""}
                  </div>
                </div>
                <div className="right">
                  <Badge variant={s.urgencyScore && s.urgencyScore >= 70 ? "act" : "aware"}>
                    {s.eventDate ? shortDate(s.eventDate) : label(s.status)}
                  </Badge>
                </div>
              </div>
            ))}
          </Card>

          <Card title="This week's opportunities" edge="aware">
            {awareOpps.length === 0 && <Empty>None this week.</Empty>}
            {awareOpps.map((o) => (
              <div className="row" key={o.id}>
                <div>
                  <div className="main">{o.title}</div>
                  <div className="sub">{label(o.category)}</div>
                </div>
                <div className="right num">
                  {o.potentialValue ? money(o.potentialValue) : ""}
                </div>
              </div>
            ))}
          </Card>

          <Card title="Other open tasks" edge="aware">
            {awareTasks.length + exploreTasks.length === 0 && (
              <Empty>No other open tasks.</Empty>
            )}
            {[...awareTasks, ...exploreTasks].map((t) => (
              <div className="row" key={t.id}>
                <div>
                  <div className="main">{t.title}</div>
                  <div className="sub">
                    {t.category ?? "Uncategorized"}
                    {t.dueDate ? ` · due ${shortDate(t.dueDate)}` : ""}
                  </div>
                </div>
                <div className="right">
                  <Badge variant={tone(t.priority)}>{t.priority}</Badge>
                  {d.tasksLive && <TaskActions task={t} />}
                </div>
              </div>
            ))}
          </Card>
        </div>

        {d.financesLive && (
          <div className="grid" style={{ marginTop: "var(--gap)" }}>
            <Card title="Manage money" edge="aware" className="span-2">
              <FinanceManager
                accounts={d.accounts}
                bills={d.bills}
                income={d.income}
              />
            </Card>
          </div>
        )}
      </section>

      {/* =============================== EXPLORE ============================= */}
      <section className="tier tier-explore">
        <div className="tier-head">
          <span className="tier-tick" />
          <span className="tier-name">Explore</span>
          <span className="tier-sub">no rush — jobs, interests, longer horizon</span>
        </div>
        <div className="grid">
          <Card title="Job matches" edge="explore">
            {d.jobs.map((j) => (
              <div className="row" key={j.id}>
                <div>
                  <div className="main">
                    {j.title} {j.isMock && <MockTag />}
                  </div>
                  <div className="sub">
                    {j.company ?? "—"}
                    {j.location ? ` · ${j.location}` : ""}
                    {j.workArrangement ? ` · ${label(j.workArrangement)}` : ""}
                  </div>
                </div>
                <div className="right">
                  {j.matchScore != null && (
                    <Badge variant="explore">{j.matchScore}% match</Badge>
                  )}
                </div>
              </div>
            ))}
          </Card>

          <Card title="Interest watch" edge="explore">
            {d.interest.map((i) => (
              <div className="row" key={i.id}>
                <div>
                  <div className="main">
                    {i.title} {i.isMock && <MockTag />}
                  </div>
                  <div className="sub">
                    {i.topic}
                    {i.source ? ` · ${i.source}` : ""}
                  </div>
                </div>
                <div className="right num">
                  {i.relevanceScore != null ? `${i.relevanceScore}` : ""}
                </div>
              </div>
            ))}
          </Card>
        </div>

        {/* next seven days */}
        <div className="grid" style={{ marginTop: "var(--gap)" }}>
          <Card title="Next seven days" edge="explore" className="span-2">
            <NextSevenDays
              obligations={openObligations}
              tasks={openTasks.map((t) => ({ date: t.dueDate }))}
            />
          </Card>
        </div>
      </section>
    </div>
  );
}

/* Lightweight 7-day strip: a dot per day that has an obligation or task due. */
function NextSevenDays({
  obligations,
  tasks,
}: {
  obligations: { startDate: string }[];
  tasks: { date: string | null }[];
}) {
  const days = Array.from({ length: 7 }, (_, i) => {
    const dt = new Date(TODAY);
    dt.setDate(dt.getDate() + i);
    const iso = dt.toISOString().slice(0, 10);
    return {
      iso,
      dow: dt.toLocaleDateString("en-US", { weekday: "short" }),
      dnum: dt.getDate(),
      hasObligation: obligations.some((o) => o.startDate === iso),
      hasTask: tasks.some((t) => t.date === iso),
    };
  });

  return (
    <div className="week">
      {days.map((d) => (
        <div className="day" key={d.iso}>
          <div className="dow">{d.dow}</div>
          <div className="dnum num">{d.dnum}</div>
          <div className="dot-row">
            {d.hasObligation && <span className="d aware" />}
            {d.hasTask && <span className="d act" />}
          </div>
        </div>
      ))}
    </div>
  );
}
