/* Cost estimation + monthly / per-operation ceiling enforcement.
 *
 * Reuses the existing intelligence_settings + api_usage_logs tables — there is
 * no parallel cost store. The $5/month development ceiling is a hard code
 * constant; the per-row monthly_cost_limit is the configurable cap; the LOWER
 * of the two wins. */

import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "@/db";
import { apiUsageLogs } from "@/db/schema";
import { pricingFor } from "./models";
import { AiError } from "./provider";

export const DEV_MONTHLY_CEILING = 5.0;
export const PER_OP_CAP = { interpret: 0.02, recommend: 0.05 } as const;

export function estimateCost(model: string, tokensIn: number, tokensOut: number): number {
  const p = pricingFor(model);
  return (tokensIn / 1e6) * p.inputPerMTok + (tokensOut / 1e6) * p.outputPerMTok;
}

/** Conservative input-token estimate from text length — avoids an extra API
 * round trip. The output side of a bound always uses the operation's max_tokens. */
export function estimateInputTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

function startOfUtcMonth(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Sum of estimated Anthropic cost recorded this calendar month (UTC). */
export async function monthToDateSpend(): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${apiUsageLogs.estimatedCost}), 0)` })
    .from(apiUsageLogs)
    .where(
      and(
        eq(apiUsageLogs.provider, "anthropic"),
        gte(apiUsageLogs.createdAt, startOfUtcMonth()),
      ),
    );
  return Number(row?.total ?? 0);
}

export interface BudgetCheckInput {
  op: keyof typeof PER_OP_CAP;
  model: string;
  estInputTokens: number;
  maxOutputTokens: number;
  monthToDate: number;
  monthlyCostLimit: number | null;
}

/** Pure budget gate, run BEFORE any provider invocation. Bounds the call's cost
 * by (estimated input) + (max output) and rejects on per-op or monthly breach. */
export function enforceBudget(i: BudgetCheckInput): { boundCost: number } {
  const boundCost = estimateCost(i.model, i.estInputTokens, i.maxOutputTokens);
  const cap = PER_OP_CAP[i.op];
  if (boundCost > cap) {
    throw new AiError(
      "per_op_limit",
      422,
      `Estimated ${i.op} cost $${boundCost.toFixed(4)} exceeds the $${cap.toFixed(2)} per-operation cap.`,
    );
  }
  const ceiling = Math.min(DEV_MONTHLY_CEILING, i.monthlyCostLimit ?? DEV_MONTHLY_CEILING);
  if (i.monthToDate + boundCost > ceiling) {
    throw new AiError(
      "budget_exceeded",
      429,
      `Monthly AI budget reached ($${ceiling.toFixed(2)}). Manual planning still works.`,
    );
  }
  return { boundCost };
}
