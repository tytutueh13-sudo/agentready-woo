// Server-rendered merchant app pages. Visual system matches the marketing
// landing exactly: Fraunces + Spline Sans + IBM Plex Mono, ink/paper/vermilion,
// numbered kickers, hairline borders. App UI calm: no decorative chrome.

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function jsValue(v: unknown): string {
  return JSON.stringify(v).replace(/</g, "\\u003c");
}

/** Fail-closed checkout config: paid buttons render as real Paddle.js
 * checkouts only when the client token is set (see checkoutConfig() in
 * app.ts) — otherwise every price renders as a disabled "Coming soon". */
export interface CheckoutConfig {
  clientToken: string;
  prices: { report?: string; pro?: string; agency?: string };
}

/** Wires already-rendered `id`d buttons to Paddle.js checkout. Self
 * contained (loads paddle.js + Initialize + click handlers) so each page
 * that has at least one live checkout button can append its own copy
 * without coordinating with other pages. */
function paddleCheckoutScript(clientToken: string, email: string, buttons: { id: string; priceId: string; plan: "report" | "pro" | "agency" }[]): string {
  if (!buttons.length) return "";
  const wiring = buttons.map((b) => `
  (function(){var btn=document.getElementById(${jsValue(b.id)});if(!btn)return;btn.addEventListener("click",function(){
    fetch("/dashboard/billing/checkout-started",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({plan:${jsValue(b.plan)}})}).catch(function(){});
    Paddle.Checkout.open({items:[{priceId:${jsValue(b.priceId)},quantity:1}],customer:{email:${jsValue(email)}},settings:{successUrl:location.origin+"/dashboard/billing?purchased=1"}});
  });})();`).join("\n");
  return `<script src="https://cdn.paddle.com/paddle/v2/paddle.js"></script>
<script>
(function(){
  if(!window.Paddle)return;
  Paddle.Initialize({token:${jsValue(clientToken)}});
  ${wiring}
})();
</script>`;
}

