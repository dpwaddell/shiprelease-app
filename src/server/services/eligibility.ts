type OrderLike = {
  id: string | number;
  name?: string;
  order_number?: string | number;
  financial_status?: string;
  gateway?: string;
  payment_gateway_names?: string[];
  tags?: string;
};

type Settings = {
  enabled: boolean;
  financialStatuses: unknown;
  paymentMethods: unknown;
  includeTags: unknown;
  excludeTags: unknown;
  releaseDelayMinutes: number;
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
