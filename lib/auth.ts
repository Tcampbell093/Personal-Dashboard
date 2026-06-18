/* Identity resolution — Phase 1 placeholder.
 *
 * There is no authentication yet: a single hard-coded user owns every row
 * (see README "Current limitations"). Both the API route handlers and the
 * dashboard loader import from here so the "current user" is defined in ONE
 * place. When real auth lands in Phase 2, replace getCurrentUserId() with a
 * session lookup and delete the constant — every caller updates automatically. */

export const CURRENT_USER_ID = 1;

export async function getCurrentUserId(): Promise<number> {
  return CURRENT_USER_ID;
}
