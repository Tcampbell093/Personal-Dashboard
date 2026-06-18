/* =============================================================================
 * generate-daily-briefing — scheduled Netlify Function (Phase 1: DISABLED)
 *
 * The schedule is intentionally NOT active. The cron block in netlify.toml is
 * commented out. This file is committed so the wiring exists and can be turned
 * on later by uncommenting that block.
 *
 * Phase 1 behavior (no AI, no external calls, no cost):
 *   1. Open a run log row.
 *   2. Load current tasks, obligations, finances, signals, opportunities.
 *   3. Generate a deterministic rule-based briefing (lib/briefing.ts).
 *   4. Upsert the briefing for today.
 *   5. Record success/failure on the run log.
 *
 * You can invoke it manually for testing once DATABASE_URL is set:
 *   netlify functions:invoke generate-daily-briefing
 * ========================================================================== */

import type { Config } from "@netlify/functions";

// Phase 1 single-user placeholder.
const USER_ID = 1;

export default async function handler() {
  const startedAt = new Date();

  // Hard stop: never run automated intelligence while the kill switch is on
  // or AI automation is disabled. (Rule-based has no cost, but we still gate
  // the whole job here so the kill switch means what it says.)
  if (process.env.AI_AUTOMATION_ENABLED !== "true") {
    return Response.json({
      ok: true,
      skipped: true,
      reason: "AI_AUTOMATION_ENABLED is not 'true'. Rule-based run skipped by design.",
    });
  }

  try {
    // Dynamic imports keep this function from loading DB code unless it runs.
    const { db } = await import("../../db/index.ts");
    const { tasks, obligations, opportunities, dailyBriefings, scheduledRunLogs } =
      await import("../../db/schema.ts");
    const { generateBriefing } = await import("../../lib/briefing.ts");
    const { eq, and, isNull } = await import("drizzle-orm");

    const [run] = await db
      .insert(scheduledRunLogs)
      .values({ userId: USER_ID, jobName: "generate-daily-briefing", status: "success" })
      .returning();

    const liveTasks = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.userId, USER_ID), isNull(tasks.deletedAt)));
    const liveObligations = await db
      .select()
      .from(obligations)
      .where(and(eq(obligations.userId, USER_ID), isNull(obligations.deletedAt)));
    const liveOpps = await db
      .select()
      .from(opportunities)
      .where(and(eq(opportunities.userId, USER_ID), isNull(opportunities.deletedAt)));

    // NOTE: financial outlook computation lives in a service (Phase 1 stub).
    const finances = {
      accountsTotal: 0,
      nextPaydayDate: null,
      expectedIncomeBeforePayday: 0,
      billsDueBeforePayday: 0,
      estimatedRemaining: 0,
      overdueCount: 0,
      due7: 0,
      due14: 0,
      due30: 0,
    };

    const briefing = generateBriefing({
      // The DB rows are a superset of the view types these functions read.
      tasks: liveTasks as never,
      obligations: liveObligations as never,
      opportunities: liveOpps as never,
      finances,
    });

    const today = new Date().toISOString().slice(0, 10);
    await db
      .insert(dailyBriefings)
      .values({
        userId: USER_ID,
        briefingDate: today,
        summary: briefing.summary,
        mostImportantTask: briefing.mostImportantTask,
        mostImportantObligation: briefing.mostImportantObligation,
        mostRelevantOpportunity: briefing.mostRelevantOpportunity,
        warning: briefing.warning,
        generatedBy: "rule_based",
      })
      .onConflictDoUpdate({
        target: [dailyBriefings.userId, dailyBriefings.briefingDate],
        set: { summary: briefing.summary, updatedAt: new Date() },
      });

    await db
      .update(scheduledRunLogs)
      .set({ status: "success", finishedAt: new Date(), detail: "Briefing generated." })
      .where(eq(scheduledRunLogs.id, run.id));

    return Response.json({ ok: true, briefing, ranAt: startedAt.toISOString() });
  } catch (err) {
    return Response.json(
      { ok: false, error: String(err) },
      { status: 500 },
    );
  }
}

// Schedule is read from netlify.toml. Leaving config minimal here keeps the
// single source of truth in netlify.toml (currently commented out = disabled).
export const config: Config = {};