const CSS = `
:root{--paper:#FAF9F5;--ink:#17151C;--ink2:#55515E;--ink3:#747079;--line:#E5E2DB;--acc:#E4572E;--acc-dark:#C43F1B;--ok:#1F7A4D;--dark:#141218;--dark2:#1D1A24;
--serif:'Fraunces',Georgia,serif;--sans:'Spline Sans',system-ui,sans-serif;--mono:'IBM Plex Mono',monospace}
*{margin:0;padding:0;box-sizing:border-box}
html{background:var(--paper)}
body{background:var(--paper);color:var(--ink);font-family:var(--sans);font-size:16px;line-height:1.6;-webkit-font-smoothing:antialiased}
a{color:var(--ink2);text-decoration:none}a:hover{color:var(--ink)}
nav{background:var(--paper);border-bottom:1px solid var(--line)}
nav .in{max-width:1140px;margin:0 auto;padding:16px 32px;display:flex;align-items:center;justify-content:space-between}
.logo{display:flex;align-items:baseline;gap:8px;font-weight:600;font-size:16px;color:var(--ink)}
.logo .mark{font-family:var(--serif);font-style:italic;font-weight:600}
.logo .by{color:var(--ink3);font-weight:400;font-size:13px}
nav .links{display:flex;gap:24px;font-size:14px;align-items:center}
nav .links a{color:var(--ink2)}nav .links a:hover{color:var(--ink)}
nav .cta{color:var(--acc-dark);font-weight:600}
.wrap{max-width:1140px;margin:0 auto;padding:64px 32px 96px}
.narrow{max-width:560px}
.kicker{font-family:var(--mono);font-size:12px;color:var(--acc-dark);margin-bottom:14px}
.kicker .no{color:var(--ink3);margin-right:10px}
h1{font-family:var(--serif);font-weight:500;font-size:clamp(28px,3.6vw,40px);line-height:1.15;letter-spacing:-.01em;margin-bottom:8px;overflow-wrap:anywhere}
.lede{color:var(--ink2);font-size:17px;max-width:560px;margin-bottom:36px}
.card{background:#fff;border:1px solid var(--line);border-radius:8px;padding:28px;margin-bottom:18px}
/* Shown when a form is refused. #C43F1B on white is 4.89:1; the accent
   #E4572E is 3.5:1 and fails AA for body text, so the border carries the
   colour and the text does not. */
.notice{border-left:3px solid var(--acc-dark);background:#FCF2EE;color:var(--ink);padding:12px 16px;margin:0 0 18px;border-radius:0 6px 6px 0;font-size:15px}
.notice code{font-family:var(--mono);font-size:13px;color:#B33A18}
.btn:disabled{background:var(--ink3);cursor:not-allowed;transform:none;box-shadow:none}
.working{display:inline-block;margin-left:14px;color:var(--ink2);font-size:14px}
/* A check table is three columns of prose; below ~430px it is wider than
   the phone. Scroll the table, never the page. */
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
input[aria-invalid="true"]{border-color:var(--acc-dark);outline-color:var(--acc-dark)}
label{display:block;font-size:12.5px;font-weight:600;color:var(--ink2);margin:16px 0 5px}
input[type=text],input[type=email],input[type=password],input[type=url]{width:100%;min-height:44px;border:1px solid var(--line);border-radius:6px;padding:11px 13px;font-size:16px;font-family:var(--sans);background:#fff;color:var(--ink)}
input:focus{outline:none;border-color:var(--acc-dark)}
.btn:focus-visible,a:focus-visible,input:focus-visible{outline:3px solid rgba(228,87,46,.35);outline-offset:3px}
.btn{display:inline-block;background:var(--acc-dark);color:#fff;font-weight:600;font-size:15px;border:0;border-radius:6px;padding:13px 24px;cursor:pointer;text-decoration:none;font-family:var(--sans);transition:background .16s ease,transform .16s cubic-bezier(.2,.8,.2,1),box-shadow .16s ease}
.btn:hover{background:#A83615;color:#fff;text-decoration:none;transform:translateY(-1px);box-shadow:0 6px 16px rgba(196,63,27,.28)}
.btn-line{background:transparent;color:var(--ink);border:1px solid var(--ink);transition:background .16s ease,color .16s ease}
.btn-line:hover{background:var(--ink);color:#fff}
.btn:disabled{background:var(--ink3);color:#fff;cursor:default;opacity:.7}
.btn:disabled:hover{background:var(--ink3);transform:none;box-shadow:none}
.btn-line:disabled{background:transparent;color:var(--ink3);border-color:var(--ink3)}
.btn-line:disabled:hover{background:transparent;color:var(--ink3)}
.err{background:#FCEEE8;border-left:3px solid var(--acc);padding:10px 14px;margin-bottom:16px;font-size:14px;color:#7a2e12}
.ok{background:#EAF4EE;border-left:3px solid var(--ok);padding:10px 14px;margin-bottom:16px;font-size:14px;color:#14532d}
table{width:100%;border-collapse:collapse;font-size:14.5px}
th{text-align:left;font-family:var(--mono);font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink3);padding:8px 10px;border-bottom:1px solid var(--line);font-weight:500}
td{padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:0}
.pass{color:var(--ok);font-weight:600}.fail{color:var(--acc-dark);font-weight:600}
.mono{font-family:var(--mono);font-size:13px}
.kv{display:flex;justify-content:space-between;gap:12px;padding:11px 0;border-bottom:1px solid var(--line);font-size:14.5px;align-items:baseline}
.kv:last-child{border-bottom:0}
.kv .k{color:var(--ink2);flex:none;width:220px}
.kv .v{overflow-wrap:anywhere;text-align:right}
.score{font-family:var(--serif);font-size:72px;font-weight:500;line-height:1;color:var(--ink)}
.score span{font-size:26px;color:var(--ink3)}
.badge{display:inline-block;font-family:var(--mono);font-size:11px;letter-spacing:.08em;text-transform:uppercase;padding:3px 10px;border-radius:99px;border:1px solid var(--line);color:var(--ink2)}
.badge.pro{border-color:var(--acc-dark);color:var(--acc-dark)}
a.badge-link{transition:border-color .16s ease,color .16s ease}
a.badge-link:hover{border-color:var(--acc-dark);color:var(--acc-dark)}
.setup-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(260px,.56fr);gap:28px;align-items:start}
.setup-steps{display:flex;flex-direction:column;gap:14px}
.setup-step{background:#fff;border:1px solid var(--line);border-radius:8px;padding:24px;display:grid;grid-template-columns:38px minmax(0,1fr);gap:14px}
.step-no{width:32px;height:32px;border:1px solid var(--line);border-radius:50%;display:grid;place-items:center;font-family:var(--mono);font-size:11px;color:var(--ink3)}
.setup-step h2{font-family:var(--serif);font-size:21px;font-weight:500;line-height:1.25;margin:2px 0 7px}
.setup-step p{color:var(--ink2);font-size:14px;margin:0 0 12px}
.setup-step p:last-child{margin-bottom:0}
.setup-status{position:sticky;top:24px}
.status-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 0;border-bottom:1px solid var(--line);font-size:14px}
.status-row:last-child{border-bottom:0}.status-dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:7px;background:var(--ink3)}
.status-dot.okay{background:var(--ok)}.status-dot.wait{background:#C78316}
.connection-bundle{grid-column:1/-1;background:#F7F5EF;border:1px solid var(--line);border-radius:7px;padding:16px;margin-top:10px}
.connection-bundle label{margin-top:10px}.connection-bundle label:first-child{margin-top:0}
.copy-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center}
.copy-row input{font-family:var(--mono);font-size:12px;min-width:0}
.copy-btn{min-width:74px;min-height:44px;padding:11px 14px}
.setup-note{font-size:12.5px!important;color:var(--ink3)!important}
code{background:#f0efea;padding:.1rem .35rem;border-radius:4px;font-size:13px}
.foot{max-width:1140px;margin:0 auto;padding:0 32px 64px;color:var(--ink3);font-size:13px}

/* ── upgrade / upsell card: the free -> paid conversion moment ────────
   Every free-tier "you're capped" touchpoint (dashboard nudge, billing
   page, post-scan upsell) shares this one component so the pitch reads
   the same wherever it's hit. */
.score-card .badge{color:#F2EFF6;border-color:#4A4553}
.upsell{background:var(--dark);border-color:var(--dark);color:#fff;animation:card-in .4s cubic-bezier(.2,.8,.2,1)}
.upsell .kicker{color:#FF8A63}
.upsell h2,.upsell strong.headline{font-family:var(--serif);font-size:21px;font-weight:500;color:#fff;display:block;margin-bottom:8px}
.upsell p{color:#A9A5B5}
.upsell-benefits{list-style:none;margin:14px 0 20px;padding:14px 0 0;border-top:1px solid #322E3B;display:flex;flex-direction:column;gap:8px}
.upsell-benefits li{display:flex;align-items:flex-start;gap:9px;font-size:13.5px;color:#D8D5DE}
.upsell-benefits li span{flex:0 0 auto;width:16px;height:16px;display:grid;place-items:center;border-radius:50%;background:rgba(31,122,77,.22);color:#9AE7C1;font-size:10px;font-weight:700;margin-top:1px}
.btn-pulse{animation:cta-pulse 1.8s ease-out .6s 2}
@keyframes card-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@keyframes cta-pulse{0%,100%{box-shadow:none}50%{box-shadow:0 0 0 6px rgba(228,87,46,.22)}}
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:.01ms !important;animation-iteration-count:1 !important;transition-duration:.01ms !important}
}
@media (max-width:640px){
  nav .in{flex-wrap:wrap;row-gap:10px;padding:14px 20px}
  .logo{font-size:15px}
  .logo .by{display:none}
  nav .links{width:100%;justify-content:flex-end;flex-wrap:wrap;column-gap:16px;row-gap:6px;font-size:13px}
  .wrap{padding:40px 20px 64px}
  .foot{padding:0 20px 40px}
  .score{font-size:52px}
  .kv{flex-wrap:wrap;row-gap:4px}
  .kv .k{width:100%}
  .kv .v{text-align:left}
  .setup-grid{grid-template-columns:1fr}.setup-status{position:static;order:-1}.setup-step{padding:20px 16px;grid-template-columns:32px minmax(0,1fr);gap:10px}
  .copy-row{grid-template-columns:1fr}.copy-btn{width:100%}
}
`;

export function layout(title: string, body: string, navRight = ""): string {
  const right = navRight || `<a href="/scan" class="cta">Free scan</a>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} — AgentReady</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta property="og:type" content="website">
<meta property="og:site_name" content="AgentReady / Woo">
<meta property="og:title" content="${escapeHtml(title)} — AgentReady">
<meta property="og:description" content="Makes self-hosted WooCommerce stores readable and buyable by AI shopping agents — one plugin, five minutes.">
<meta property="og:image" content="https://app.utilityhouse.xyz/og-image.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Spline+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head>
<body>
<nav><div class="in">
  <a class="logo" href="/"><span class="mark">AgentReady</span> <span class="by">/ Woo</span></a>
  <div class="links">${right}</div>
</div></nav>
<div class="wrap">${body}</div>
<div class="foot">© 2026 AgentReady — a UtilityHouse product · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="/refund-policy">Refund Policy</a></div>
</body>
</html>`;
}

const AUTH_NAV = `<a href="/scan">Free scan</a>`;

const GOOGLE_BTN = `<a class="btn btn-line" href="/auth/google/start" style="display:flex;align-items:center;justify-content:center;gap:10px;width:100%">
<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
Continue with Google</a>`;

