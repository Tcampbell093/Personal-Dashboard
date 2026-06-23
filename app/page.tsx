/* Home / Today — the default page and the owner's daily command center (Home 1A).
 *
 * Deterministic, real-data-only, no AI. Renders five compact sections from
 * existing services via buildHomeView. Section failures degrade in place; only a
 * core/DB failure shows the full-page error. The full management workspace lives
 * at /manage; the Experience loop at /experiences. */

import { getCurrentUserId } from "@/lib/auth";
import { buildHomeView } from "@/lib/services/home";
import { longDateLabel, partOfDay } from "@/lib/time";
import { isAuthConfigured } from "@/lib/session";
import { LogoutButton } from "@/components/logout-button";
import {
  TodayHeader,
  NeedsAttention,
  ComingUp,
  MoneyAwareness,
  LifeMomentum,
} from "@/components/home/sections";

// Always render fresh; Home reflects live database state and is never cached.
export const dynamic = "force-dynamic";

function Header() {
  return (
    <header className="topbar">
      <span className="wordmark">
        Today<span className="dot">.</span>
      </span>
      <span className="topbar-right">
        <a className="navlink" href="/manage">Manage</a>
        <a className="navlink" href="/experiences">Experiences</a>
        {isAuthConfigured() && <LogoutButton />}
      </span>
    </header>
  );
}

export default async function HomePage() {
  const userId = await getCurrentUserId();
  // Date + greeting use the configured app timezone (lib/time), not server UTC.
  const longDate = longDateLabel();

  let home;
  try {
    home = await buildHomeView(userId);
  } catch (err) {
    // Core/DB failure — never fall back to mock data (spec §truthfulness).
    console.error("HomePage: core load failed.", err);
    return (
      <div className="shell home-shell">
        <Header />
        <div className="home-error">
          <b>Today is temporarily unavailable.</b> Your data store could not be
          reached, so nothing can be shown right now. This page never displays
          mock or placeholder data. Please try again shortly.
        </div>
      </div>
    );
  }

  const part = partOfDay();
  const greeting = home.firstName ? `Good ${part}, ${home.firstName}.` : `Good ${part}.`;

  // Deterministic one-line orientation; degrades gracefully if a section is down.
  const na = home.needsAttention;
  const attentionCount = na.ok ? na.data!.items.length : null;
  const summary = !na.ok
    ? "Here’s your day."
    : attentionCount === 0
      ? "Nothing needs your attention right now — here’s your day."
      : `${attentionCount} ${attentionCount === 1 ? "thing needs" : "things need"} your attention today.`;

  return (
    <div className="shell home-shell">
      <Header />
      <TodayHeader greeting={greeting} longDate={longDate} summary={summary} />

      <div className="home-grid">
        <NeedsAttention section={home.needsAttention} />
        <ComingUp section={home.comingUp} />
        <MoneyAwareness section={home.money} />
        <LifeMomentum section={home.momentum} />
      </div>
    </div>
  );
}
