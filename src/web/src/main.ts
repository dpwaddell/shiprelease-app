import "./styles.css";

declare global {
  interface Window {
    shopify?: { idToken?: () => Promise<string> };
  }
}

type Tab = "dashboard" | "automation" | "shipstation" | "plans" | "support";

const state: { tab: Tab; data: Record<string, unknown>; message?: string } = {
  tab: "dashboard",
  data: {}
};

const tabs: Array<{ id: Tab; label: string }> = [
  { id: "dashboard", label: "Dashboard" },
  { id: "automation", label: "Automation" },
  { id: "shipstation", label: "ShipStation" },
  { id: "plans", label: "Plans" },
  { id: "support", label: "Support" }
];

async function token() {
  if (window.shopify?.idToken) return window.shopify.idToken();
  return localStorage.getItem("shiprelease_dev_token") || "";
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${await token()}`,
      ...(init?.headers || {})
    }
  });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || response.statusText);
  return response.json() as Promise<T>;
}

function app() {
  return document.querySelector<HTMLDivElement>("#app")!;
}

function shell(content: string) {
  app().innerHTML = `
    <div class="topbar">
      <div>
        <h1>ShipRelease</h1>
        <p>Automate unpaid order release into ShipStation</p>
      </div>
      <span class="badge">Works with ShipStation</span>
    </div>
    <nav>${tabs.map((tab) => `<button class="${state.tab === tab.id ? "active" : ""}" data-tab="${tab.id}">${tab.label}</button>`).join("")}</nav>
    ${state.message ? `<div class="notice">${state.message}</div>` : ""}
    <main>${content}</main>
  `;
  document.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((button) => {
    button.onclick = () => load(button.dataset.tab as Tab);
  });
}

function metric(label: string, value: string, sub = "") {
  return `<section class="metric"><span>${label}</span><strong>${value}</strong><small>${sub}</small></section>`;
}

function dashboard(data: any) {
  const rows = (data.recent || []).map((event: any) => `
    <tr>
      <td>${event.shopifyOrderName || event.shopifyOrderId}</td>
      <td>${event.shipstationOrderId || "-"}</td>
      <td><span class="status ${event.status}">${event.status}</span></td>
      <td>${new Date(event.createdAt).toLocaleString()}</td>
      <td>${event.failureReason || event.skipReason || ""}</td>
    </tr>
  `).join("");
  shell(`
    <div class="grid">
      ${metric("Releases this month", String(data.releasesThisMonth || 0))}
      ${metric("Plan usage", `${data.usage?.count || 0} / ${data.usage?.limit || 0}`, data.usage?.month || "")}
      ${metric("Warehouse actions saved", String(data.releasesThisMonth || 0), `~${Math.round((data.estimatedSecondsSaved || 0) / 60)} minutes`)}
      ${metric("Success rate", `${data.successRate ?? 100}%`)}
      ${metric("Needs attention", String(data.failedReleases || 0))}
    </div>
    <section class="panel">
      <h2>Recent activity</h2>
      <table><thead><tr><th>Shopify order</th><th>ShipStation reference</th><th>Result</th><th>Time</th><th>Failure reason</th></tr></thead><tbody>${rows || "<tr><td colspan='5'>No release activity yet.</td></tr>"}</tbody></table>
    </section>
  `);
}

function checkboxes(name: string, values: string[], selected: string[]) {
  return values.map((value) => `
    <label class="check"><input type="checkbox" name="${name}" value="${value}" ${selected.includes(value) ? "checked" : ""}>${value}</label>
  `).join("");
}

function automation(data: any) {
  shell(`
    <form class="panel form" id="automation-form">
      <div class="form-row"><label><input type="checkbox" name="enabled" ${data.enabled ? "checked" : ""}> Automation enabled</label></div>
      <fieldset><legend>Eligible financial statuses</legend>${checkboxes("financialStatuses", ["pending", "unpaid", "partially_paid"], data.financialStatuses || [])}</fieldset>
      <label>Payment methods or gateway text<textarea name="paymentMethods">${(data.paymentMethods || []).join("\n")}</textarea></label>
      <label>Include tags<textarea name="includeTags">${(data.includeTags || []).join("\n")}</textarea></label>
      <label>Exclude tags<textarea name="excludeTags">${(data.excludeTags || []).join("\n")}</textarea></label>
      <label>Release delay<select name="releaseDelayMinutes">
        ${[[0, "Immediate"], [5, "5 minutes"], [15, "15 minutes"], [60, "1 hour"]].map(([value, label]) => `<option value="${value}" ${data.releaseDelayMinutes === value ? "selected" : ""}>${label}</option>`).join("")}
      </select></label>
      <label>Notification email<input name="notificationEmail" value="${data.notificationEmail || ""}" type="email"></label>
      <div class="actions"><button type="submit">Save settings</button></div>
    </form>
  `);
  document.querySelector<HTMLFormElement>("#automation-form")!.onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const lines = (name: string) => String(form.get(name) || "").split(/\n/).map((line) => line.trim()).filter(Boolean);
    await api("automation", {
      method: "PUT",
      body: JSON.stringify({
        enabled: form.get("enabled") === "on",
        financialStatuses: form.getAll("financialStatuses"),
        paymentMethods: lines("paymentMethods"),
        includeTags: lines("includeTags"),
        excludeTags: lines("excludeTags"),
        releaseDelayMinutes: Number(form.get("releaseDelayMinutes")),
        notificationEmail: form.get("notificationEmail") || null
      })
    });
    state.message = "Automation settings saved.";
    load("automation");
  };
}

function shipstation(data: any) {
  const savedCredentials = data.configured ? `
    <div class="credential-summary">
      <strong>Credentials saved securely</strong>
      <span>API key: ${data.apiKeyPreview || "saved"}</span>
      <span>API secret: saved securely and never displayed</span>
      <small>Entering a new API key and API secret will replace the saved credentials.</small>
    </div>
  ` : `
    <div class="credential-summary">
      <strong>No ShipStation credentials saved</strong>
      <span>Add your API key and API secret to enable releases.</span>
    </div>
  `;
  shell(`
    <section class="panel">
      <div class="split"><div><h2>Connection</h2><p>Status: <span class="status ${data.connectionStatus}">${data.connectionStatus}</span></p><p>Last success: ${data.lastSuccessAt ? new Date(data.lastSuccessAt).toLocaleString() : "-"}</p><p>${data.lastFailureReason || ""}</p></div></div>
      ${savedCredentials}
      <form class="form" id="shipstation-form">
        <label>API key<input name="apiKey" autocomplete="off" placeholder="${data.configured ? "Enter a new API key to replace saved credentials" : ""}" required></label>
        <label>API secret<input name="apiSecret" type="password" autocomplete="new-password" placeholder="${data.configured ? "Enter a new API secret to replace saved credentials" : ""}" required></label>
        <div class="actions"><button type="submit">${data.configured ? "Replace credentials" : "Save credentials"}</button><button type="button" id="test-connection">Test connection</button></div>
      </form>
    </section>
  `);
  document.querySelector<HTMLFormElement>("#shipstation-form")!.onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await api("shipstation", { method: "PUT", body: JSON.stringify({ apiKey: form.get("apiKey"), apiSecret: form.get("apiSecret") }) });
    state.message = "ShipStation credentials saved. The secret will not be displayed again.";
    load("shipstation");
  };
  document.querySelector<HTMLButtonElement>("#test-connection")!.onclick = async () => {
    await api("shipstation/test", { method: "POST" });
    state.message = "ShipStation connection test succeeded.";
    load("shipstation");
  };
}

function plans(data: any) {
  const planRows = Object.entries(data.plans || {}).map(([name, limit]) => `<tr><td>${name}</td><td>${limit} releases/month</td></tr>`).join("");
  const inactivePlan = !data.currentPlan || data.currentPlan === "unknown" || data.planStatus !== "active";
  const planNotice = inactivePlan ? `
    <div class="plan-notice">
      <strong>No active Shopify managed plan detected yet.</strong>
      <span>This can happen immediately after install or before selecting a plan.</span>
    </div>
  ` : "";
  shell(`
    <section class="panel">
      <h2>Managed Pricing</h2>
      ${planNotice}
      <p>Current plan: <strong>${data.currentPlan}</strong> (${data.planStatus})</p>
      <p>Usage this month: ${data.usage?.count || 0} / ${data.allowance || 0}</p>
      <table><tbody>${planRows}</tbody></table>
      <div class="actions"><button type="button" id="refresh-plan">Refresh plan status</button><a class="button" href="${data.manageUrl}" target="_top">Manage plan in Shopify</a></div>
    </section>
  `);
  document.querySelector<HTMLButtonElement>("#refresh-plan")!.onclick = async () => {
    await api("plans/refresh", { method: "POST" });
    state.message = "Plan status refreshed.";
    load("plans");
  };
}

function support(data: any) {
  const diag = data.diagnostics || {};
  shell(`
    <section class="panel">
      <h2>Support</h2>
      <p>When asking for help, include the Shopify order name, approximate release time, and any ShipStation order reference.</p>
      <p>Email: <a href="mailto:${data.supportEmail}">${data.supportEmail}</a></p>
      <dl>
        <dt>Shop domain</dt><dd>${diag.shopDomain}</dd>
        <dt>Plan</dt><dd>${diag.plan}</dd>
        <dt>ShipStation</dt><dd>${diag.shipStationConnectionStatus}</dd>
        <dt>Automation enabled</dt><dd>${diag.automationEnabled}</dd>
        <dt>Recent failures</dt><dd>${diag.recentFailureCount}</dd>
      </dl>
    </section>
  `);
}

async function load(tab: Tab) {
  state.tab = tab;
  shell(`<section class="panel">Loading...</section>`);
  try {
    const data = await api<any>(tab);
    state.data[tab] = data;
    if (tab === "dashboard") dashboard(data);
    if (tab === "automation") automation(data);
    if (tab === "shipstation") shipstation(data);
    if (tab === "plans") plans(data);
    if (tab === "support") support(data);
  } catch (error) {
    shell(`<section class="panel error">${error instanceof Error ? error.message : "Failed to load"}</section>`);
  }
}

load("dashboard");
