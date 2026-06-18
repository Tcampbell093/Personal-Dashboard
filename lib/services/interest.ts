/* Interest-watch service. Interest items reference a topic by FK, so listing
 * left-joins interest_topics for the name, and creating finds-or-creates the
 * topic by name. Otherwise mirrors the tasks pattern. */

import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { interestItems, interestTopics } from "@/db/schema";
import type { InterestItemView } from "@/lib/types";

export type NewInterestItem = typeof interestItems.$inferInsert;

export const INTEREST_STATUSES = ["new", "read", "saved", "dismissed"] as const;

export async function listInterestItems(userId: number) {
  return db
    .select()
    .from(interestItems)
    .leftJoin(interestTopics, eq(interestItems.topicId, interestTopics.id))
    .where(and(eq(interestItems.userId, userId), isNull(interestItems.deletedAt)))
    .orderBy(desc(interestItems.createdAt));
}

export function toInterestViews(
  rows: Awaited<ReturnType<typeof listInterestItems>>,
): InterestItemView[] {
  return rows.map(({ interest_items: i, interest_topics: t }) => ({
    id: i.id,
    topic: t?.name ?? "General",
    title: i.title,
    source: i.source,
    relevanceScore: i.relevanceScore,
    status: i.status,
    isMock: i.isMock,
  }));
}

/** Find the user's topic by name, or create it. */
async function resolveTopicId(userId: number, name: string): Promise<number> {
  const existing = await db
    .select({ id: interestTopics.id })
    .from(interestTopics)
    .where(and(eq(interestTopics.userId, userId), eq(interestTopics.name, name)))
    .limit(1);
  if (existing[0]) return existing[0].id;
  const [created] = await db
    .insert(interestTopics)
    .values({ userId, name })
    .returning({ id: interestTopics.id });
  return created.id;
}

export async function createInterestItem(input: {
  userId: number;
  topic: string;
  title: string;
  source: string | null;
}) {
  const topicId = await resolveTopicId(input.userId, input.topic);
  const [row] = await db
    .insert(interestItems)
    .values({
      userId: input.userId,
      topicId,
      title: input.title,
      source: input.source,
    })
    .returning();
  return row;
}

export async function updateInterestItem(
  userId: number,
  id: number,
  patch: Partial<NewInterestItem>,
) {
  const [row] = await db
    .update(interestItems)
    .set({ ...patch, updatedAt: new Date() })
    .where(
      and(
        eq(interestItems.id, id),
        eq(interestItems.userId, userId),
        isNull(interestItems.deletedAt),
      ),
    )
    .returning();
  return row ?? null;
}

export async function deleteInterestItem(userId: number, id: number) {
  return updateInterestItem(userId, id, {
    deletedAt: new Date(),
  } as Partial<NewInterestItem>);
}
