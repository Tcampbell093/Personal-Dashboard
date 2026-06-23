/* Full management workspace (the route-owned component for `/manage`).
 *
 * Clarified information architecture (not a redesign):
 *   1. Act Today          — actionable TASKS (overdue / due today / urgent) + add
 *   2. Upcoming Commitments — dated OBLIGATIONS to be aware of (distinct from tasks)
 *   3. Money              — financial outlook + bills
 *   4. Recently completed — collapsed task history with reopen
 *   5. Experimental       — sample-backed verticals, honestly labeled
 * The default `/` is the Home / Today command center. */

import { loadDashboard } from "@/lib/services/dashboard";
import { tierForTask, tierForOpportunity } from "@/lib/briefing";
import { localDaysUntil } from "@/lib/time";
import { AddTaskForm, TaskActions, ReopenTask } from "@/components/tasks";
import { AddObligationForm, ObligationActions } from "@/components/obligations";
import { FinanceManager } from "@/components/finances";
import { computeCashSummary } from "@/lib/services/finances";
import { RowActions } from "@/components/row-actions";
import { AddSignalForm } from "@/components/signals";
import { AddOpportunityForm } from "@/components/opportunities";
import { AddJobForm } from "@/components/jobs";
import { AddInterestForm } from "@/components/interest";
import { LogoutButton } from "@/components/logout-button";
import { isAuthConfigured } from "@/lib/session";
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
import type { TaskView } from "@/lib/types";

const TODAY = new Date();
const longDate = TODAY.toLocaleDateString("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
});

const EXPERIMENTAL = " — experimental / sample-backed";
const RECENT_COMPLETED_LIMIT = 10;

/** Explicit due/overdue label for a task (text, never color alone). */
function dueLabel(dueDate: string | null): { text: string; cls: string } {
  if (!dueDate) return { text: "No due date", cls: "muted" };
  const d = localDaysUntil(dueDate);
  if (d < 0) return { text: `Overdue ${-d} day${-d === 1 ? "" : "s"}`, cls: "act" };
  if (d === 0) return { text: "Due today", cls: "act" };
  if (d <= 7) return { text: `Due in ${d} day${d === 1 ? "" : "s"}`, cls: "aware" };
  return { text: `Due ${shortDate(dueDate)}`, cls: "muted" };
}

function TaskRow({ t, live }: { t: TaskView; live: boolean }) {
  const due = dueLabel(t.dueDate);
  return (
    <div className="row" key={t.id}>
      <div>
        <div className="main">{t.title}</div>
        <div className="sub">
          <span className={`duelabel ${due.cls}`}>{due.text}</span>
          {t.category ? ` · ${t.category}` : ""}
          {t.dueTime ? ` · ${t.dueTime}` : ""}
        </div>
      </div>
      <div className="right">
        <Badge variant={tone(t.priority)}>{t.priority}</Badge>
        {live && <TaskActions task={t} />}
      </div>
    </div>
  );
}