export function signupPage(error = "", email = "", googleEnabled = false): string {
  return layout("Create your account", `
<div class="narrow" style="margin:0 auto">
<div class="kicker"><span class="no">01</span>Account</div>
<h1>Create your account</h1>
<p class="lede">Free scan forever. Your top 25 products live as agent offers.</p>
${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
${googleEnabled ? `<div style="margin-bottom:16px">${GOOGLE_BTN}</div>
<div style="display:flex;align-items:center;gap:12px;color:var(--ink3);font-size:12px;font-family:var(--mono);letter-spacing:.08em;margin-bottom:16px"><span style="flex:1;height:1px;background:var(--line)"></span>OR WITH EMAIL<span style="flex:1;height:1px;background:var(--line)"></span></div>` : ""}
<div class="card">
<form method="post" action="/signup">
<label for="email">Work email</label>
<input type="email" id="email" name="email" required value="${escapeHtml(email)}" autocomplete="email">
<label for="password">Password (8+ characters)</label>
<input type="password" id="password" name="password" required minlength="8" autocomplete="new-password">
<label style="display:flex;gap:9px;align-items:flex-start;font-size:13.5px;color:var(--ink2);margin-top:16px;font-weight:400">
<input type="checkbox" name="accept_terms" required style="margin-top:3px">
<span>I agree to the <a href="/terms" style="color:var(--acc-dark)">Terms</a> and <a href="/privacy" style="color:var(--acc-dark)">Privacy Policy</a>.</span></label>
<p style="margin:20px 0 0"><button class="btn" type="submit">Create account</button></p>
</form>
</div>
<p>Already have an account? <a href="/login" style="color:var(--acc-dark)">Log in</a></p>
</div>`, AUTH_NAV);
}

export function loginPage(error = "", email = "", googleEnabled = false): string {
  return layout("Log in", `
<div class="narrow" style="margin:0 auto">
<div class="kicker"><span class="no">01</span>Account</div>
<h1>Log in</h1>
<p class="lede">Your stores, agent traffic and endpoints.</p>
${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
${googleEnabled ? `<div style="margin-bottom:16px">${GOOGLE_BTN}</div>
<div style="display:flex;align-items:center;gap:12px;color:var(--ink3);font-size:12px;font-family:var(--mono);letter-spacing:.08em;margin-bottom:16px"><span style="flex:1;height:1px;background:var(--line)"></span>OR WITH EMAIL<span style="flex:1;height:1px;background:var(--line)"></span></div>` : ""}
<div class="card">
<form method="post" action="/login">
<label for="email">Email</label>
<input type="email" id="email" name="email" required value="${escapeHtml(email)}" autocomplete="email">
<label for="password">Password</label>
<input type="password" id="password" name="password" required autocomplete="current-password">
<p style="margin:20px 0 0"><button class="btn" type="submit">Log in</button></p>
</form>
</div>
<p>New here? <a href="/signup" style="color:var(--acc-dark)">Create an account</a> — the scan is free forever.</p>
<p style="margin-top:6px"><a href="/forgot-password" style="color:var(--ink3);font-size:14px">Forgot your password?</a></p>
</div>`, AUTH_NAV);
}

export function forgotPasswordPage(sent = false, error = "", email = ""): string {
  return layout("Reset your password", `
<div class="narrow" style="margin:0 auto">
<div class="kicker"><span class="no">01</span>Account</div>
<h1>Reset your password</h1>
<p class="lede">Enter the email on your account and we'll send a link to choose a new password.</p>
${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
${sent
    ? `<div class="ok">If that email has an AgentReady account, a reset link is on its way. It expires in 1 hour.</div>`
    : `<div class="card">
<form method="post" action="/forgot-password">
<label for="email">Email</label>
<input type="email" id="email" name="email" required value="${escapeHtml(email)}" autocomplete="email">
<p style="margin:20px 0 0"><button class="btn" type="submit">Send reset link</button></p>
</form>
</div>`}
<p><a href="/login" style="color:var(--acc-dark)">← Back to log in</a></p>
</div>`, AUTH_NAV);
}

export function resetPasswordPage(token: string, error = ""): string {
  return layout("Choose a new password", `
<div class="narrow" style="margin:0 auto">
<div class="kicker"><span class="no">01</span>Account</div>
<h1>Choose a new password</h1>
${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
<div class="card">
<form method="post" action="/reset-password">
<input type="hidden" name="token" value="${escapeHtml(token)}">
<label for="password">New password (8+ characters)</label>
<input type="password" id="password" name="password" required minlength="8" autocomplete="new-password">
<p style="margin:20px 0 0"><button class="btn" type="submit">Set new password</button></p>
</form>
</div>
</div>`, AUTH_NAV);
}

export function resetLinkExpiredPage(): string {
  return layout("Reset link expired", `
<div class="narrow" style="margin:0 auto">
<div class="kicker"><span class="no">01</span>Account</div>
<h1>This link has expired.</h1>
<p class="lede">Password reset links work once and expire after an hour. Request a new one below.</p>
<p><a class="btn" href="/forgot-password">Request a new link</a></p>
</div>`, AUTH_NAV);
}

const APP_NAV = (email: string) => `<span style="color:var(--ink3);font-size:13.5px">${escapeHtml(email)}</span><a href="/dashboard/account">Account</a><a href="/dashboard/billing">Billing</a><a href="/logout">Log out</a>`;

/** `upgradeNudge` is only non-empty when at least one store is on the free
 * plan — a Pro account never sees its own pitch reflected back at it. */
export function dashboardPage(email: string, storesHtml: string, addStoreCta: string, upgradeNudge = "", checkout: CheckoutConfig | null = null): string {
  const script = upgradeNudge && checkout?.prices.pro
    ? paddleCheckoutScript(checkout.clientToken, email, [{ id: "paddle-pro-btn", priceId: checkout.prices.pro, plan: "pro" }])
    : "";
  return layout("Dashboard", `
<div class="kicker"><span class="no">02</span>Your stores</div>
<h1>Agent traffic, live.</h1>
<p class="lede">Endpoints agents read, requests they made, and what each store is worth to them.</p>
${upgradeNudge}
${storesHtml}
${addStoreCta}
${script}
`, APP_NAV(email));
}

export function storeCard(store: { id: string; name: string; storeUrl: string; plan: string; publicBaseUrl: string; agentHits: number }): string {
  const planBadge = store.plan === "free"
    ? `<a class="badge badge-link" href="/dashboard/billing">Free · top 25 products</a>`
    : `<span class="badge pro">${escapeHtml(store.plan)}</span>`;
  return `
<div class="card">
<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:12px">
<strong style="font-family:var(--serif);font-size:21px;font-weight:500">${escapeHtml(store.name)}</strong> ${planBadge}
</div>
<div class="kv"><span class="k">Store</span><span class="v">${escapeHtml(store.storeUrl)}</span></div>
<div class="kv"><span class="k">Agent feed</span><span class="v mono">${escapeHtml(store.publicBaseUrl)}/feed/${escapeHtml(store.id)}</span></div>
<div class="kv"><span class="k">MCP endpoint</span><span class="v mono">${escapeHtml(store.publicBaseUrl)}/mcp/${escapeHtml(store.id)}</span></div>
<div class="kv"><span class="k">Agent requests · 30 days</span><span class="v"><strong style="font-family:var(--serif);font-size:19px">${store.agentHits}</strong></span></div>
<p style="margin:16px 0 0"><a class="btn btn-line" href="/dashboard/store/${escapeHtml(store.id)}">Manage</a>
<a class="btn btn-line" href="/dashboard/store/${escapeHtml(store.id)}/release-gate" style="margin-left:8px">Set up Release Gate</a>
<a class="btn btn-line" href="/scan" style="margin-left:8px">Re-scan</a></p>
</div>`;
}

