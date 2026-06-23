/* /manage — the full management workspace (formerly the default dashboard).
 * Thin route wrapper around the relocated ManageDashboard so the page lives in
 * exactly one place. The default `/` is now the Home / Today command center. */

import { ManageDashboard } from "@/components/manage/manage-dashboard";

// Always render fresh; this view reflects live database state.
export const dynamic = "force-dynamic";

export default async function ManagePage() {
  return <ManageDashboard />;
}
