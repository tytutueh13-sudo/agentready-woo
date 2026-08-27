// Server-rendered merchant app pages. Visual system matches the marketing
// landing exactly: Fraunces + Spline Sans + IBM Plex Mono, ink/paper/vermilion,
// numbered kickers, hairline borders. App UI calm: no decorative chrome.

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const CSS = `
:root{--paper:#FAF9F5;--ink:#17151C;--ink2:#55515E;--ink3:#98949F;--line:#E5E2DB;--acc:#E4572E;--acc-dark:#C43F1B;--ok:#1F7A4D;--dark:#141218;--dark2:#1D1A24;
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
nav .cta{color:var(--acc);font-weight:600}
.wrap{max-width:1140px;margin:0 auto;padding:64px 32px 96px}
.narrow{max-width:560px}
.kicker{font-family:var(--mono);font-size:12px;color:var(--acc);margin-bottom:14px}
.kicker .no{color:var(--ink3);margin-right:10px}
h1{font-family:var(--serif);font-weight:500;font-size:clamp(28px,3.6vw,40px);line-height:1.15;letter-spacing:-.01em;margin-bottom:8px}
.lede{color:var(--ink2);font-size:17px;max-width:560px;margin-bottom:36px}
.card{background:#fff;border:1px solid var(--line);border-radius:8px;padding:28px;margin-bottom:18px}
label{display:block;font-size:12.5px;font-weight:600;color:var(--ink2);margin:16px 0 5px}
input[type=text],input[type=email],input[type=password],input[type=url]{width:100%;border:1px solid var(--line);border-radius:6px;padding:11px 13px;font-size:14.5px;font-family:var(--sans);background:#fff;color:var(--ink)}
input:focus{outline:none;border-color:var(--acc)}
.btn{display:inline-block;background:var(--acc);color:#fff;font-weight:600;font-size:15px;border:0;border-radius:6px;padding:13px 24px;cursor:pointer;text-decoration:none;font-family:var(--sans)}
.btn:hover{background:var(--acc-dark);color:#fff;text-decoration:none}
.btn-line{background:transparent;color:var(--ink);border:1px solid var(--ink)}
.btn-line:hover{background:var(--ink);color:#fff}
.err{background:#FCEEE8;border-left:3px solid var(--acc);padding:10px 14px;margin-bottom:16px;font-size:14px;color:#7a2e12}
.ok{background:#EAF4EE;border-left:3px solid var(--ok);padding:10px 14px;margin-bottom:16px;font-size:14px;color:#14532d}
table{width:100%;border-collapse:collapse;font-size:14.5px}
th{text-align:left;font-family:var(--mono);font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink3);padding:8px 10px;border-bottom:1px solid var(--line);font-weight:500}
td{padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:0}
.pass{color:var(--ok);font-weight:600}.fail{color:var(--acc);font-weight:600}
.mono{font-family:var(--mono);font-size:13px}
.kv{display:flex;justify-content:space-between;gap:12px;padding:11px 0;border-bottom:1px solid var(--line);font-size:14.5px;align-items:baseline}
.kv:last-child{border-bottom:0}
.kv .k{color:var(--ink2);flex:none;width:220px}
.kv .v{overflow-wrap:anywhere;text-align:right}
.score{font-family:var(--serif);font-size:72px;font-weight:500;line-height:1;color:var(--ink)}
.score span{font-size:26px;color:var(--ink3)}
.badge{display:inline-block;font-family:var(--mono);font-size:11px;letter-spacing:.08em;text-transform:uppercase;padding:3px 10px;border-radius:99px;border:1px solid var(--line);color:var(--ink2)}
.badge.pro{border-color:var(--acc);color:var(--acc)}
code{background:#f0efea;padding:.1rem .35rem;border-radius:4px;font-size:13px}
.foot{max-width:1140px;margin:0 auto;padding:0 32px 64px;color:var(--ink3);font-size:13px}
@media (max-width:640px){
  nav .in{flex-wrap:wrap;row-gap:10px;padding:14px 20px}
  .logo{font-size:15px}
  .logo .by{display:none}
  nav .links{width:100%;justify-content:flex-end;flex-wrap:wrap;column-gap:16px;row-gap:6px;font-size:13px}
  .wrap{padding:40px 20px 64px}
  .foot{padding:0 20px 40px}
  .score{font-size:52px}
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
<p class="lede">Free scan forever. Your top 10 products live as agent offers.</p>
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
<span>I agree to the <a href="/terms" style="color:var(--acc)">Terms</a> and <a href="/privacy" style="color:var(--acc)">Privacy Policy</a>.</span></label>
<p style="margin:20px 0 0"><button class="btn" type="submit">Create account</button></p>
</form>
</div>
<p>Already have an account? <a href="/login" style="color:var(--acc)">Log in</a></p>
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
<p>New here? <a href="/signup" style="color:var(--acc)">Create an account</a> — the scan is free forever.</p>
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
<p><a href="/login" style="color:var(--acc)">← Back to log in</a></p>
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

export function dashboardPage(email: string, storesHtml: string, addStoreCta: string): string {
  return layout("Dashboard", `
<div class="kicker"><span class="no">02</span>Your stores</div>
<h1>Agent traffic, live.</h1>
<p class="lede">Endpoints agents read, requests they made, and what each store is worth to them.</p>
${storesHtml}
${addStoreCta}
`, APP_NAV(email));
}

export function storeCard(store: { id: string; name: string; storeUrl: string; plan: string; publicBaseUrl: string; agentHits: number }): string {
  const planBadge = store.plan === "free" ? `<span class="badge">Free · top 10 products</span>` : `<span class="badge pro">${escapeHtml(store.plan)}</span>`;
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
<a class="btn btn-line" href="/scan" style="margin-left:8px">Re-scan</a></p>
</div>`;
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