export interface ReleaseConnectionBundleView {
  endpoint: string;
  storeId: string;
  ownershipKey: string;
  evidenceKey: string;
}

export function releaseGateSetupPage(input: {
  store: { id: string; name: string; storeUrl: string };
  email: string;
  ownershipVerified: boolean;
  evidenceReceived: boolean;
  bundle?: ReleaseConnectionBundleView;
  error?: string;
}): string {
  const { store, email, ownershipVerified, evidenceReceived, bundle, error = "" } = input;
  const field = (id: string, label: string, value: string, secret = false) => `<label for="${id}">${label}</label>
<div class="copy-row"><input id="${id}" type="${secret ? "password" : "text"}" readonly autocomplete="off" spellcheck="false" value="${escapeHtml(value)}"><button class="btn btn-line copy-btn" type="button" data-copy="${id}">Copy</button></div>`;
  const bundleHtml = bundle ? `<div class="connection-bundle" aria-labelledby="connection-bundle-title">
<strong id="connection-bundle-title">Connection bundle</strong>
<p class="setup-note">Visible only in this authenticated, no-store response. Paste it into WooCommerce → AgentReady; never email or commit these values.</p>
${field("bundle-endpoint", "Worker URL", bundle.endpoint)}
${field("bundle-store-id", "Store ID", bundle.storeId)}
${field("bundle-ownership", "Ownership key", bundle.ownershipKey, true)}
${field("bundle-evidence", "Evidence key", bundle.evidenceKey, true)}
<p style="margin:14px 0 0"><button class="btn btn-line" type="button" id="toggle-secrets">Show or hide keys</button></p>
</div>` : "";
  const status = (okay: boolean, yes: string, no: string) => `<span><span class="status-dot ${okay ? "okay" : "wait"}"></span>${okay ? yes : no}</span>`;
  const script = `<script>
(function(){
  document.querySelectorAll("[data-copy]").forEach(function(button){button.addEventListener("click",async function(){
    var field=document.getElementById(button.getAttribute("data-copy"));if(!field)return;
    try{await navigator.clipboard.writeText(field.value);button.textContent="Copied";setTimeout(function(){button.textContent="Copy"},1400);}catch(_){field.type="text";field.select();}
  });});
  var toggle=document.getElementById("toggle-secrets");if(toggle)toggle.addEventListener("click",function(){
    ["bundle-ownership","bundle-evidence"].forEach(function(id){var field=document.getElementById(id);if(field)field.type=field.type==="password"?"text":"password";});
  });
  var verify=document.getElementById("verify-ownership"),message=document.getElementById("verify-message");
  if(verify)verify.addEventListener("click",async function(){
    verify.disabled=true;message.textContent="Checking the public proof…";
    try{
      var issued=await fetch(${jsValue(`/api/v2/stores/${store.id}/ownership-challenges`)},{method:"POST"});if(!issued.ok)throw new Error("challenge");var c=await issued.json();
      var proof=await fetch(${jsValue(`${store.storeUrl}/.well-known/agentready-ownership`)}+"?challenge="+encodeURIComponent(c.challenge),{credentials:"omit"});if(!proof.ok)throw new Error("proof");var p=await proof.json();
      var checked=await fetch(${jsValue(`/api/v2/stores/${store.id}/ownership-challenges/`)}+encodeURIComponent(c.challenge_id)+"/verify",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({challenge:c.challenge,proof:p.proof})});if(!checked.ok)throw new Error("verify");
      message.textContent="Ownership verified. Refreshing status…";location.reload();
    }catch(_){message.textContent="Could not verify yet. Save the bundle in WordPress, then try again.";verify.disabled=false;}
  });
})();
</script>`;
  return layout("Set up Release Gate", `
<div class="kicker"><span class="no">04</span>Owned-store verification</div>
<h1>Connect ${escapeHtml(store.name)}.</h1>
<p class="lede">Four small steps. The plugin sends counts and pass/fail states only—never customers, orders, payment details or product content.</p>
${error ? `<div class="err" role="alert">${escapeHtml(error)}</div>` : ""}
<div class="setup-grid">
  <div class="setup-steps">
    <section class="setup-step"><span class="step-no">1</span><div><h2>Install the plugin</h2><p>In WordPress, open Plugins → Add New → Upload Plugin, then activate AgentReady Woo.</p><a class="btn btn-line" href="/downloads/agentready-woo.zip" download>Download plugin (.zip)</a></div></section>
    <section class="setup-step"><span class="step-no">2</span><div><h2>Open your connection bundle</h2><p>The two keys are derived for this store and are never written to the account database.</p><form method="post" action="/dashboard/store/${escapeHtml(store.id)}/release-gate"><button class="btn" type="submit">${bundle ? "Open bundle again" : "Open connection bundle"}</button></form>${bundleHtml}</div></section>
    <section class="setup-step"><span class="step-no">3</span><div><h2>Paste and send a test</h2><p>In WooCommerce → AgentReady, paste all four values, save, then choose “Send aggregate evidence now.”</p><p class="setup-note">The signed packet contains only a Woo readiness state and product count. It cannot create carts, orders or payments.</p></div></section>
    <section class="setup-step"><span class="step-no">4</span><div><h2>Verify this store</h2><p>We ask your public plugin for one short-lived proof. No WordPress login or customer data is read.</p><button class="btn" type="button" id="verify-ownership">Verify connection</button><p id="verify-message" class="setup-note" role="status" aria-live="polite" style="margin-top:10px"></p></div></section>
  </div>
  <aside class="card setup-status" aria-label="Connection status">
    <strong style="font-family:var(--serif);font-size:21px;font-weight:500">Connection status</strong>
    <div class="status-row"><span>Store account</span>${status(true, "Connected", "Not connected")}</div>
    <div class="status-row"><span>Ownership</span>${status(ownershipVerified, "Verified", "Waiting")}</div>
    <div class="status-row"><span>Signed evidence</span>${status(evidenceReceived, "Received", "Waiting")}</div>
    <p class="setup-note" style="margin-top:14px">Settlement is disabled. Completing this setup does not charge you or move funds.</p>
    <p style="margin:14px 0 0"><a href="/dashboard">← Back to dashboard</a></p>
  </aside>
</div>${script}`, APP_NAV(email));
}

