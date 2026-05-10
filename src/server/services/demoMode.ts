import { env } from "../env.js";

type TaggedOrder = {
  tags?: string | string[] | null;
};

function normalizeTag(tag: string) {
  return tag.trim().toLowerCase();
}

export function demoConfig() {
  return {
    enabled: env.SHIPRELEASE_DEMO_MODE,
    tag: env.SHIPRELEASE_DEMO_TAG
  };
}

export function orderTags(order: TaggedOrder) {
  if (Array.isArray(order.tags)) return order.tags.map(String).map(normalizeTag).filter(Boolean);
  return String(order.tags || "")
    .split(",")
    .map(normalizeTag)
    .filter(Boolean);
}

export function isDemoReleaseCandidate(order: TaggedOrder) {
  const config = demoConfig();
  return config.enabled && orderTags(order).includes(normalizeTag(config.tag));
}

export function logDemoDecision(event: "DEMO_RELEASE_CANDIDATE" | "DEMO_RELEASE_COMPLETED" | "DEMO_SHIPSTATION_BYPASS", metadata: Record<string, unknown>) {
  console.log(event, JSON.stringify(metadata));
}
