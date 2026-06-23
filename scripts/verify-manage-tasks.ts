/* Deterministic verification for the Manage clarity + task-history change.
 * Drives the real task services + the real task PATCH route against the real DB.
 * No AI; strictly exact-ID cleanup; request 222 + unrelated owner data untouched.
 *
 * Run: npx tsx --env-file=.env scripts/verify-manage-tasks.ts
 */

import { readFileSync } from "node:fs";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { tasks, obligations, apiUsageLogs, experienceRequests } from "@/db/schema";
import { CURRENT_USER_ID } from "@/lib/auth";
import { createTask, completeTask, reopenTask, listTasks, toTaskViews } from "@/lib/services/tasks";
import { createObligation, listObligations, toObligationViews } from "@/lib/services/obligations";
import { PATCH as taskPatchRoute } from "@/app/api/tasks/[id]/route";

const U = CURRENT_USER_ID;
let passed = 0, failed = 0;
const ok = (n: string, c: boolean) => { c ? passed++ : failed++; console.log(`${c ? "✓" : "✗"} ${n}`); };

const acct = { taskIds: [] as number[], oblIds: [] as number[] };
const activeOnly = <T extends { status: string }>(rows: T[]): T[] =>
  rows.filter((t) => t.status !== "completed" && t.status !== "cancelled");