export function storeFormPage(
  error: string, values: { id?: string; name: string; storeUrl: string; consumerKey: string },
  mode: "create" | "edit", email: string,
): string {
  const action = mode === "edit" && values.id ? `/dashboard/store/${escapeHtml(values.id)}` : "/dashboard/store";
  const isEdit = mode === "edit";
  // The secret is never echoed back (it's a secret) — on edit, requiring it
  // on every save would force digging it back out of WooCommerce just to
  // fix a typo in the name or URL. Empty means "keep the current one".
  const secretField = isEdit
    ? `<label for="consumer_secret">Consumer secret (cs_...)</label>
<input type="password" id="consumer_secret" name="consumer_secret" autocomplete="off" placeholder="Leave blank to keep the current secret">`
    : `<label for="consumer_secret">Consumer secret (cs_...)</label>
<input type="password" id="consumer_secret" name="consumer_secret" required autocomplete="off">`;
  return layout(isEdit ? "Manage store" : "Connect a store", `
<div class="narrow" style="margin:0 auto">
<div class="kicker"><span class="no">03</span>Connection</div>
<h1>${isEdit ? "Manage store" : "Connect a store"}</h1>
<p class="lede">Read-only WooCommerce REST keys. You issue them in your own admin and revoke in one click — AgentReady reads your catalog, never writes.</p>
${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
<div class="card">
<form method="post" action="${action}">
<label for="name">Store name</label>
<input type="text" id="name" name="name" required maxlength="80" value="${escapeHtml(values.name)}" placeholder="NorthWind Wool">
<label for="store_url">Store URL</label>
<input type="url" id="store_url" name="store_url" required value="${escapeHtml(values.storeUrl)}" placeholder="https://yourstore.com">
<label for="consumer_key">Consumer key (ck_...)</label>
<input type="text" id="consumer_key" name="consumer_key" required value="${escapeHtml(values.consumerKey)}" autocomplete="off">
${secretField}
<p style="margin:20px 0 0"><button class="btn" type="submit">${isEdit ? "Save" : "Connect store"}</button>
<a class="btn btn-line" href="/dashboard" style="margin-left:8px">Cancel</a></p>
</form>
</div>
<p class="sub" style="color:var(--ink3);font-size:13px">Keys are encrypted at rest (AES-GCM) and used only to read your catalog.</p>
</div>`, APP_NAV(email));
}

/** Shared free -> Pro pitch, used on the billing page and (compact) on the
 * dashboard. `eyebrow` lets each call site frame the same offer for its own
 * moment ("you're capped right now" vs. a standing reminder) without
 * duplicating the benefits list or the pulse-CTA treatment. */
export function proUpgradeCard(eyebrow: string, headline: string, checkout: CheckoutConfig | null): string {
  const cta = checkout?.prices.pro
    ? `<button class="btn btn-pulse" type="button" id="paddle-pro-btn">Unlock Pro — $49 once</button>`
    : `<button class="btn btn-pulse" type="button" disabled title="Payments are being set up — check back soon.">Unlock Pro — $49 once</button>`;
  return `
<div class="card upsell">
<div class="kicker">${escapeHtml(eyebrow)}</div>
<strong class="headline">${escapeHtml(headline)}</strong>
<p>One payment, no renewal — nothing to cancel later.</p>
<ul class="upsell-benefits">
<li><span>✓</span>Unlimited offers — the free plan shows only your top 25</li>
<li><span>✓</span>Signed cart handoff, so agents can actually check out</li>
<li><span>✓</span>Weekly agent-activity digest by email</li>
</ul>
${cta}
</div>`;
}

export function billingPage(
  plan: string, email: string, checkout: CheckoutConfig | null,
  billingEvents: { eventType: string; plan: string | null; amount: string | null; currency: string | null; occurredAt: number }[] = [],
  reports: { id: string; purchasedAt: number; expiresAt: number; fulfilledAt: number | null; reportHtml: string | null }[] = [],
): string {
  // The Commerce Readiness Packet is fulfilled off the buyer's account — see
  // settleOwedReport() in webhooks.ts. That only works once we know which
  // account is buying, which is why this checkout only appears here
  // (logged in), never as a self-serve link on the public landing page.
  //
  // Everything a buyer paid for is listed on this page on purpose. A packet
  // used to be a single email and nothing else: come back a week later and
  // the product had no memory of the $9. Purchases and their delivery state
  // now live here, and a delivered report is re-readable in place.
  const reportLink = checkout?.prices.report
    ? `<button class="btn btn-line" type="button" id="paddle-report-btn">Commerce Readiness Packet — $9</button>`
    : `<button class="btn btn-line" type="button" disabled title="Payments are being set up — check back soon.">Commerce Readiness Packet — $9</button>`;
  // Pro is a one-time purchase — nothing recurs, so there's no Paddle
  // subscription to "manage" once it's active. Agency is still a real
  // subscription (it bundles ongoing priority support), so that message
  // stays accurate only for Agency.
  // Rendered only when the operator has actually configured the price. A
  // button that cannot open a checkout is the same failure as no button, with
  // a worse ending — so an unconfigured plan says so instead.
  const agencyLink = checkout?.prices.agency
    ? `<button class="btn btn-line" type="button" id="paddle-agency-btn">Agency — $99/year, 25 client stores</button>`
    : `<button class="btn btn-line" type="button" disabled title="Agency billing is being set up — check back soon.">Agency — $99/year, 25 client stores</button>`;

  const upgrade = plan === "free"
    ? `${proUpgradeCard("Upgrade", "Unlock unlimited offers.", checkout)}
       <div class="card"><p style="margin:0">Also available: ${reportLink}</p></div>
       <div class="card"><p style="margin:0">Running client stores? ${agencyLink}</p></div>`
    : plan === "pro"
    ? `<div class="ok">Pro is unlocked on your account — permanently, no subscription to manage. Check your email for the receipt.</div>
       <div class="card"><p style="margin:0">Running client stores? ${agencyLink}</p></div>`
    : `<div class="ok">Your plan is active: ${escapeHtml(plan)}. Manage payments via Paddle — check your email for the receipt and management link.</div>`;
  const fmtDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const reportsCard = reports.length ? `<div class="card">
<div class="kv"><span class="k"><strong>Commerce Readiness Packets you've bought</strong></span><span class="v"></span></div>
${reports.map(r => {
    if (r.fulfilledAt && r.reportHtml) {
      return `<div class="kv"><span class="k">Bought ${fmtDay(r.purchasedAt)} · delivered ${fmtDay(r.fulfilledAt)}</span>` +
        `<span class="v"><a href="/dashboard/reports/${escapeHtml(r.id)}">Read it →</a></span></div>`;
    }
    const expired = r.expiresAt <= Date.now();
    return `<div class="kv"><span class="k">Bought ${fmtDay(r.purchasedAt)}</span><span class="v">` +
      (expired
        ? `Claim expired ${fmtDay(r.expiresAt)} — email us and we'll sort it`
        : `Waiting on your first scan · claim valid until ${fmtDay(r.expiresAt)}`) +
      `</span></div>`;
  }).join("")}
