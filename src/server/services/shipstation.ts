export type ShipStationAuth = {
  apiKey: string;
  apiSecret: string;
};

type ShipStationOrder = {
  orderId: number;
  orderNumber?: string;
  orderKey?: string;
  orderStatus?: string;
};

const BASE_URL = "https://ssapi.shipstation.com";

function headers(auth: ShipStationAuth) {
  return {
    Authorization: `Basic ${Buffer.from(`${auth.apiKey}:${auth.apiSecret}`).toString("base64")}`,
    "Content-Type": "application/json"
  };
}

async function request<T>(path: string, auth: ShipStationAuth, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { ...headers(auth), ...(init?.headers || {}) }
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`ShipStation ${response.status}: ${body.slice(0, 300)}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function testShipStationConnection(auth: ShipStationAuth) {
  await request<{ stores: unknown[] }>("/stores", auth);
}

export function orderCandidates(input: { id: string; name?: string | null; orderNumber?: string | number | null }) {
  const values = new Set<string>();
  if (input.name) {
    values.add(input.name);
    values.add(input.name.replace(/^#/, ""));
  }
  if (input.orderNumber) values.add(String(input.orderNumber));
  values.add(String(input.id));
  values.add(String(input.id).replace(/^gid:\/\/shopify\/Order\//, ""));
  return [...values].filter(Boolean);
}

export async function locateShipStationOrder(auth: ShipStationAuth, candidates: string[]) {
  for (const candidate of candidates) {
    const data = await request<{ orders?: ShipStationOrder[] }>(
      `/orders?orderNumber=${encodeURIComponent(candidate)}&pageSize=10`,
      auth
    );
    const found = data.orders?.find((order) => {
      const number = String(order.orderNumber || "");
      const key = String(order.orderKey || "");
      return number === candidate || number.replace(/^#/, "") === candidate.replace(/^#/, "") || key.includes(candidate);
    });
    if (found) return found;
  }
  return null;
}

export async function releaseShipStationOrder(auth: ShipStationAuth, orderId: number) {
  await request<void>("/orders/restorefromhold", auth, {
    method: "POST",
    body: JSON.stringify({ orderId })
  });
}
