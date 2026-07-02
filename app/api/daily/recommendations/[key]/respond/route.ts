/* POST /api/daily/recommendations/[key]/respond — DCC Slice 4.
 * Record or correct the owner's response on the active lifecycle row for the key.
 * Body: { response, note?, deferUntil? }. `pending` = explicit reopen. The server
 * controls ownership + all timestamps; the browser cannot supply userId, ids,
 * timestamps, fingerprints, scores, sourceRefs, or verification state. Idempotent
 * on identical repeats (handled in the lifecycle service). Owner-scoped; no-store. */

import { respondToRecommendation, LifecycleError, type ResponseValue } from "@/lib/daily/lifecycle";
import { toPublicLifecycle } from "@/lib/daily/view";
import { ownerContext, decodeKey, readJsonBody, rejectUnknownFields, optBoundedString, noStore, errorResponse, RESPONSE_VALUES, NOTE_MAX } from "@/lib/daily/api-helpers";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ key: string }> };

export async function POST(request: Request, { params }: Ctx) {
  try {
    const key = decodeKey((await params).key);
    const body = await readJsonBody(request);
    rejectUnknownFields(body, ["response", "note", "deferUntil"]); // strict: userId/ids/timestamps/etc. rejected
    const response = body.response;
    if (typeof response !== "string" || !RESPONSE_VALUES.includes(response as ResponseValue)) {
      throw new LifecycleError(400, `response must be one of: ${RESPONSE_VALUES.join(", ")}.`);
    }
    const note = optBoundedString(body.note, "note", NOTE_MAX);
    let deferUntil: string | undefined;
    if (body.deferUntil !== undefined) {
      if (typeof body.deferUntil !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.deferUntil) || Number.isNaN(Date.parse(body.deferUntil))) {
        throw new LifecycleError(400, "deferUntil must be a valid YYYY-MM-DD date.");
      }
      deferUntil = body.deferUntil;
    }
    const { userId, ctx } = ownerContext();
    const row = await respondToRecommendation(userId, key, response as ResponseValue, { note: note ?? null, deferUntil, today: ctx.today });
    return noStore({ lifecycle: toPublicLifecycle(row) });
  } catch (e) {
    return errorResponse(e, "Could not record the response.");
  }
}