</div>` : "";
  const historyCard = billingEvents.length ? `<div class="card">
<div class="kv"><span class="k"><strong>Payment history</strong></span><span class="v"></span></div>
${billingEvents.map(e => {
    const label = BILLING_EVENT_LABEL[e.eventType] ?? e.eventType;
    const amount = e.amount ? `${escapeHtml(e.currency ?? "")} ${escapeHtml(e.amount)}`.trim() : "—";
    return `<div class="kv"><span class="k">${fmtDay(e.occurredAt)} · ${escapeHtml(label)}</span>` +
      `<span class="v">${amount}</span></div>`;
  }).join("")}
</div>` : "";
  const buttons: { id: string; priceId: string; plan: "report" | "pro" | "agency" }[] = [];
  if (plan === "free" && checkout?.prices.pro) buttons.push({ id: "paddle-pro-btn", priceId: checkout.prices.pro, plan: "pro" });
  if (checkout?.prices.report) buttons.push({ id: "paddle-report-btn", priceId: checkout.prices.report, plan: "report" });
  // Agency was advertised on the landing page and in llms.txt, its 25-store
  // limit was enforced, and the webhook could grant it — but no button was
  // ever built for it, so there was no way to buy the thing being sold.
  if (plan !== "agency" && checkout?.prices.agency) {
    buttons.push({ id: "paddle-agency-btn", priceId: checkout.prices.agency, plan: "agency" });
  }
  const script = checkout ? paddleCheckoutScript(checkout.clientToken, email, buttons) : "";
  return layout("Billing", `
<div class="kicker"><span class="no">04</span>Billing</div>
<h1>Plan &amp; payment.</h1>
<p class="lede">${escapeHtml(email)}</p>
<div class="card">
<div class="kv"><span class="k">Current plan</span><span class="v"><span class="badge ${plan === "free" ? "" : "pro"}">${escapeHtml(plan)}</span></span></div>
<div class="kv"><span class="k">Offer limit</span><span class="v">${plan === "free" ? "Top 25 products" : "Unlimited"}</span></div>
<div class="kv"><span class="k">Agent-request dashboard</span><span class="v">Included</span></div>
<div class="kv"><span class="k">Weekly agent-activity email</span><span class="v">${plan === "free" ? "—" : "Included"}</span></div>
</div>
${reportsCard}
${historyCard}
${upgrade}
${script}
`, `<a href="/dashboard" style="color:var(--ink2)">← Dashboard</a>`);
}

const BILLING_EVENT_LABEL: Record<string, string> = {
  activated: "Plan activated", updated: "Plan changed", canceled: "Subscription canceled",
  past_due: "Payment failed — moved to Free", report_purchase: "Commerce Readiness Packet purchased",
};

export function accountPage(
  email: string,
  billingEvents: { eventType: string; plan: string | null; amount: string | null; currency: string | null; occurredAt: number }[],
  notice: { kind: "ok" | "error"; text: string } | null,
  hasPassword = true,
): string {
  const rows = billingEvents.map(e => {
    const amount = e.amount && e.currency ? `${e.amount} ${e.currency}` : "—";
    const label = BILLING_EVENT_LABEL[e.eventType] ?? e.eventType;
    return `<tr><td>${escapeHtml(new Date(e.occurredAt).toISOString().slice(0, 10))}</td><td>${escapeHtml(label)}</td><td>${escapeHtml(e.plan ?? "—")}</td><td class="mono">${escapeHtml(amount)}</td></tr>`;
  }).join("");
  // A Google-signed-up account has no password to confirm with — asking
  // for one it doesn't have would make every one of these forms a dead
  // end (permanently "wrong password"). It gets a lighter "set a password"
  // card instead of "change password", and the session itself (already the
  // gate on every /dashboard/account/* route) stands in for the current-
  // password check on email change and deletion. The moment they do set a
  // password, hasPassword flips true on the next load and they see the
  // exact same forms as anyone else.
  const passwordCard = hasPassword ? `
<div class="card" style="max-width:520px">
<h2 style="font-family:var(--serif);font-size:19px;font-weight:500;margin-bottom:4px">Change password</h2>
<form method="post" action="/dashboard/account/password">
<label for="current_password">Current password</label>
<input type="password" id="current_password" name="current_password" required autocomplete="current-password">
<label for="new_password">New password (8+ characters)</label>
<input type="password" id="new_password" name="new_password" required minlength="8" autocomplete="new-password">
<p style="margin:20px 0 0"><button class="btn" type="submit">Update password</button></p>
</form>
</div>` : `
<div class="card" style="max-width:520px">
<h2 style="font-family:var(--serif);font-size:19px;font-weight:500;margin-bottom:4px">Set a password</h2>
<p style="color:var(--ink2);font-size:14px;margin:6px 0 16px">You signed up with Google, so there's no password yet. Set one to also be able to log in with email + password.</p>
<form method="post" action="/dashboard/account/password">
<label for="new_password">New password (8+ characters)</label>
<input type="password" id="new_password" name="new_password" required minlength="8" autocomplete="new-password">
<p style="margin:20px 0 0"><button class="btn" type="submit">Set password</button></p>
</form>
</div>`;
  const emailPasswordField = hasPassword
    ? `<label for="email_password">Current password</label>
<input type="password" id="email_password" name="email_password" required autocomplete="current-password">`
    : "";
  const deletePasswordField = hasPassword
    ? `<label for="delete_password">Current password</label>
<input type="password" id="delete_password" name="delete_password" required autocomplete="current-password">`
    : "";
  return layout("Account", `
<div class="kicker"><span class="no">05</span>Account</div>
<h1>Your account.</h1>
<p class="lede">${escapeHtml(email)}</p>
${notice ? `<div class="${notice.kind === "ok" ? "ok" : "err"}">${escapeHtml(notice.text)}</div>` : ""}

${passwordCard}

<div class="card" style="max-width:520px">
<h2 style="font-family:var(--serif);font-size:19px;font-weight:500;margin-bottom:4px">Change email</h2>
<form method="post" action="/dashboard/account/email">
<label for="new_email">New email</label>
<input type="email" id="new_email" name="new_email" required autocomplete="email">
${emailPasswordField}
<p style="margin:20px 0 0"><button class="btn" type="submit">Update email</button></p>
</form>
</div>

<div class="card">
<h2 style="font-family:var(--serif);font-size:19px;font-weight:500;margin-bottom:14px">Billing history</h2>
${rows
    ? `<table><tr><th>Date</th><th>Event</th><th>Plan</th><th>Amount</th></tr>${rows}</table>`
    : `<p style="color:var(--ink3);font-size:14px">No billing events yet — this fills in once you upgrade or Paddle sends a payment update.</p>`}
</div>

