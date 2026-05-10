import express from "express";

export const legalRouter = express.Router();

const supportEmail = "support@sample-guard.com";

function page(title: string, body: string) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} | ShipRelease</title>
<style>
body{
  margin:0;
  background:#f6f6f7;
  color:#202223;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  line-height:1.6;
}
main{
  max-width:860px;
  margin:0 auto;
  padding:48px 24px;
}
article{
  background:#fff;
  border:1px solid #dfe3e8;
  border-radius:12px;
  padding:32px;
}
h1{margin-top:0}
a{color:#008060}
.small{color:#6d7175}
</style>
</head>
<body>
<main>
<article>
${body}
</article>
</main>
</body>
</html>`;
}

legalRouter.get("/privacy", (_req, res) => {
  res.type("html").send(page("Privacy Policy", `
    <h1>Privacy Policy</h1>
    <p class="small">Last updated: ${new Date().toISOString().slice(0,10)}</p>

    <p>ShipRelease automates eligible unpaid and manual-payment order release workflows into ShipStation.</p>

    <h2>Information we process</h2>
    <p>ShipRelease may process store information, order identifiers, order status, tags, payment gateway text, operational audit events, app settings, and ShipStation connection details needed to provide the service.</p>

    <h2>Credential handling</h2>
    <p>ShipStation credentials are stored encrypted and are not displayed again after saving.</p>

    <h2>How information is used</h2>
    <p>Information is used to evaluate automation rules, process release actions, provide diagnostics, maintain audit history, and support merchants using the app.</p>

    <h2>Data sharing</h2>
    <p>ShipRelease only shares information with Shopify and ShipStation where necessary to provide app functionality. We do not sell merchant or customer data.</p>

    <h2>Security</h2>
    <p>Reasonable safeguards are used including webhook HMAC verification, Shopify session authentication, and restricted operational logging.</p>

    <h2>Contact</h2>
    <p>Privacy questions can be sent to <a href="mailto:${supportEmail}">${supportEmail}</a>.</p>
  `));
});

legalRouter.get("/terms", (_req, res) => {
  res.type("html").send(page("Terms of Service", `
    <h1>Terms of Service</h1>
    <p class="small">Last updated: ${new Date().toISOString().slice(0,10)}</p>

    <p>By using ShipRelease, you agree to use the app responsibly and only with systems and stores you are authorised to manage.</p>

    <h2>Service</h2>
    <p>ShipRelease automates release workflows for eligible unpaid and manual-payment orders based on merchant-configured rules.</p>

    <h2>Merchant responsibility</h2>
    <p>Merchants are responsible for validating automation rules, reviewing release activity, and maintaining ShipStation access.</p>

    <h2>Billing</h2>
    <p>ShipRelease uses Shopify Managed Pricing for plan selection, billing, cancellation, and upgrades.</p>

    <h2>Availability</h2>
    <p>Service availability may depend on Shopify, ShipStation, and network availability.</p>

    <h2>Support</h2>
    <p>Support requests can be sent to <a href="mailto:${supportEmail}">${supportEmail}</a>.</p>
  `));
});