export async function ManageDashboard() {
  const d = await loadDashboard();

  const openTasks = d.tasks.filter(
    (t) => t.status !== "completed" && t.status !== "cancelled",
  );
  const actTasks = openTasks.filter((t) => tierForTask(t) === "act_today");
  const laterTasks = openTasks.filter((t) => tierForTask(t) !== "act_today");
  const completedTasks = d.tasks
    .filter((t) => t.status === "completed")
    .sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""));

  const liveOpps = d.opportunities.filter(
    (o) => !["dismissed", "expired", "unsuccessful"].includes(o.status),
  );
  const actOpps = liveOpps.filter((o) => tierForOpportunity(o) === "act_today");
  const awareOpps = liveOpps.filter((o) => tierForOpportunity(o) === "be_aware");
  const liveSignals = d.signals.filter((s) => !["dismissed", "expired"].includes(s.status));
  const liveJobs = d.jobs.filter((j) => !["dismissed", "expired"].includes(j.status));
  const liveInterest = d.interest.filter((i) => i.status !== "dismissed");
  const openObligations = d.obligations.filter(
    (o) => o.status !== "done" && o.status !== "cancelled" && o.status !== "missed",
  );
  // Truthful cash/liability rollups from manually entered balances (credit excluded).
  const cash = computeCashSummary(d.accounts);

  return (
    <div className="shell">
      <header className="topbar">
        <span className="wordmark">
          Manage<span className="dot">.</span>
        </span>
        <span className="topbar-right">
          <a className="navlink" href="/">← Home</a>
          <a className="navlink" href="/experiences">Experiences</a>
          <span className="date num">{longDate}</span>
          {isAuthConfigured() && <LogoutButton />}
        </span>
      </header>

      <div className="mockbanner">
        <b>Tasks, obligations, and finances are live</b> from your database. Signals,
        opportunities, jobs, and interests remain <b>experimental / sample-backed</b> and are
        not your real records. AI/automation stays off until you enable it.
      </div>

      {/* HERO — the day in one line */}
      <section className="hero">
        <div className="eyebrow">Daily briefing</div>
        <div className="line">{d.briefing.summary}</div>
        {d.briefing.warning && <div className="warn">⚠ {d.briefing.warning}</div>}
      </section>

      {/* ===== 1. ACT TODAY — actionable tasks ===== */}
      <section className="tier tier-act">
        <div className="tier-head">
          <span className="tier-tick" />
          <span className="tier-name">Act today</span>
          <span className="tier-sub">tasks to do and complete — overdue, due today, or urgent</span>
        </div>
        <div className="grid">
          <Card title="Do today — tasks" edge="act">
            {d.tasksLive && <AddTaskForm />}
            {actTasks.length === 0 && <Empty>Nothing is due today. Breathe.</Empty>}
            {actTasks.map((t) => (
              <TaskRow t={t} live={d.tasksLive} key={t.id} />
            ))}
          </Card>

          <Card title="Other open tasks" edge="act">
            {laterTasks.length === 0 && <Empty>No other open tasks.</Empty>}
            {laterTasks.map((t) => (
              <TaskRow t={t} live={d.tasksLive} key={t.id} />
            ))}
          </Card>
        </div>
      </section>

      {/* ===== 2. UPCOMING COMMITMENTS — obligations (distinct from tasks) ===== */}
      <section className="tier tier-aware">
        <div className="tier-head">
          <span className="tier-tick" />
          <span className="tier-name">Upcoming commitments</span>
          <span className="tier-sub">appointments and dated commitments to be aware of — not checklist tasks</span>
        </div>
        <div className="grid cols-3">
          <Card title="Commitments" edge="aware" className="span-2">
            {d.obligationsLive && <AddObligationForm />}
            {openObligations.length === 0 && <Empty>No upcoming commitments.</Empty>}
            {openObligations.map((o) => (
              <div className="row" key={o.id}>
                <div>
                  <div className="main">{o.title}</div>
                  <div className="sub">
                    <span className="commitment-type">{label(o.type)}</span>
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

          <Card title="Next seven days" edge="aware">
            <NextSevenDays
              obligations={openObligations}
              tasks={openTasks.map((t) => ({ date: t.dueDate }))}
            />
          </Card>
        </div>
      </section>

      {/* ===== 3. MONEY — compact summary; full workspace lives at /finances ===== */}
      <section className="tier tier-aware">
        <div className="tier-head">
          <span className="tier-tick" style={{ background: "var(--good)" }} />
          <span className="tier-name">Money</span>
          <span className="tier-sub">manually entered actual balances — full workspace at /finances</span>
        </div>
        <div className="grid cols-3">
          <Card title="Money summary" edge="aware">
            <div className="statline num">
              <span className="k">Total actual cash</span>
              <span className="good">{money(cash.totalActualCash)}</span>
            </div>
            <div className="statline num">
              <span className="k">Spendable cash</span>
              <span>{money(cash.spendableActualCash)}</span>
            </div>
            {cash.creditAccountCount > 0 && (
              <div className="statline num">
                <span className="k">Credit owed (liability)</span>
                <span style={{ color: "var(--act)" }}>{money(cash.creditLiabilities)}</span>
              </div>
            )}
            <div className="statline num">
              <span className="k">Bills before payday</span>
              <span>{money(d.finances.billsDueBeforePayday)}</span>
            </div>
            <div className="statline num">
              <span className="k">Overdue bills</span>
              <span style={{ color: d.finances.overdueCount ? "var(--act)" : undefined }}>
                {d.finances.overdueCount}
              </span>
            </div>
            <div className="sub" style={{ marginTop: 8 }}>
              Legacy estimate (replaced by account-aware projection in a later build):{" "}
              <span className="num">{money(d.finances.estimatedRemaining)}</span> estimated
              remaining from manually entered balances.
            </div>
            <div style={{ marginTop: 10 }}>
              <a className="navlink" href="/finances">Manage accounts &amp; bills at /finances →</a>
            </div>
          </Card>
          {d.financesLive && (
            <Card title="Income" edge="aware" className="span-2">
              <div className="sub" style={{ marginBottom: 8 }}>
                Income records (kept here for now; account-aware income arrives in a
                later finance build).
              </div>
              <FinanceManager
                accounts={d.accounts}
                bills={d.bills}
                income={d.income}
                sections={["income"]}
              />
            </Card>
          )}
        </div>
      </section>

      {/* ===== 4. RECENTLY COMPLETED — collapsed task history ===== */}
      <section className="tier">
        <details className="manage-completed">
          <summary>
            Recently completed tasks
            <span className="manage-completed-count">{completedTasks.length}</span>
          </summary>
          {completedTasks.length === 0 ? (
            <div className="empty">No completed tasks yet.</div>
          ) : (
            <div className="card manage-completed-card">
              {completedTasks.slice(0, RECENT_COMPLETED_LIMIT).map((t) => (
                <div className="row" key={t.id}>
                  <div>
                    <div className="main done-title">{t.title}</div>
                    <div className="sub">
                      Completed {t.completedAt ? shortDate(t.completedAt.slice(0, 10)) : "—"}
                      {t.category ? ` · ${t.category}` : ""}
                    </div>
                  </div>
                  <div className="right">{d.tasksLive && <ReopenTask taskId={t.id} />}</div>
                </div>
              ))}
              {completedTasks.length > RECENT_COMPLETED_LIMIT && (
                <div className="sub" style={{ marginTop: 8 }}>
                  Showing the {RECENT_COMPLETED_LIMIT} most recent of {completedTasks.length}{" "}
                  completed tasks.
                </div>
              )}
            </div>
          )}
        </details>
      </section>

      {/* ===== 5. EXPERIMENTAL — sample-backed verticals (honestly labeled) ===== */}
      <section className="tier tier-explore">
        <div className="tier-head">
          <span className="tier-tick" style={{ background: "var(--explore)" }} />
          <span className="tier-name">Experimental</span>
          <span className="tier-sub">sample-backed — not your real records yet</span>
        </div>
        <div className="grid cols-3">
          <Card title={`Signals${EXPERIMENTAL}`} edge="explore" className="span-2">
            {d.signalsLive && <AddSignalForm />}
            {liveSignals.length === 0 && <Empty>No signals right now.</Empty>}
            {liveSignals.map((s) => (
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
                  {d.signalsLive && <RowActions base="/api/signals" id={s.id} />}
                </div>
              </div>
            ))}
          </Card>

          <Card title={`Opportunities${EXPERIMENTAL}`} edge="explore">
            {d.opportunitiesLive && <AddOpportunityForm />}
            {[...actOpps, ...awareOpps].length === 0 && <Empty>None right now.</Empty>}
            {[...actOpps, ...awareOpps].map((o) => (
              <div className="row" key={o.id}>
                <div>
                  <div className="main">{o.title}</div>
                  <div className="sub">{label(o.category)}</div>
                </div>
                <div className="right">
                  <span className="num">{o.potentialValue ? money(o.potentialValue) : ""}</span>
                  {d.opportunitiesLive && <RowActions base="/api/opportunities" id={o.id} />}
                </div>
              </div>
            ))}
          </Card>
        </div>

        <div className="grid" style={{ marginTop: "var(--gap)" }}>
          <Card title={`Job matches${EXPERIMENTAL}`} edge="explore">
            {d.jobsLive && <AddJobForm />}
            {liveJobs.length === 0 && <Empty>No job matches yet.</Empty>}
            {liveJobs.map((j) => (
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
                  {j.matchScore != null && <Badge variant="explore">{j.matchScore}% match</Badge>}
                  {d.jobsLive && <RowActions base="/api/jobs" id={j.id} />}
                </div>
              </div>
            ))}
          </Card>

          <Card title={`Interest watch${EXPERIMENTAL}`} edge="explore">
            {d.interestLive && <AddInterestForm />}
            {liveInterest.length === 0 && <Empty>Nothing on the watch list.</Empty>}
            {liveInterest.map((i) => (
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
                <div className="right">
                  <span className="num">{i.relevanceScore != null ? `${i.relevanceScore}` : ""}</span>
                  {d.interestLive && <RowActions base="/api/interest" id={i.id} />}
                </div>
              </div>
            ))}
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
      {days.map((dd) => (
        <div className="day" key={dd.iso}>
          <div className="dow">{dd.dow}</div>
          <div className="dnum num">{dd.dnum}</div>
          <div className="dot-row">
            {dd.hasObligation && <span className="d aware" />}
            {dd.hasTask && <span className="d act" />}
          </div>
        </div>
      ))}
    </div>
  );
}