<div class="card" style="border-color:#F0C9BE">
<h2 style="font-family:var(--serif);font-size:19px;font-weight:500;margin-bottom:4px;color:var(--acc-dark)">Delete account</h2>
<p style="color:var(--ink2);font-size:14px;margin:6px 0 16px">Deletes your login, connected stores and their keys — immediately, no recovery. This does not cancel a Paddle subscription; check your email for the Paddle management link, or cancel there first.</p>
<form method="post" action="/dashboard/account/delete">
${deletePasswordField}
<p style="margin:16px 0 0"><button class="btn" type="submit" style="background:var(--acc-dark)" onclick="return confirm('Delete your account and all connected stores? This cannot be undone.')">Delete my account</button></p>
</form>
</div>
`, APP_NAV(email));
}

/** The states this form can be shown in. `""` is the ordinary first visit;
 * the other two used to render the identical empty form, so a merchant who
 * typed a bad URL or hit the daily limit got the page back with nothing said
 * and no reason to believe anything had happened. */
export type ScanFormNotice = "" | "invalid_url" | "rate_limited";

export function scanFormPage(notice: ScanFormNotice = "", entered = ""): string {
  const message = notice === "invalid_url"
    ? `<p class="notice" role="alert">That is not a store address we can reach. Use the full public origin, including <code>https://</code> — for example <code>https://yourstore.com</code>.</p>`
    : notice === "rate_limited"
      ? `<p class="notice" role="alert">You have used today&rsquo;s free scans from this connection. The limit resets at midnight UTC. Nothing was scanned and nothing was charged.</p>`
      : "";
  return layout("Free scan", `
<div class="narrow" style="margin:0 auto">
<div class="kicker"><span class="no">00</span>Free scan</div>
<h1>Check your store — free.</h1>
<p class="lede">See your store exactly as AI shopping agents see it. Read-only, no signup, forever free.</p>
${message}
<div class="card">
<form method="post" action="/scan" id="scan-form">
<label for="store_url">Store URL</label>
<input type="url" id="store_url" name="store_url" required placeholder="https://yourstore.com" value="${escapeHtml(entered)}"${notice === "invalid_url" ? ` aria-invalid="true" autofocus` : ""}>
<p style="margin:20px 0 0"><button class="btn" id="scan-go" type="submit"${notice === "rate_limited" ? " disabled" : ""}>Run the scan</button>
<span class="working" id="scan-working" role="status" aria-live="polite" hidden>Reading your store — up to half a minute. Do not reload.</span></p>
</form>
</div>
<p style="color:var(--ink3);font-size:13px">We fetch your public pages only: homepage, Store API, robots.txt, discovery file.</p>
</div>
<script>
/* The scan makes up to six outbound fetches with an eight-second timeout each,
   so the browser can sit on a blank submit for half a minute with nothing said.
   Progressive enhancement only: without this the form still works, it is just
   silent. aria-live so the wait is announced, not only drawn. */
(function(){var f=document.getElementById("scan-form");if(!f)return;
f.addEventListener("submit",function(){var b=document.getElementById("scan-go"),w=document.getElementById("scan-working");
if(!b||b.disabled)return;b.disabled=true;b.textContent="Scanning\u2026";if(w)w.hidden=false;});})();
</script>`);
}

export interface ScanResultView {
  storeUrl: string;
  state?: "SCORED" | "UNREADABLE";
  score: number | null;
  grade: string | null;
  unreadable?: { reason: string; detail: string } | null;
  checks: Array<{ label: string; ok: boolean; detail: string }>;
  recommendations: string[];
}

/** A store that answered nothing is not a store that scored badly.
 *
 * This page used to have one shape: a number out of 100 and a grade. When the
 * scan could read nothing at all, every check failed for the same reason and
 * the merchant was shown roughly 18/100, "poor", as though that were a finding
 * about their shop. It is the abstention this product says elsewhere it does
 * not fold into a score, so it gets its own screen — no number, no grade, no
 * recommendations, and the attempted checks labelled as attempts. */
function scanAbstainedPage(result: ScanResultView): string {
  const reason = result.unreadable?.reason ?? "TARGET_UNREADABLE";
  const detail = result.unreadable?.detail ?? "nothing answered";
  const rows = result.checks.map(c =>
    `<tr><td style="width:28px"><span class="fail" aria-hidden="true">—</span></td><td>${escapeHtml(c.label)}</td><td style="color:var(--ink2)">not attempted — the store did not answer</td></tr>`
  ).join("");
  return layout("Scan result — could not tell", `
<div class="kicker"><span class="no">00</span>Scan result</div>
<h1>${escapeHtml(result.storeUrl)}</h1>
<p class="lede">We could not read this store.</p>
<div class="card" style="padding:34px 28px;border-color:var(--acc-dark);border-width:2px">
<p style="font-family:var(--serif);font-size:26px;line-height:1.25;margin:0">Could not tell.</p>
<p style="color:var(--ink2);margin:12px 0 0">We reached out and ${escapeHtml(detail)}. That is a fact about the
request, not about your store, so there is no score on this page and no grade.
A tool that gave you a number here would be scoring its own timeout.</p>
<p style="margin:16px 0 0"><code>${escapeHtml(reason)}</code></p>
</div>
<div class="card">
<strong>What we tried</strong>
<div class="scroll"><table style="margin-top:10px"><tr><th></th><th>Check</th><th>Result</th></tr>${rows}</table></div>
</div>
<div class="card">
<strong>What usually explains it</strong>
<ul style="margin:10px 0 0 20px">
<li style="margin-bottom:8px">The store is down, or the address has a typo.</li>
<li style="margin-bottom:8px">A firewall, bot challenge or country block is refusing our request.</li>
<li style="margin-bottom:8px">The store is not public yet — a staging or password-protected site cannot be scanned.</li>
</ul>
<p style="margin:14px 0 0"><a class="btn" href="/scan">Try another address</a></p>
</div>
`, `<a href="/scan" style="color:var(--ink2)">← Scan another store</a>`);
}

export function scanResultPage(result: ScanResultView): string {
  if (result.state === "UNREADABLE" || result.score === null) return scanAbstainedPage(result);
  const rows = result.checks.map(c =>
    `<tr><td style="width:28px">${c.ok ? `<span class="pass">✓</span>` : `<span class="fail">✗</span>`}</td><td>${escapeHtml(c.label)}</td><td style="color:var(--ink2)">${escapeHtml(c.detail)}</td></tr>`
  ).join("");
  const recs = result.recommendations.map(r => `<li style="margin-bottom:8px">${escapeHtml(r)}</li>`).join("");
  return layout("Scan result", `
<div class="kicker"><span class="no">00</span>Scan result</div>
<h1>${escapeHtml(result.storeUrl)}</h1>
<p class="lede">Agent-readiness score</p>
<div class="card score-card" style="text-align:center;padding:40px 28px;background:var(--dark);border-color:var(--dark)">
<div class="score" style="color:#fff">${result.score}<span>/100</span></div>
<span class="badge ${result.grade === "good" ? "pro" : ""}" style="margin-top:10px">${escapeHtml(result.grade ?? "")}</span>
</div>
<div class="card">
<div class="scroll"><table><tr><th></th><th>Check</th><th>Detail</th></tr>${rows}</table></div>
</div>
${recs ? `<div class="card"><strong>What to do next</strong><ul style="margin:10px 0 0 20px">${recs}</ul></div>` : ""}
<div class="card upsell">
<strong class="headline">Become buyable, not just readable.</strong>
<p>Signed cart handoff + agent analytics. Free for your top 25 products.</p>
<a class="btn btn-pulse" href="/signup">Create free account</a>
</div>
`, `<a href="/scan" style="color:var(--ink2)">← Scan another store</a>`);
}

