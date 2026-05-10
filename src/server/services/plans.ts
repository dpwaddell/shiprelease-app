import { prisma } from "../db.js";

export const PLAN_LIMITS: Record<string, number> = {
  Starter: 100,
  Pro: 1000,
  Scale: 10000
};

export function normalizePlanName(name?: string | null): string {
  if (!name) return "unknown";
  const match = Object.keys(PLAN_LIMITS).find((plan) => plan.toLowerCase() === name.toLowerCase());
  return match || name;
}

export function planLimit(planName?: string | null): number {
  return PLAN_LIMITS[normalizePlanName(planName)] || 0;
}

export async function getPlanUsage(shopId: string, planName?: string | null) {
  const month = new Date().toISOString().slice(0, 7);
  const usage = await prisma.usageCounter.upsert({
    where: { shopId_billingMonth: { shopId, billingMonth: month } },
    update: {},
    create: { shopId, billingMonth: month }
  });
  const limit = planLimit(planName);
  return { month, limit, count: usage.releaseCount, usage };
}
