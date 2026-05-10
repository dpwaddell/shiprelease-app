type OrderLike = {
  id: string | number;
  name?: string;
  order_number?: string | number;
  financial_status?: string;
  gateway?: string;
  payment_gateway_names?: string[];
  tags?: string;
  total_price?: string | number;
  totalPrice?: string | number;
  risk_level?: string;
  riskLevel?: string;
};

type Settings = {
  enabled: boolean;
  financialStatuses: unknown;
  paymentMethods: unknown;
  includeTags: unknown;
  excludeTags: unknown;
  releaseDelayMinutes: number;
  releaseOnlyFullyPaid?: boolean;
  ignoreHighRiskOrders?: boolean;
  requireManualReviewAboveAmount?: boolean;
  manualReviewAmount?: unknown;
};

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function tags(order: OrderLike): string[] {
  return String(order.tags || "")
    .split(",")
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);
}

export function orderGateway(order: OrderLike) {
  return order.gateway || order.payment_gateway_names?.join(", ") || "";
}

function amount(value: unknown) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function evaluateRuleFoundation(order: OrderLike, settings: Settings) {
  const checks: Array<{ name: string; passed: boolean; message: string }> = [];
  const financialStatus = String(order.financial_status || "").toLowerCase();
  if (settings.releaseOnlyFullyPaid) {
    checks.push({
      name: "releaseOnlyFullyPaid",
      passed: financialStatus === "paid",
      message: financialStatus === "paid" ? "Order is fully paid." : "Order is not fully paid."
    });
  }

  const riskLevel = String(order.risk_level || order.riskLevel || "").toLowerCase();
  if (settings.ignoreHighRiskOrders) {
    checks.push({
      name: "ignoreHighRiskOrders",
      passed: riskLevel !== "high",
      message: riskLevel === "high" ? "High risk orders require review." : "No high risk signal detected."
    });
  }

  if (settings.requireManualReviewAboveAmount) {
    const orderAmount = amount(order.total_price ?? order.totalPrice);
    const threshold = amount(settings.manualReviewAmount);
    checks.push({
      name: "requireManualReviewAboveAmount",
      passed: !threshold || orderAmount <= threshold,
      message: threshold && orderAmount > threshold ? `Order total exceeds ${threshold}.` : "Order total is below manual review threshold."
    });
  }

  return {
    passed: checks.every((check) => check.passed),
    checks
  };
}

export function evaluateOrderEligibility(order: OrderLike, settings: Settings) {
  if (!settings.enabled) return { eligible: false, reason: "Automation is disabled" };

  const statuses = list(settings.financialStatuses).map((status) => status.toLowerCase());
  const financialStatus = String(order.financial_status || "").toLowerCase();
  if (!statuses.includes(financialStatus)) {
    return { eligible: false, reason: `Financial status ${financialStatus || "unknown"} is not eligible` };
  }

  const orderTags = tags(order);
  const excluded = list(settings.excludeTags).map((tag) => tag.toLowerCase());
  const blockedTag = excluded.find((tag) => orderTags.includes(tag));
  if (blockedTag) return { eligible: false, reason: `Excluded tag matched: ${blockedTag}` };

  const included = list(settings.includeTags).map((tag) => tag.toLowerCase());
  if (included.length > 0 && !included.some((tag) => orderTags.includes(tag))) {
    return { eligible: false, reason: "No include tag matched" };
  }

  const gateway = orderGateway(order).toLowerCase();
  const methods = list(settings.paymentMethods).map((method) => method.toLowerCase());
  if (methods.length > 0 && !methods.some((method) => gateway.includes(method))) {
    return { eligible: false, reason: `Payment method ${gateway || "unknown"} is not eligible` };
  }

  return { eligible: true, reason: null };
}
