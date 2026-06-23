/* Home / Today section components (server, presentational). Each renders its
 * own compact "unavailable" state so one section failure never blanks the page.
 * The only embedded client islands are the existing TaskActions (complete a
 * task) and MarkBillPaid (mark a bill paid) — the two allowed direct actions. */

import { money, shortDate } from "@/components/ui";
import { TaskActions } from "@/components/tasks";
import { MarkBillPaid } from "@/components/home/mark-bill-paid";
import type {
  HomeSection,
  HomeNeedItem,
  HomeComingItem,
  HomeMoney,
  HomeMomentum,
} from "@/lib/types";

const NEEDS_ATTENTION_LIMIT = 5;

function Unavailable({ note }: { note: string }) {
  return <div className="home-unavailable">{note}</div>;
}

/* --------------------------------------------------------------- Today --- */
export function TodayHeader({
  greeting,
  longDate,
  summary,
}: {
  greeting: string;
  longDate: string;
  summary: string;
}) {
  return (
    <section className="home-today">
      <div className="home-today-date num">{longDate}</div>
      <h1 className="home-greeting">{greeting}</h1>
      <p className="home-summary">{summary}</p>
    </section>
  );
}

/* ----------------------------------------------------- Needs attention --- */
export function NeedsAttention({
  section,
}: {
  section: HomeSection<{ items: HomeNeedItem[]; openTaskCount: number; openObligationCount: number }>;
}) {
  return (
    <section className="home-card home-attention">
      <div className="home-card-head">
        <span className="home-tick act" />
        <h2>Needs attention</h2>
        <a className="home-link" href="/manage">Manage →</a>
      </div>
      {!section.ok ? (
        <Unavailable note="Attention items are temporarily unavailable." />
      ) : section.data!.items.length === 0 ? (
        <div className="home-empty">You’re clear — nothing needs attention right now.</div>
      ) : (
        <ul className="home-list">
          {section.data!.items.slice(0, NEEDS_ATTENTION_LIMIT).map((it) => (
            <li className="home-need" key={it.key}>
              <span className={`home-reason ${it.tone}`}>{it.reason}</span>
              <span className="home-need-title">{it.title}</span>
              {it.kind === "task" && it.task && (
                <span className="home-need-action">
                  <TaskActions task={it.task} />
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ------------------------------------------------------------ Coming up --- */
export function ComingUp({ section }: { section: HomeSection<HomeComingItem[]> }) {
  return (
    <section className="home-card">
      <div className="home-card-head">
        <span className="home-tick aware" />
        <h2>Coming up</h2>
      </div>
      {!section.ok ? (
        <Unavailable note="Upcoming items are temporarily unavailable." />
      ) : section.data!.length === 0 ? (
        <div className="home-empty">Nothing coming up.</div>
      ) : (
        <ul className="home-list">
          {section.data!.map((it) => (
            <li className="home-coming" key={it.key}>
              <span className="home-coming-date num">{shortDate(it.date)}</span>
              <span className="home-coming-title">{it.title}</span>
              {it.detail && <span className="home-coming-detail">{it.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* -------------------------------------------------------- Money aware --- */
export function MoneyAwareness({ section }: { section: HomeSection<HomeMoney> }) {
  return (
    <section className="home-card">
      <div className="home-card-head">
        <span className="home-tick good" />
        <h2>Money awareness</h2>
        <a className="home-link" href="/manage">Manage money →</a>
      </div>
      {!section.ok ? (
        <Unavailable note="Money awareness is temporarily unavailable." />
      ) : (
        <>
          <div className="home-figure num">{money(section.data!.estimatedRemaining)}</div>
          <div className="home-figure-note">
            Estimated remaining from manually entered balances
          </div>
          <div className="home-statline num">
            <span>Bills before payday</span>
            <span>{money(section.data!.billsDueBeforePayday)}</span>
          </div>
          <div className="home-statline num">
            <span>Due in 30 days</span>
            <span>{money(section.data!.due30)}</span>
          </div>
          <div className="home-statline num">
            <span>Overdue bills</span>
            <span className={section.data!.overdueCount ? "act" : ""}>
              {section.data!.overdueCount}
            </span>
          </div>
          {section.data!.dueBills.length > 0 && (
            <ul className="home-list home-bills">
              {section.data!.dueBills.map((b) => (
                <li className="home-bill" key={b.id}>
                  <span className="home-bill-name">{b.name}</span>
                  <span className="num home-bill-amt">{money(b.expectedAmount)}</span>
                  <span className="num home-bill-due">{shortDate(b.dueDate)}</span>
                  <MarkBillPaid billId={b.id} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

/* ------------------------------------------------------- Life momentum --- */
export function LifeMomentum({ section }: { section: HomeSection<HomeMomentum> }) {
  return (
    <section className="home-card">
      <div className="home-card-head">
        <span className="home-tick" style={{ background: "var(--good)" }} />
        <h2>Life momentum</h2>
        <a className="home-link" href="/experiences">Experiences →</a>
      </div>
      {!section.ok ? (
        <Unavailable note="Momentum is temporarily unavailable." />
      ) : (
        <>
          <div className="home-xp">
            <span className="home-figure num" style={{ color: "var(--good)" }}>
              {section.data!.totalXp} XP
            </span>
            <span className="home-xp-sub">
              {section.data!.completedCount} completed · {section.data!.plannedCount} planned
            </span>
          </div>
          {section.data!.nextPlanned && (
            <div className="home-momentum-row">
              <span className="home-reason aware">Next</span>
              <span>{section.data!.nextPlanned.title}</span>
              {section.data!.nextPlanned.plannedDate && (
                <span className="num home-coming-date">
                  {shortDate(section.data!.nextPlanned.plannedDate)}
                </span>
              )}
            </div>
          )}
          {section.data!.lastResolved && (
            <div className="home-momentum-row">
              <span className="home-reason good">Recent</span>
              <span>{section.data!.lastResolved.title}</span>
              <span className="home-coming-detail">{section.data!.lastResolved.status}</span>
            </div>
          )}
          {!section.data!.nextPlanned && !section.data!.lastResolved && (
            <div className="home-empty">No experiences yet — plan one.</div>
          )}
        </>
      )}
    </section>
  );
}