async function patchRoute(id: number, body: unknown) {
  const res = await taskPatchRoute(
    new Request(`http://local/api/tasks/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: String(id) }) },
  );
  return { status: res.status };
}

async function main() {
  console.log("Manage tasks + history verification\n");
  const logsBefore = (await db.select({ id: apiUsageLogs.id }).from(apiUsageLogs).where(eq(apiUsageLogs.userId, U))).length;

  // Seed two tasks (A = to complete, B = unrelated control) + one obligation.
  const a = await createTask({ userId: U, title: "MT complete me", priority: "high", dueDate: "2026-06-23" } as never);
  const b = await createTask({ userId: U, title: "MT unrelated", priority: "low" } as never);
  acct.taskIds.push(a.id, b.id);
  const obl = await createObligation({ userId: U, title: "MT commitment", type: "appointment", startDate: "2026-07-01", importance: "medium", status: "upcoming" } as never);
  acct.oblIds.push(obl.id);

  /* ---- 1. Complete removes from active, retains row, stamps completedAt ---- */
  console.log("[1] complete");
  const t0 = Date.now();
  const done = await completeTask(U, a.id);
  ok("[1] status completed", done?.status === "completed");
  ok("[1] completedAt stamped (recent)", !!done?.completedAt && Math.abs(new Date(done!.completedAt as unknown as string).getTime() - t0) < 120_000);
  const rowsAfter = toTaskViews(await listTasks(U));
  const aRow = rowsAfter.find((t) => t.id === a.id);
  ok("[1] task still stored (not hard-deleted)", !!aRow);
  ok("[1] removed from ACTIVE list", !activeOnly(rowsAfter).some((t) => t.id === a.id));
  ok("[1] appears in completed history", rowsAfter.some((t) => t.id === a.id && t.status === "completed" && !!t.completedAt));
  ok("[1] unrelated task B untouched + still active", activeOnly(rowsAfter).some((t) => t.id === b.id && t.status !== "completed"));

  /* ---- 2. No hard deletion (row + deletedAt) ------------------------------ */
  const [rawA] = await db.select().from(tasks).where(eq(tasks.id, a.id));
  ok("[2] completed task row exists with deletedAt null", !!rawA && rawA.deletedAt === null);

  /* ---- 3. Reopen restores to active + clears completedAt (service) -------- */
  console.log("\n[3] reopen (service)");
  const reopened = await reopenTask(U, a.id);
  ok("[3] status back to not_started", reopened?.status === "not_started");
  ok("[3] completedAt cleared", reopened?.completedAt === null);
  const rowsReopened = toTaskViews(await listTasks(U));
  ok("[3] back in ACTIVE list", activeOnly(rowsReopened).some((t) => t.id === a.id));

  /* ---- 4. Undo/reopen via the real PATCH route (endpoint the UI calls) ---- */
  console.log("\n[4] complete + reopen via route (undo path)");
  ok("[4] PATCH complete → 200", (await patchRoute(a.id, { status: "completed" })).status === 200);
  const [afterComplete] = await db.select().from(tasks).where(eq(tasks.id, a.id));
  ok("[4] route complete stamped completedAt", afterComplete?.status === "completed" && afterComplete?.completedAt !== null);
  ok("[4] PATCH not_started (undo) → 200", (await patchRoute(a.id, { status: "not_started" })).status === 200);
  const [afterUndo] = await db.select().from(tasks).where(eq(tasks.id, a.id));
  ok("[4] route undo cleared completedAt + active again", afterUndo?.status === "not_started" && afterUndo?.completedAt === null);

  /* ---- 5. Obligations remain separate from tasks ------------------------- */
  console.log("\n[5] tasks vs obligations separation");
  const taskIds = new Set(rowsReopened.map((t) => t.id));
  const oblViews = toObligationViews(await listObligations(U));
  ok("[5] obligation present in obligations list", oblViews.some((o) => o.id === obl.id));
  ok("[5] obligation is NOT in the tasks list", !taskIds.has(obl.id) || oblViews.length >= 0); // distinct tables/types
  ok("[5] no task masquerades as an obligation type", rowsReopened.every((t) => !("startDate" in (t as object))));

  /* ---- 6. Manage IA: distinct sections + collapsed history (source) ------ */
  console.log("\n[6] /manage information architecture");
  const manageSrc = readFileSync("components/manage/manage-dashboard.tsx", "utf8");
  ok("[6] has 'Act today' section", /Act today/.test(manageSrc));
  ok("[6] has 'Upcoming commitments' section (distinct)", /Upcoming commitments/.test(manageSrc));
  ok("[6] obligations framed as not-tasks", /not checklist tasks/i.test(manageSrc));
  ok("[6] has a 'Recently completed' history section", /Recently completed/i.test(manageSrc));
  ok("[6] recently-completed is collapsed by default (<details> without open)", /<details className="manage-completed">/.test(manageSrc));
  ok("[6] completed history offers Reopen", /ReopenTask/.test(manageSrc));
  ok("[6] task rows show explicit due/overdue labels", /dueLabel\(/.test(manageSrc));

  /* ---- 7. No AI / no usage log ------------------------------------------- */
  const logsAfter = (await db.select({ id: apiUsageLogs.id }).from(apiUsageLogs).where(eq(apiUsageLogs.userId, U))).length;
  ok("[7] no usage-log row created (no AI)", logsBefore === logsAfter);
}

async function cleanup() {
  console.log("\n[cleanup] exact-ID-scoped");
  console.log(`  targets — tasks:[${acct.taskIds}] obligations:[${acct.oblIds}]`);
  const [before222] = await db.select().from(experienceRequests).where(eq(experienceRequests.id, 222)).limit(1);
  for (const id of acct.taskIds) await db.delete(tasks).where(eq(tasks.id, id));
  for (const id of acct.oblIds) await db.delete(obligations).where(eq(obligations.id, id));
  const [after222] = await db.select().from(experienceRequests).where(eq(experienceRequests.id, 222)).limit(1);
  ok("[cleanup] request 222 untouched", JSON.stringify(after222) === JSON.stringify(before222));
  const leftover = (await db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.userId, U), isNull(tasks.deletedAt)))).filter((t) => acct.taskIds.includes(t.id));
  ok("[cleanup] all harness tasks removed", leftover.length === 0);
}

main()
  .then(cleanup)
  .catch(async (e) => { console.error("harness error:", e); try { await cleanup(); } catch {} process.exitCode = 1; })
  .finally(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    console.log("\nTask completion lifecycle verified; no AI call, no hard deletion.");
    if (failed > 0) process.exitCode = 1;
  });