/** The two screens the service had no HTML for at all.
 *
 * A miss returned the four bytes `not found` with no navigation, and an
 * unhandled throw fell through to Cloudflare's own 1101 page — which, to a
 * merchant who had just typed their shop's address, is indistinguishable from
 * their shop being the thing that broke. The distinction this product insists
 * on everywhere else is exactly the one these pages have to draw: this is us,
 * not you, and nothing about your store was measured. */
export function serviceErrorPage(kind: "not_found" | "upstream"): string {
  const notFound = kind === "not_found";
  return layout(notFound ? "Not found" : "Something broke on our side", `
<div class="narrow" style="margin:0 auto">
<div class="kicker"><span class="no">${notFound ? "404" : "500"}</span>${notFound ? "Not found" : "Our fault"}</div>
<h1>${notFound ? "There is nothing at this address." : "Something broke on our side."}</h1>
<p class="lede">${notFound
    ? "The link may be old, or a character may be missing. Nothing was scanned and nothing was charged."
    : "This is a failure in our service, not a finding about your store. Nothing was measured, nothing was scanned and nothing was charged."}</p>
<div class="card">
<p style="margin:0 0 16px">${notFound
    ? "The free scan is the place most people are looking for."
    : "Try again in a minute. If it keeps happening, tell us what you were doing and we will look — there is no ticket number to quote."}</p>
<p style="margin:0"><a class="btn" href="/scan">Run the free scan</a>
<a href="/support" style="margin-left:16px;color:var(--ink2)">Support</a></p>
</div>
</div>`);
}

// ---- operator admin (Basic Auth, read-mostly) ------------------------
// Deliberately spare: a name/email/plan list and a per-user detail page.
// No search, no destructive actions beyond the one-time reset-link button
// (which never touches the user's password itself, only issues a link
// they'd otherwise get by email). This exists because there was nothing
// at all — see docs/market conversation — not because it's meant to grow
// into a full support console.
const ADMIN_NAV = `<span style="color:var(--ink3);font-size:13px">Operator</span>`;

export function adminUsersPage(
  users: { id: string; email: string; createdAt: number; storeCount: number; plan: string }[],
): string {
  const rows = users.map(u => `<tr>
<td><a href="/admin/users/${escapeHtml(u.id)}" style="color:var(--ink);font-weight:600">${escapeHtml(u.email)}</a></td>
<td>${escapeHtml(new Date(u.createdAt).toISOString().slice(0, 10))}</td>
<td>${u.storeCount}</td>
<td><span class="badge${u.plan === "free" ? "" : " pro"}">${escapeHtml(u.plan)}</span></td>
</tr>`).join("");
  return layout("Admin — Users", `
<div class="kicker"><span class="no">99</span>Operator</div>
<h1>Users.</h1>
<p class="lede">${users.length} account${users.length === 1 ? "" : "s"}.</p>
<div class="card">
${rows ? `<table><tr><th>Email</th><th>Joined</th><th>Stores</th><th>Plan</th></tr>${rows}</table>` : `<p style="color:var(--ink3)">No accounts yet.</p>`}
</div>
`, ADMIN_NAV);
}

export function adminUserDetailPage(
  user: { id: string; email: string; createdAt: number },
  stores: { id: string; name: string; storeUrl: string; plan: string; status: string }[],
  billingEvents: { eventType: string; plan: string | null; amount: string | null; currency: string | null; occurredAt: number }[],
  resetLink: string | null,
): string {
  const storeRows = stores.map(s => `<tr>
<td>${escapeHtml(s.name)}</td><td>${escapeHtml(s.storeUrl)}</td>
<td><span class="badge${s.plan === "free" ? "" : " pro"}">${escapeHtml(s.plan)}</span></td><td>${escapeHtml(s.status)}</td>
</tr>`).join("");
  const billingRows = billingEvents.map(e => {
    const amount = e.amount && e.currency ? `${e.amount} ${e.currency}` : "—";
    const label = BILLING_EVENT_LABEL[e.eventType] ?? e.eventType;
    return `<tr><td>${escapeHtml(new Date(e.occurredAt).toISOString().slice(0, 10))}</td><td>${escapeHtml(label)}</td><td>${escapeHtml(e.plan ?? "—")}</td><td class="mono">${escapeHtml(amount)}</td></tr>`;
  }).join("");
  return layout(`Admin — ${user.email}`, `
<div class="kicker"><span class="no">99</span>Operator</div>
<h1>${escapeHtml(user.email)}</h1>
<p class="lede">Joined ${escapeHtml(new Date(user.createdAt).toISOString().slice(0, 10))}</p>

${resetLink ? `<div class="ok">One-time reset link — copy it now, it won't be shown again: <br><span class="mono" style="word-break:break-all">${escapeHtml(resetLink)}</span></div>` : ""}

<div class="card">
<h2 style="font-family:var(--serif);font-size:19px;font-weight:500;margin-bottom:14px">Stores</h2>
${storeRows ? `<table><tr><th>Name</th><th>URL</th><th>Plan</th><th>Status</th></tr>${storeRows}</table>` : `<p style="color:var(--ink3)">No stores connected.</p>`}
</div>

<div class="card">
<h2 style="font-family:var(--serif);font-size:19px;font-weight:500;margin-bottom:14px">Billing history</h2>
${billingRows ? `<table><tr><th>Date</th><th>Event</th><th>Plan</th><th>Amount</th></tr>${billingRows}</table>` : `<p style="color:var(--ink3)">No billing events.</p>`}
</div>

<div class="card" style="max-width:480px">
<h2 style="font-family:var(--serif);font-size:19px;font-weight:500;margin-bottom:4px">Support: password reset</h2>
<p style="color:var(--ink2);font-size:14px;margin:6px 0 16px">Generates the same link the user would get by email — use this until email delivery (RESEND_API_KEY) is configured.</p>
<form method="post" action="/admin/users/${escapeHtml(user.id)}/reset-link">
<button class="btn btn-line" type="submit">Generate reset link</button>
</form>
</div>

<p><a href="/admin" style="color:var(--ink2)">← All users</a></p>
`, ADMIN_NAV);
}

export async function readForm(request: Request): Promise<URLSearchParams> {
  return new URLSearchParams(await request.text());
}
