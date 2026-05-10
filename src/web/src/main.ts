import "./styles.css";

declare global {
  interface Window {
    shopify?: { idToken?: () => Promise<string> };
  }
}

type Tab = "dashboard" | "automation" | "shipstation" | "simulator" | "plans" | "support";

const state: { tab: Tab; data: Record<string, unknown>; message?: string } = {
  tab: "dashboard",
  data: {}
};

const tabs: Array<{ id: Tab; label: string }> = [
  { id: "dashboard", label: "Dashboard" },
  { id: "automation", label: "Automation" },
  { id: "shipstation", label: "ShipStation" },
  { id: "simulator", label: "Simulator" },
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

function statusBadge(status: string) {
  return `<span class="status ${status}">${status}</span>`;
}

function emptyState(title: string, detail: string) {
  return `<div class="empty-state"><strong>${title}</strong><span>${detail}</span></div>`;
}

function when(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString() : "No activity yet";
}

function dashboard(data: any) {
  const rows = (data.recentActivity || []).map((event: any) => `
    <tr>
      <td>${new Date(event.createdAt).toLocaleString()}</td>
      <td>${event.orderName || event.orderId}</td>
      <td>${event.eventType.replaceAll("_", " ")}</td>
      <td>${statusBadge(event.status)}</td>
      <td>${event.message}</td>
      <td class="row-actions">
        ${event.releaseJobId ? `<button type="button" data-release-detail="${event.releaseJobId}">Details</button>` : ""}
        ${event.canRetry ? `<button type="button" data-release-retry="${event.releaseJobId}">Retry</button>` : ""}
      </td>
    </tr>
  `).join("");
  const checklist = (data.onboarding?.checklist || []).map((item: any) => `
    <li class="${item.complete ? "complete" : ""}"><span>${item.complete ? "Done" : ""}</span>${item.label}</li>
  `).join("");
  const queue = data.metrics?.queueHealth || {};
  const failedJobs = (data.failedJobs || []).map((job: any) => `
    <tr>
      <td>${job.shopifyOrderName || job.shopifyOrderId}</td>
      <td>${job.failureReason || "Unknown failure"}</td>
      <td>${job.attempts || 0}</td>
      <td>${when(job.updatedAt)}</td>
      <td class="row-actions"><button type="button" data-release-detail="${job.id}">Details</button><button type="button" data-release-retry="${job.id}">Retry</button></td>
    </tr>
  `).join("");
  const importWaitingJobs = (data.importWaitingJobs || []).map((job: any) => `
    <tr>
      <td>${job.shopifyOrderName || job.shopifyOrderId}</td>
      <td>${job.shipstationLookupAttempts || 0}</td>
      <td>${when(job.lastShipstationLookupAt)}</td>
      <td>${when(job.nextShipstationLookupAt)}</td>
      <td>${when(job.shipstationImportWaitUntil)}</td>
      <td class="row-actions"><button type="button" data-release-detail="${job.id}">Details</button></td>
    </tr>
  `).join("");
  shell(`
    <section class="ops-banner ${data.automation?.paused ? "paused" : "active"}">
      <div>
        <strong>${data.automation?.paused ? "Automation paused" : "Automation active"}</strong>
        <span>${data.automation?.paused ? "No release jobs will be queued. Simulator and audit logging remain available." : "Release jobs can be queued when rules match."}</span>
      </div>
      <div class="actions">
        ${data.automation?.paused ? `<button type="button" id="resume-automation">Automation active</button>` : `<button type="button" id="pause-automation">Pause all releases</button>`}
        <button type="button" id="run-reconciliation">Run reconciliation</button>
      </div>
    </section>
    <div class="grid metrics-grid">
      ${metric("Releases today", String(data.metrics?.releasesToday || 0))}
      ${metric("Releases this month", String(data.metrics?.releasesThisMonth || 0))}
      ${metric("Failed releases", String(data.metrics?.failedReleases || 0))}
      ${metric("Pending queue jobs", String(data.metrics?.pendingQueueJobs || 0))}
      ${metric("Plan usage", `${data.usage?.count || 0} / ${data.usage?.limit || 0}`, data.usage?.month || "")}
      ${metric("Last webhook", when(data.metrics?.lastWebhookReceivedAt))}
      ${metric("Last release", when(data.metrics?.lastSuccessfulReleaseAt))}
      ${metric("Retries today", String(data.metrics?.retryCountToday || 0))}
      ${metric("Needs attention", String(data.metrics?.failedNeedsAttention || 0))}
    </div>
    <section class="panel">
      <div class="panel-heading"><div><h2>Queue health</h2><p>Current BullMQ and database queue state for release automation.</p></div>${statusBadge((data.metrics?.pendingQueueJobs || 0) > 0 ? "pending" : "success")}</div>
      <div class="queue-grid">
        ${metric("Waiting", String(queue.waiting || 0))}
        ${metric("Delayed", String(queue.delayed || 0))}
        ${metric("Active", String(queue.active || 0))}
        ${metric("Failed in queue", String(queue.failed || 0))}
      </div>
    </section>
    <section class="panel">
      <div class="panel-heading"><div><h2>Waiting for ShipStation import</h2><p>Orders found by Shopify that have not appeared in ShipStation yet.</p></div></div>
      ${importWaitingJobs ? `<table><thead><tr><th>Order</th><th>Lookups</th><th>Last checked</th><th>Next check</th><th>Timeout</th><th>Actions</th></tr></thead><tbody>${importWaitingJobs}</tbody></table>` : emptyState("No orders waiting for ShipStation import", "Import wait jobs appear here until ShipStation has imported the order or the wait times out.")}
    </section>
    <section class="panel">
      <div class="panel-heading"><div><h2>Failed releases requiring attention</h2><p>Manual retries create new queue jobs and preserve the original audit trail.</p></div></div>
      ${failedJobs ? `<table><thead><tr><th>Order</th><th>Failure</th><th>Attempts</th><th>Updated</th><th>Actions</th></tr></thead><tbody>${failedJobs}</tbody></table>` : emptyState("No failed releases requiring attention", "Failures that need operator action will appear here.")}
    </section>
    <section class="panel">
      <div class="panel-heading"><div><h2>Setup progress</h2><p>Complete these steps to start releasing orders consistently.</p></div><strong>${data.onboarding?.percent || 0}%</strong></div>
      <div class="progress"><span style="width:${data.onboarding?.percent || 0}%"></span></div>
      <ul class="checklist">${checklist}</ul>
    </section>
    <section class="panel">
      <div class="panel-heading"><div><h2>Recent Release Activity</h2><p>Latest 25 audit events across webhooks, queueing, releases, retries, and dry runs.</p></div></div>
      ${rows ? `<table><thead><tr><th>Timestamp</th><th>Order</th><th>Event type</th><th>Status</th><th>Message</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>` : emptyState("No release activity yet", "Activity appears here when Shopify sends order webhooks or when you run a simulator dry run.")}
    </section>
    <div id="release-detail"></div>
  `);
  document.querySelector<HTMLButtonElement>("#pause-automation")?.addEventListener("click", async () => {
    await api("automation/pause", { method: "POST" });
    state.message = "Automation paused. Release queueing is stopped.";
    load("dashboard");
  });
  document.querySelector<HTMLButtonElement>("#resume-automation")?.addEventListener("click", async () => {
    await api("automation/resume", { method: "POST" });
    state.message = "Automation resumed.";
    load("dashboard");
  });
  document.querySelector<HTMLButtonElement>("#run-reconciliation")?.addEventListener("click", async () => {
    state.message = "Reconciliation running.";
    shell(`<section class="panel skeleton"><span></span><span></span><span></span></section>`);
    const result = await api<any>("reconcile/recent-orders", { method: "POST" });
    state.message = `Reconciliation complete: ${result.scannedOrders} scanned, ${result.queuedFixes} queued fixes, ${result.ignoredOrders} ignored.`;
    load("dashboard");
  });
  document.querySelectorAll<HTMLButtonElement>("[data-release-retry]").forEach((button) => {
    button.onclick = async () => {
      await api(`releases/${button.dataset.releaseRetry}/retry`, { method: "POST" });
      state.message = "Manual retry queued when automation rules allowed it.";
      load("dashboard");
    };
  });
  document.querySelectorAll<HTMLButtonElement>("[data-release-detail]").forEach((button) => {
    button.onclick = () => showReleaseDetail(button.dataset.releaseDetail || "");
  });
}

async function showReleaseDetail(id: string) {
  const target = document.querySelector<HTMLDivElement>("#release-detail");
  if (!target) return;
  target.innerHTML = `<section class="panel skeleton"><span></span><span></span><span></span></section>`;
  const data = await api<any>(`releases/${id}`);
  const release = data.release || {};
  const timeline = (data.timeline || []).map((event: any) => `
    <li>
      <time>${when(event.createdAt)}</time>
      <strong>${event.eventType.replaceAll("_", " ")}</strong>
      <span>${statusBadge(event.status)} ${event.message}</span>
    </li>
  `).join("");
  target.innerHTML = `
    <section class="panel detail-panel">
      <div class="panel-heading"><div><h2>Release detail</h2><p>${release.orderName || release.orderId}</p></div>${statusBadge(release.status || "info")}</div>
      <dl>
        <dt>Queued</dt><dd>${when(release.queuedAt)}</dd>
        <dt>Released</dt><dd>${when(release.releasedAt)}</dd>
        <dt>Retry attempts</dt><dd>${release.retryAttempts || 0}</dd>
        <dt>Decision reason</dt><dd>${release.decisionReason || "Not recorded"}</dd>
        <dt>Failure reason</dt><dd>${release.failureReason || "None"}</dd>
        <dt>Lookup attempts</dt><dd>${release.shipstationLookupAttempts || 0}</dd>
        <dt>Last checked</dt><dd>${when(release.lastShipstationLookupAt)}</dd>
        <dt>Next check</dt><dd>${when(release.nextShipstationLookupAt)}</dd>
        <dt>Import timeout</dt><dd>${when(release.shipstationImportWaitUntil)}</dd>
        <dt>ShipStation candidates</dt><dd>${(release.lookupCandidates || []).join(", ") || "Not looked up yet"}</dd>
      </dl>
      <h3>Rule evaluation</h3>
      <pre>${JSON.stringify(release.ruleEvaluation || {}, null, 2)}</pre>
      <h3>Sanitized metadata</h3>
      <pre>${JSON.stringify(release.metadata || {}, null, 2)}</pre>
      <h3>Timeline</h3>
      ${timeline ? `<ol class="timeline">${timeline}</ol>` : emptyState("No timeline events", "Audit events for this release will appear here.")}
    </section>
  `;
}

function checkboxes(name: string, values: string[], selected: string[]) {
  return values.map((value) => `
    <label class="check"><input type="checkbox" name="${name}" value="${value}" ${selected.includes(value) ? "checked" : ""}>${value}</label>
  `).join("");
}

function automation(data: any) {
  shell(`
    <form class="panel form" id="automation-form">
      <h2>Automation rules</h2>
      <p class="helper">These settings are persisted now and structured so release conditions can expand without reworking the workflow.</p>
      <label class="check"><input type="checkbox" name="enabled" ${data.enabled ? "checked" : ""}>Automation enabled</label>
      <label class="check"><input type="checkbox" name="releaseOnlyFullyPaid" ${data.releaseOnlyFullyPaid ? "checked" : ""}>Release only fully paid orders</label>
      <label class="check"><input type="checkbox" name="ignoreHighRiskOrders" ${data.ignoreHighRiskOrders ? "checked" : ""}>Ignore high risk orders</label>
      <label class="check"><input type="checkbox" name="requireManualReviewAboveAmount" ${data.requireManualReviewAboveAmount ? "checked" : ""}>Require manual review above amount</label>
      <label>Manual review amount<input name="manualReviewAmount" value="${data.manualReviewAmount || 0}" type="number" min="0" step="0.01"></label>
      <label>Rule engine delay minutes<input name="delayMinutes" value="${data.delayMinutes || data.releaseDelayMinutes || 0}" type="number" min="0" max="1440"></label>
      <fieldset><legend>Eligible financial statuses</legend>${checkboxes("financialStatuses", ["pending", "unpaid", "partially_paid"], data.financialStatuses || [])}</fieldset>
      <label>Payment methods or gateway text<textarea name="paymentMethods">${(data.paymentMethods || []).join("\n")}</textarea></label>
      <label>Include tags<textarea name="includeTags">${(data.includeTags || []).join("\n")}</textarea></label>
      <label>Exclude tags<textarea name="excludeTags">${(data.excludeTags || []).join("\n")}</textarea></label>
      <label>Release delay<select name="releaseDelayMinutes">
        ${[[0, "Immediate"], [5, "5 minutes"], [15, "15 minutes"], [60, "1 hour"]].map(([value, label]) => `<option value="${value}" ${data.releaseDelayMinutes === value ? "selected" : ""}>${label}</option>`).join("")}
      </select></label>
      <label>Notification email<input name="notificationEmail" value="${data.notificationEmail || ""}" type="email"></label>
      <fieldset><legend>Operational notifications</legend>
        <label class="check"><input type="checkbox" name="notifyAutomationPaused" ${data.notifyAutomationPaused ? "checked" : ""}>Automation paused</label>
        <label class="check"><input type="checkbox" name="notifyReconciliationFixes" ${data.notifyReconciliationFixes ? "checked" : ""}>Reconciliation queued fixes</label>
        <label class="check"><input type="checkbox" name="notifyRepeatedFailures" ${data.notifyRepeatedFailures ? "checked" : ""}>Repeated release failures</label>
        <label class="check"><input type="checkbox" name="notifyWebhookFailures" ${data.notifyWebhookFailures ? "checked" : ""}>Webhook processing failures</label>
      </fieldset>
      <label>Repeated failure threshold<input name="repeatedFailureThreshold" value="${data.repeatedFailureThreshold || 3}" type="number" min="1" max="20"></label>
      <label>Notification debounce minutes<input name="notificationDebounceMinutes" value="${data.notificationDebounceMinutes || 60}" type="number" min="5" max="1440"></label>
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
        releaseOnlyFullyPaid: form.get("releaseOnlyFullyPaid") === "on",
        delayMinutes: Number(form.get("delayMinutes")),
        ignoreHighRiskOrders: form.get("ignoreHighRiskOrders") === "on",
        requireManualReviewAboveAmount: form.get("requireManualReviewAboveAmount") === "on",
        manualReviewAmount: Number(form.get("manualReviewAmount")),
        notificationEmail: form.get("notificationEmail") || null,
        notifyAutomationPaused: form.get("notifyAutomationPaused") === "on",
        notifyReconciliationFixes: form.get("notifyReconciliationFixes") === "on",
        notifyRepeatedFailures: form.get("notifyRepeatedFailures") === "on",
        notifyWebhookFailures: form.get("notifyWebhookFailures") === "on",
        repeatedFailureThreshold: Number(form.get("repeatedFailureThreshold")),
        notificationDebounceMinutes: Number(form.get("notificationDebounceMinutes"))
      })
    });
    state.message = "Automation settings saved.";
    load("automation");
  };
}

function simulator(data: any = {}) {
  const result = data.result ? `
    <section class="panel simulator-result">
      <div class="panel-heading"><div><h2>Dry run result</h2><p>No ShipStation release call was made.</p></div>${statusBadge(data.result.decision === "would_release" ? "success" : "info")}</div>
      <dl>
        <dt>Webhook detected</dt><dd>${data.result.webhookDetected}</dd>
        <dt>Queue job created</dt><dd>${data.result.queueJobCreated}</dd>
        <dt>Decision</dt><dd>${data.result.decision.replace("_", " ")}</dd>
        <dt>Rule result</dt><dd>${data.result.ruleEvaluation.eligible && data.result.ruleEvaluation.foundation.passed ? "Passed" : data.result.ruleEvaluation.reason || "Blocked by rule foundation"}</dd>
      </dl>
      <pre>${JSON.stringify(data.result.shipStationPayloadPreview || { blocked: true }, null, 2)}</pre>
    </section>
  ` : "";
  shell(`
    <section class="panel">
      <h2>Release Simulator</h2>
      <p class="helper">Run a dry release workflow for an order number or ID. This creates no real queue job and never calls ShipStation.</p>
      <form class="form" id="simulator-form">
        <label>Order number or ID<input name="orderId" required placeholder="#1001"></label>
        <label>Display name<input name="orderName" placeholder="#1001"></label>
        <label>Financial status<select name="financialStatus"><option value="pending">pending</option><option value="unpaid">unpaid</option><option value="paid">paid</option><option value="partially_paid">partially_paid</option></select></label>
        <label>Gateway<input name="gateway" value="Manual Payment"></label>
        <label>Tags<input name="tags" placeholder="wholesale, review"></label>
        <label>Total price<input name="totalPrice" value="0" type="number" min="0" step="0.01"></label>
        <label>Risk level<select name="riskLevel"><option value="low">low</option><option value="medium">medium</option><option value="high">high</option></select></label>
        <div class="actions"><button type="submit">Run dry run</button></div>
      </form>
    </section>
    ${result}
  `);
  document.querySelector<HTMLFormElement>("#simulator-form")!.onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const result = await api("simulator", {
      method: "POST",
      body: JSON.stringify({
        orderId: form.get("orderId"),
        orderName: form.get("orderName"),
        financialStatus: form.get("financialStatus"),
        gateway: form.get("gateway"),
        tags: form.get("tags"),
        totalPrice: Number(form.get("totalPrice")),
        riskLevel: form.get("riskLevel")
      })
    });
    state.message = "Dry run complete.";
    state.data.simulator = { result };
    simulator(state.data.simulator);
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
  if (tab === "simulator") {
    simulator(state.data.simulator);
    return;
  }
  shell(`<section class="panel skeleton"><span></span><span></span><span></span></section>`);
  try {
    const data = await api<any>(tab);
    state.data[tab] = data;
    if (tab === "dashboard") dashboard(data);
    if (tab === "automation") automation(data);
    if (tab === "shipstation") shipstation(data);
    if (tab === "simulator") simulator(data);
    if (tab === "plans") plans(data);
    if (tab === "support") support(data);
  } catch (error) {
    shell(`<section class="panel error">${error instanceof Error ? error.message : "Failed to load"}</section>`);
  }
}

load("dashboard");
