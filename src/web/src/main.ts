import shipreleaseLogoUrl from "./assets/shiprelease-logo.png";
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
    <div class="app-shell">
      <div class="topbar">
        <div class="brand-lockup">
          <img src="${shipreleaseLogoUrl}" alt="ShipRelease" class="brand-logo" />
          <div>
            <h1>ShipRelease</h1>
            <p>Automate unpaid order release into ShipStation</p>
          </div>
        </div>
        <span class="badge">Works with ShipStation</span>
      </div>
      <nav>${tabs.map((tab) => `<button class="${state.tab === tab.id ? "active" : ""}" data-tab="${tab.id}">${tab.label}</button>`).join("")}</nav>
      ${state.message ? `<div class="notice">${state.message}</div>` : ""}
      <main>${content}</main>
    </div>
  `;
  document.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((button) => {
    button.onclick = () => load(button.dataset.tab as Tab);
  });
}

function metric(label: string, value: string, sub = "") {
  return `<section class="metric"><i></i><span>${label}</span><strong>${value}</strong>${sub ? `<small>${sub}</small>` : ""}</section>`;
}

function primaryMetric(label: string, value: string, sub = "") {
  return `<section class="metric primary-metric"><span>${label}</span><strong>${value}</strong>${sub ? `<small>${sub}</small>` : ""}</section>`;
}

function summaryItem(label: string, value: string) {
  return `<section><span>${label}</span><strong>${value}</strong></section>`;
}

function statusBadge(status: string) {
  const label = status.replaceAll("_", " ");
  return `<span class="status ${status}">${label}</span>`;
}

function emptyState(title: string, detail: string) {
  return `<div class="empty-state"><i></i><strong>${title}</strong><span>${detail}</span></div>`;
}

function when(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString() : "No activity yet";
}

function compactWhen(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString() : "None recorded";
}

function pageIntro(title: string, detail: string) {
  return `<section class="page-intro"><div><h2>${title}</h2><p>${detail}</p></div></section>`;
}

function fieldHelp(text: string) {
  return `<span class="field-help">${text}</span>`;
}

function textareaLines(values: string[] | undefined) {
  return (values || []).join("\n");
}

function mailto(to: string, subject: string, body: string) {
  return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
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
  const shipstationStatus = data.shipstation?.connectionStatus || "missing";
  const waitingImports = (data.importWaitingJobs || []).length;
  const planActive = data.plan?.name && data.plan.name !== "unknown" && data.plan?.status === "active";
  shell(`
    <section class="ops-hero ${data.automation?.paused ? "paused" : "active"}">
      <div class="ops-hero-copy">
        <span class="eyebrow">Operations overview</span>
        <h2>${data.automation?.paused ? "Automation paused" : "Automation active"}</h2>
        <p>${data.automation?.paused ? "New releases are stopped. Queued work is deferred safely and audit logging stays active." : `ShipStation is ${shipstationStatus.replaceAll("_", " ")}. Eligible orders can be released automatically when rules match.`}</p>
      </div>
      <div class="ops-hero-actions">
        ${data.automation?.paused ? `<button class="primary" type="button" id="resume-automation">Automation active</button>` : `<button class="quiet" type="button" id="pause-automation">Pause all releases</button>`}
        <button class="secondary" type="button" id="run-reconciliation">Run reconciliation</button>
      </div>
    </section>
    <section class="panel setup-panel">
      <div class="panel-heading"><div><h2>Setup readiness</h2><p>Complete these steps to start releasing orders consistently.</p></div><strong>${data.onboarding?.percent || 0}%</strong></div>
      <div class="progress"><span style="width:${data.onboarding?.percent || 0}%"></span></div>
      ${!planActive ? `<div class="setup-callout"><span>Choose a plan to start releasing orders.</span><button class="secondary" type="button" id="dashboard-plans">View plans</button></div>` : ""}
      <ul class="checklist">${checklist}</ul>
    </section>
    <div class="grid metrics-grid overview-metrics">
      ${primaryMetric("Releases today", String(data.metrics?.releasesToday || 0), "Completed since midnight")}
      ${primaryMetric("Waiting for ShipStation", String(waitingImports), "Import wait jobs")}
      ${primaryMetric("Needs attention", String(data.metrics?.failedNeedsAttention || 0), "Failed releases")}
    </div>
    <div class="overview-summary">
      ${summaryItem("Last webhook", when(data.metrics?.lastWebhookReceivedAt))}
      ${summaryItem("Last release", compactWhen(data.metrics?.lastSuccessfulReleaseAt))}
      ${summaryItem("Plan usage", `${data.usage?.count || 0} / ${data.usage?.limit || 0}`)}
    </div>
    <section class="panel section-panel quiet-panel">
      <div class="panel-heading"><div><h2>Queue health</h2><p>Current queue state for release automation.</p></div>${statusBadge((data.metrics?.pendingQueueJobs || 0) > 0 ? "pending" : "success")}</div>
      <div class="queue-grid">
        ${metric("Waiting", String(queue.waiting || 0))}
        ${metric("Delayed", String(queue.delayed || 0))}
        ${metric("Active", String(queue.active || 0))}
        ${metric("Failed in queue", String(queue.failed || 0))}
      </div>
    </section>
    <section class="panel section-panel table-panel">
      <div class="panel-heading"><div><h2>Waiting for ShipStation import</h2><p>Orders found by Shopify that have not appeared in ShipStation yet.</p></div></div>
      ${importWaitingJobs ? `<table><thead><tr><th>Order</th><th>Lookups</th><th>Last checked</th><th>Next check</th><th>Timeout</th><th>Actions</th></tr></thead><tbody>${importWaitingJobs}</tbody></table>` : emptyState("No orders waiting for ShipStation import", "Import wait jobs appear here until ShipStation has imported the order or the wait times out.")}
    </section>
    <section class="panel section-panel table-panel">
      <div class="panel-heading"><div><h2>Failed releases requiring attention</h2><p>Manual retries create new queue jobs and preserve the original audit trail.</p></div></div>
      ${failedJobs ? `<table><thead><tr><th>Order</th><th>Failure</th><th>Attempts</th><th>Updated</th><th>Actions</th></tr></thead><tbody>${failedJobs}</tbody></table>` : emptyState("No failed releases requiring attention", "Failures that need operator action will appear here.")}
    </section>
    <section class="panel section-panel table-panel">
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
  document.querySelector<HTMLButtonElement>("#dashboard-plans")?.addEventListener("click", () => load("plans"));
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
    ${pageIntro("Automation rules", "Control which orders ShipRelease can release and when operators should be notified.")}
    <form class="form stacked-form" id="automation-form">
      <section class="panel form-card numbered-card">
        <div class="panel-heading"><div><h2>Automation status</h2><p>Turn release automation on or keep rules saved while disabled.</p></div>${statusBadge(data.enabled ? "active" : "inactive")}</div>
        <div class="check-grid">
          <label class="check"><input type="checkbox" name="enabled" ${data.enabled ? "checked" : ""}>Automation enabled</label>
        </div>
      </section>
      <section class="panel form-card numbered-card">
        <div class="panel-heading"><div><h2>Order eligibility</h2><p>Choose the order states and safeguards that must pass before queueing.</p></div></div>
        <fieldset><legend>Eligible financial statuses</legend><div class="check-grid">${checkboxes("financialStatuses", ["pending", "unpaid", "partially_paid"], data.financialStatuses || [])}</div></fieldset>
        <div class="check-grid">
          <label class="check"><input type="checkbox" name="releaseOnlyFullyPaid" ${data.releaseOnlyFullyPaid ? "checked" : ""}>Release only fully paid orders</label>
          <label class="check"><input type="checkbox" name="ignoreHighRiskOrders" ${data.ignoreHighRiskOrders ? "checked" : ""}>Ignore high risk orders</label>
          <label class="check"><input type="checkbox" name="requireManualReviewAboveAmount" ${data.requireManualReviewAboveAmount ? "checked" : ""}>Require manual review above amount</label>
        </div>
        <label>Manual review amount${fieldHelp("Orders above this total stay blocked when manual review is enabled.")}<input name="manualReviewAmount" value="${data.manualReviewAmount || 0}" type="number" min="0" step="0.01"></label>
      </section>
      <section class="panel form-card numbered-card wide-card">
        <div class="panel-heading"><div><h2>Payment methods and tags</h2><p>Match the gateway text and tags your Shopify operations team already uses.</p></div></div>
        <label>Payment methods or gateway text${fieldHelp("One per line. Example: Manual Payment, Bank Deposit, Net Terms.")}<textarea name="paymentMethods" placeholder="Manual Payment&#10;Bank Deposit&#10;Net Terms">${textareaLines(data.paymentMethods)}</textarea></label>
        <label>Include tags${fieldHelp("Optional. If set, an order must include at least one of these tags.")}<textarea name="includeTags" placeholder="wholesale&#10;approved-account">${textareaLines(data.includeTags)}</textarea></label>
        <label>Exclude tags${fieldHelp("One per line. Matching orders are ignored by automation.")}<textarea name="excludeTags" placeholder="fraud&#10;review&#10;sampleguard:hold">${textareaLines(data.excludeTags)}</textarea></label>
      </section>
      <section class="panel form-card numbered-card">
        <div class="panel-heading"><div><h2>Release timing</h2><p>Use delays when ShipStation or internal review workflows need a short buffer.</p></div></div>
        <div class="form-grid">
          <label>Rule engine delay minutes${fieldHelp("Additional delay before processing a matching order.")}<input name="delayMinutes" value="${data.delayMinutes || data.releaseDelayMinutes || 0}" type="number" min="0" max="1440"></label>
          <label>Release delay${fieldHelp("Preset queue delay for eligible releases.")}<select name="releaseDelayMinutes">
            ${[[0, "Immediate"], [5, "5 minutes"], [15, "15 minutes"], [60, "1 hour"]].map(([value, label]) => `<option value="${value}" ${data.releaseDelayMinutes === value ? "selected" : ""}>${label}</option>`).join("")}
          </select></label>
        </div>
      </section>
      <section class="panel form-card numbered-card">
        <div class="panel-heading"><div><h2>Notifications</h2><p>Send operational alerts without spamming repeated incidents.</p></div></div>
        <label>Notification email<input name="notificationEmail" value="${data.notificationEmail || ""}" type="email" placeholder="ops@example.com"></label>
        <fieldset><legend>Notify for</legend><div class="check-grid">
          <label class="check"><input type="checkbox" name="notifyAutomationPaused" ${data.notifyAutomationPaused ? "checked" : ""}>Automation paused</label>
          <label class="check"><input type="checkbox" name="notifyReconciliationFixes" ${data.notifyReconciliationFixes ? "checked" : ""}>Reconciliation queued fixes</label>
          <label class="check"><input type="checkbox" name="notifyRepeatedFailures" ${data.notifyRepeatedFailures ? "checked" : ""}>Repeated release failures</label>
          <label class="check"><input type="checkbox" name="notifyWebhookFailures" ${data.notifyWebhookFailures ? "checked" : ""}>Webhook processing failures</label>
        </div></fieldset>
        <div class="form-grid">
          <label>Repeated failure threshold<input name="repeatedFailureThreshold" value="${data.repeatedFailureThreshold || 3}" type="number" min="1" max="20"></label>
          <label>Notification debounce minutes<input name="notificationDebounceMinutes" value="${data.notificationDebounceMinutes || 60}" type="number" min="5" max="1440"></label>
        </div>
      </section>
      <div class="sticky-actions"><button class="primary" type="submit">Save settings</button></div>
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
  const preview = data.result?.shipStationPayloadPreview || { blocked: true };
  const previewRows = Object.entries(preview).map(([key, value]) => `
    <div><dt>${key.replaceAll("_", " ")}</dt><dd>${Array.isArray(value) ? value.join(", ") : String(value)}</dd></div>
  `).join("");
  const result = data.result ? `
    <section class="panel simulator-result result-card">
      <div class="panel-heading"><div><h2>Dry run result</h2><p>No ShipStation release call was made.</p></div>${statusBadge(data.result.decision === "would_release" ? "success" : "info")}</div>
      <dl class="result-grid">
        <div><dt>Webhook detected</dt><dd>${data.result.webhookDetected}</dd></div>
        <div><dt>Queue job created</dt><dd>${data.result.queueJobCreated}</dd></div>
        <div><dt>Decision</dt><dd>${data.result.decision.replace("_", " ")}</dd></div>
        <div><dt>Rule result</dt><dd>${data.result.ruleEvaluation.eligible && data.result.ruleEvaluation.foundation.passed ? "Passed" : data.result.ruleEvaluation.reason || "Blocked by rule foundation"}</dd></div>
      </dl>
      <h3>ShipStation preview</h3>
      <dl class="preview-grid">${previewRows}</dl>
    </section>
  ` : "";
  shell(`
    ${pageIntro("Release simulator", "Test an order against the current rule set without queueing a job or calling ShipStation.")}
    <section class="panel form-card">
      <div class="panel-heading"><div><h2>Dry run inputs</h2><p>Use a recent order shape or a hypothetical manual-payment order.</p></div>${statusBadge("dry run")}</div>
      <div class="reassurance"><i></i><span>No real release will be made and ShipStation will not be called.</span></div>
      <form class="form" id="simulator-form">
        <div class="form-grid">
          <label>Order number or ID<input name="orderId" required placeholder="#1001"></label>
          <label>Display name<input name="orderName" placeholder="#1001"></label>
          <label>Financial status<select name="financialStatus"><option value="pending">pending</option><option value="unpaid">unpaid</option><option value="paid">paid</option><option value="partially_paid">partially_paid</option></select></label>
          <label>Gateway<input name="gateway" value="Manual Payment"></label>
          <label>Tags<input name="tags" placeholder="wholesale, review"></label>
          <label>Total price<input name="totalPrice" value="0" type="number" min="0" step="0.01"></label>
          <label>Risk level<select name="riskLevel"><option value="low">low</option><option value="medium">medium</option><option value="high">high</option></select></label>
        </div>
        <div class="actions"><button class="primary" type="submit">Run dry run</button></div>
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
    <div class="credential-summary premium-summary">
      <div><strong>Credentials saved securely</strong><span>API key: ${data.apiKeyPreview || "saved"}</span></div>
      <div><strong>API secret</strong><span>Saved securely and never displayed</span></div>
    </div>
  ` : `
    <div class="credential-summary premium-summary">
      <div><strong>No ShipStation credentials saved</strong><span>Add your API key and API secret to enable releases.</span></div>
    </div>
  `;
  shell(`
    ${pageIntro("ShipStation connection", "Connect the ShipStation account that receives imported Shopify orders. Secrets are encrypted and never shown again.")}
    <section class="panel connection-card ${data.connectionStatus === "connected" ? "connected" : "attention"}">
      <div class="integration-mark"><i></i><span>ShipStation</span></div>
      <div class="panel-heading"><div><h2>Connection status</h2><p>Last success: ${data.lastSuccessAt ? new Date(data.lastSuccessAt).toLocaleString() : "No successful test recorded"}</p></div>${statusBadge(data.connectionStatus)}</div>
      ${data.lastFailureReason ? `<div class="inline-warning">${data.lastFailureReason}</div>` : ""}
      ${savedCredentials}
    </section>
    <section class="panel form-card">
      <div class="panel-heading"><div><h2>${data.configured ? "Replace credentials" : "Save credentials"}</h2><p>${data.configured ? "Enter both fields to replace the stored ShipStation credentials. Existing secrets are not displayed." : "Add API credentials from ShipStation to enable release automation."}</p></div></div>
      <div class="reassurance"><i></i><span>Credentials are stored encrypted. The API secret is never returned to this page.</span></div>
      <form class="form" id="shipstation-form">
        <label>API key<input name="apiKey" autocomplete="off" placeholder="${data.configured ? "Enter a new API key to replace saved credentials" : ""}" required></label>
        <label>API secret<input name="apiSecret" type="password" autocomplete="new-password" placeholder="${data.configured ? "Enter a new API secret to replace saved credentials" : ""}" required></label>
        <div class="actions"><button class="primary" type="submit">${data.configured ? "Replace credentials" : "Save credentials"}</button><button class="secondary" type="button" id="test-connection">Test connection</button></div>
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
  const benefits: Record<string, string> = {
    Starter: "For new stores validating manual-payment release automation.",
    Pro: "For growing teams with steady daily order operations.",
    Scale: "For high-volume teams that need more monthly capacity."
  };
  const planRows = Object.entries(data.plans || {}).map(([name, limit]) => `
    <section class="plan-card ${String(data.currentPlan || "").toLowerCase() === String(name).toLowerCase() ? "current" : ""}">
      <div class="plan-card-header"><span>${name}</span>${String(data.currentPlan || "").toLowerCase() === String(name).toLowerCase() ? `<em>Current plan</em>` : ""}</div>
      <strong>${Number(limit) === 0 ? "Custom" : Number(limit).toLocaleString()}</strong>
      <small>${Number(limit) === 0 ? "Contact support" : "releases/month"}</small>
      <p>${benefits[String(name)] || "Managed through Shopify pricing."}</p>
    </section>
  `).join("");
  const inactivePlan = !data.currentPlan || data.currentPlan === "unknown" || data.planStatus !== "active";
  const planNotice = inactivePlan ? `
    <div class="plan-notice">
      <strong>No active Shopify managed plan detected yet.</strong>
      <span>This can happen immediately after install or before selecting a plan in Shopify.</span>
    </div>
  ` : "";
  shell(`
    ${pageIntro("Managed pricing", "ShipRelease reads subscription status from Shopify Managed Pricing. Billing is managed in Shopify.")}
    <section class="panel plan-hero">
      <div class="panel-heading"><div><h2>Current plan</h2><p>Usage this month: ${data.usage?.count || 0} / ${data.allowance || 0}</p></div>${statusBadge(data.planStatus || "inactive")}</div>
      ${planNotice}
      <div class="plan-cta">
        <div>
          <strong>${inactivePlan ? "Choose a plan to activate ShipRelease" : `You're on ${data.currentPlan}`}</strong>
          <span>${inactivePlan ? "Select a Shopify Managed Pricing plan to start releasing orders." : "Manage billing, plan changes, and cancellation in Shopify."}</span>
          <small>You’ll be redirected to Shopify to confirm or manage your plan.</small>
        </div>
        <a class="button primary" href="${data.manageUrl}" target="_top" rel="noopener noreferrer">${inactivePlan ? "Choose a plan in Shopify" : "Manage plan in Shopify"}</a>
      </div>
      <div class="plan-grid">${planRows}</div>
      <div class="actions"><button class="secondary" type="button" id="refresh-plan">Refresh plan status</button></div>
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
  const supportEmail = "support@sample-guard.com";
  const shopDomain = diag.shopDomain || "unknown shop";
  const body = [
    "Store details:",
    `Shop domain: ${shopDomain}`,
    `Plan: ${diag.plan || "unknown"}`,
    `ShipStation connection: ${diag.shipStationConnectionStatus || "unknown"}`,
    `Automation enabled: ${diag.automationEnabled}`,
    `Recent failures: ${diag.recentFailureCount || 0}`,
    "",
    "Please add:",
    "Order number:",
    "ShipStation reference:",
    "Screenshot/details:"
  ].join("\n");
  const supportHref = mailto(supportEmail, `ShipRelease support request – ${shopDomain}`, body);
  const featureHref = mailto(supportEmail, `ShipRelease feature request – ${shopDomain}`, body);
  shell(`
    ${pageIntro("Support", "Get help with a release or share an idea for improving ShipRelease.")}
    <section class="panel support-card">
      <div class="panel-heading"><div><h2>How can we help?</h2><p>We include safe store details in the email so support can start with the right context.</p></div>${statusBadge(diag.automationEnabled ? "active" : "inactive")}</div>
      <div class="support-actions">
        <a class="button primary" href="${supportHref}" target="_blank" rel="noopener noreferrer">Contact support</a>
        <a class="button secondary" href="${featureHref}" target="_blank" rel="noopener noreferrer">Request a feature</a>
      </div>
      <dl class="support-summary">
        <div><dt>Shop domain</dt><dd>${diag.shopDomain}</dd></div>
        <div><dt>Plan</dt><dd>${diag.plan}</dd></div>
        <div><dt>ShipStation</dt><dd>${diag.shipStationConnectionStatus}</dd></div>
        <div><dt>Automation enabled</dt><dd>${diag.automationEnabled}</dd></div>
        <div><dt>Recent failures</dt><dd>${diag.recentFailureCount}</dd></div>
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