export function billingPage(plan: string, email: string, paddleLinks: { report?: string; pro?: string; agency?: string }): string {
  // The deep report is fulfilled automatically off the buyer's account
  // (their most recent scan, emailed right after the webhook fires) — see
  // deliverDeepReport() in webhooks.ts. That only works once we know which
  // account is buying, which is why this checkout only appears here
  // (logged in), never as a self-serve link on the public landing page.
  const reportLink = paddleLinks.report
    ? `<a class="btn btn-line" href="${escapeHtml(paddleLinks.report)}">Buy the deep report — $9</a>`
    : `<a class="btn btn-line" href="mailto:hello@utilityhouse.xyz?subject=Deep%20report%20request">Request the deep report — $9</a>`;
  // Pro is a one-time purchase — nothing recurs, so there's no Paddle
  // subscription to "manage" once it's active. Agency is still a real
  // subscription (it bundles ongoing priority support), so that message
  // stays accurate only for Agency.
  const upgrade = plan === "free"
    ? `${paddleLinks.pro ? `<a class="btn" href="${escapeHtml(paddleLinks.pro)}">Unlock Pro — $99 once</a>` : `<a class="btn" href="mailto:hello@utilityhouse.xyz?subject=Pro">Unlock Pro — $99 once</a>`}
       <p style="color:var(--ink2);font-size:14px;margin-top:10px">Unlimited offers · signed cart handoff · weekly agent-activity digest — one payment, no renewal.</p>
       <p style="margin-top:16px">${reportLink}</p>`
    : plan === "pro"
    ? `<div class="ok">Pro is unlocked on your account — permanently, no subscription to manage. Check your email for the receipt.</div>`
    : `<div class="ok">Your plan is active: ${escapeHtml(plan)}. Manage payments via Paddle — check your email for the receipt and management link.</div>`;
  return layout("Billing", `
<div class="kicker"><span class="no">04</span>Billing</div>
<h1>Plan &amp; payment.</h1>
<p class="lede">${escapeHtml(email)}</p>
<div class="card">
<div class="kv"><span class="k">Current plan</span><span class="v"><span class="badge ${plan === "free" ? "" : "pro"}">${escapeHtml(plan)}</span></span></div>
<div class="kv"><span class="k">Offer limit</span><span class="v">${plan === "free" ? "Top 10 products" : "Unlimited"}</span></div>
<div class="kv"><span class="k">Agent-request dashboard</span><span class="v">Included</span></div>
<div class="kv"><span class="k">Weekly agent-activity email</span><span class="v">${plan === "free" ? "—" : "Included"}</span></div>
</div>
<div class="card">${upgrade}</div>
`, `<a href="/dashboard" style="color:var(--ink2)">← Dashboard</a>`);
}

const BILLING_EVENT_LABEL: Record<string, string> = {
  activated: "Plan activated", updated: "Plan changed", canceled: "Subscription canceled",
  past_due: "Payment failed — moved to Free", report_purchase: "Deep report purchased",
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

export function scanFormPage(): string {
  return layout("Free scan", `
<div class="narrow" style="margin:0 auto">
<div class="kicker"><span class="no">00</span>Free scan</div>
<h1>Check your store — free.</h1>
<p class="lede">See your store exactly as AI shopping agents see it. Read-only, no signup, forever free.</p>
<div class="card">
<form method="post" action="/scan">
<label for="store_url">Store URL</label>
<input type="url" id="store_url" name="store_url" required placeholder="https://yourstore.com">
<p style="margin:20px 0 0"><button class="btn" type="submit">Run the scan</button></p>
</form>
</div>
<p style="color:var(--ink3);font-size:13px">We fetch your public pages only: homepage, Store API, robots.txt, discovery file.</p>
</div>`);
}

export function scanResultPage(result: {
  storeUrl: string; score: number; grade: string;
  checks: Array<{ label: string; ok: boolean; detail: string }>;
  recommendations: string[];
}): string {
  const rows = result.checks.map(c =>
    `<tr><td style="width:28px">${c.ok ? `<span class="pass">✓</span>` : `<span class="fail">✗</span>`}</td><td>${escapeHtml(c.label)}</td><td style="color:var(--ink2)">${escapeHtml(c.detail)}</td></tr>`
  ).join("");
  const recs = result.recommendations.map(r => `<li style="margin-bottom:8px">${escapeHtml(r)}</li>`).join("");
  return layout("Scan result", `
<div class="kicker"><span class="no">00</span>Scan result</div>
<h1>${escapeHtml(result.storeUrl)}</h1>
<p class="lede">Agent-readiness score</p>
<div class="card" style="text-align:center;padding:40px 28px;background:var(--dark);border-color:var(--dark)">
<div class="score" style="color:#fff">${result.score}<span>/100</span></div>
<span class="badge ${result.grade === "good" ? "pro" : ""}" style="margin-top:10px">${escapeHtml(result.grade)}</span>
</div>
<div class="card">
<table><tr><th></th><th>Check</th><th>Detail</th></tr>${rows}</table>
</div>
${recs ? `<div class="card"><strong>What to do next</strong><ul style="margin:10px 0 0 20px">${recs}</ul></div>` : ""}
<div class="card" style="background:var(--dark);border-color:var(--dark);color:#fff">
<strong style="font-family:var(--serif);font-size:21px;font-weight:500">Become buyable, not just readable.</strong>
<p style="color:#A9A5B5;margin:8px 0 16px">Signed cart handoff + agent analytics. Free for your top 10 products.</p>
<a class="btn" href="/signup">Create free account</a>
</div>
`, `<a href="/scan" style="color:var(--ink2)">← Scan another store</a>`);
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
