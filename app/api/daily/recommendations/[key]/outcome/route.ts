/* POST /api/daily/recommendations/[key]/outcome — DCC Slice 4.
 * Record a bounded outcome note and/or verification state on the owner's COMPLETED
 * active lifecycle row. Body: { outcomeNote?, verificationState? }. Requires the
 * recommendation to be `complete`; rejects an empty request; verification is a
 * recorded owner/system assertion only — NO automated verification. Owner-scoped;
 * no-store. Never performs a consequential action. */

import { recordRecommendationOutcome, LifecycleError, type VerificationValue } from "@/lib/daily/lifecycle";
import { toPublicLifecycle } from "@/lib/daily/view";
import { ownerContext, decodeKey, requireJsonContentType, readJsonBody, rejectUnknownFields, optBoundedString, noStore, errorResponse, VERIFICATION_VALUES, OUTCOME_NOTE_MAX } from "@/lib/daily/api-helpers";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ key: string }> };

export async function POST(request: Request, { params }: Ctx) {
  try {
    requireJsonContentType(request);
    const key = decodeKey((await params).key);
    const body = await readJsonBody(request);
    rejectUnknownFields(body, ["outcomeNote", "verificationState"]);
    const hasNote = body.outcomeNote !== undefined;
    const hasVer = body.verificationState !== undefined;
    if (!hasNote && !hasVer) throw new LifecycleError(400, "Provide an outcome note, a verification state, or both.");
    const outcomeNote = optBoundedString(body.outcomeNote, "outcomeNote", OUTCOME_NOTE_MAX);
    let verificationState: VerificationValue | undefined;
    if (hasVer) {
      if (typeof body.verificationState !== "string" || !VERIFICATION_VALUES.includes(body.verificationState as VerificationValue)) {
        throw new LifecycleError(400, `verificationState must be one of: ${VERIFICATION_VALUES.join(", ")}.`);
      }
      verificationState = body.verificationState as VerificationValue;
    }
    const { userId } = ownerContext();
    const row = await recordRecommendationOutcome(userId, key, { outcomeNote, verificationState });
    return noStore({ lifecycle: toPublicLifecycle(row) });
  } catch (e) {
    return errorResponse(e, "Could not record the outcome.");
  }
}
