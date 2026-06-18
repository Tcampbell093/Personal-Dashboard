/* Jobs service. Mirrors the tasks pattern. */

import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { jobs } from "@/db/schema";
import type { JobView } from "@/lib/types";

export type NewJob = typeof jobs.$inferInsert;
export type JobRow = typeof jobs.$inferSelect;

export const JOB_STATUSES = [
  "new",
  "saved",
  "reviewing",
  "applying",
  "applied",
  "interviewing",
  "rejected",
  "offer",
  "dismissed",
  "expired",
] as const;

export const WORK_ARRANGEMENTS = ["remote", "hybrid", "onsite"] as const;

export function toJobViews(rows: JobRow[]): JobView[] {
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    company: r.company,
    location: r.location,
    matchScore: r.matchScore,
    workArrangement: r.workArrangement,
    status: r.status,
    isMock: r.isMock,
  }));
}

export async function listJobs(userId: number): Promise<JobRow[]> {
  return db
    .select()
    .from(jobs)
    .where(and(eq(jobs.userId, userId), isNull(jobs.deletedAt)))
    .orderBy(desc(jobs.createdAt));
}

export async function createJob(input: NewJob): Promise<JobRow> {
  const [row] = await db.insert(jobs).values(input).returning();
  return row;
}

export async function updateJob(
  userId: number,
  id: number,
  patch: Partial<NewJob>,
): Promise<JobRow | null> {
  const [row] = await db
    .update(jobs)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(jobs.id, id), eq(jobs.userId, userId), isNull(jobs.deletedAt)))
    .returning();
  return row ?? null;
}

export async function deleteJob(userId: number, id: number) {
  return updateJob(userId, id, { deletedAt: new Date() } as Partial<NewJob>);
}
