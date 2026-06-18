/* Seed script — run with `npm run db:seed` after migrations.
 * Creates the single Phase-1 user, default preferences, intelligence settings
 * (kill switch ON-safe defaults), and a few clearly-labeled mock rows so the
 * dashboard has real DB content to read once you switch off mock mode. */

import { db } from "./index";
import {
  users,
  userPreferences,
  intelligenceSettings,
  signals,
  jobs,
} from "./schema";

async function main() {
  const email = process.env.DEFAULT_USER_EMAIL ?? "you@example.com";

  const [user] = await db
    .insert(users)
    .values({ email, name: "Owner" })
    .onConflictDoNothing()
    .returning();

  const userId = user?.id ?? 1;

  await db
    .insert(userPreferences)
    .values({
      userId,
      homeArea: "Somerville, NJ",
      searchRadiusMiles: 25,
      maxRisk: "medium",
      interests: ["AI", "Technology", "Gaming", "Local business"],
    })
    .onConflictDoNothing();

  await db
    .insert(intelligenceSettings)
    .values({
      userId,
      aiAutomationEnabled: false, // AI stays OFF until you explicitly enable it
      killSwitch: false,
    })
    .onConflictDoNothing();

  await db.insert(signals).values({
    userId,
    title: "[SEED] Downtown street festival — vendor slots open",
    type: "festival",
    location: "Somerville, NJ",
    status: "new",
    isMock: true,
  });

  await db.insert(jobs).values({
    userId,
    title: "[SEED] Warehouse Operations Systems Lead",
    company: "Regional 3PL",
    location: "Edison, NJ",
    matchScore: 88,
    status: "new",
    isMock: true,
  });

  console.log(`Seeded user #${userId} (${email}) with mock signal + job.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
