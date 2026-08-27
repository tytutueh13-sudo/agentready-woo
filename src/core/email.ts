// Transactional email via Resend's plain REST API (no SDK — matches this
// project's fetch-only style). Nothing in this codebase sends email today;
// this is the one piece that genuinely needs an external account the
// operator has to create themselves (RESEND_API_KEY, EMAIL_FROM) — see
// wrangler.toml. Every caller must keep working with no email provider
// configured: sendEmail() returns false and logs, it never throws, so a
// password-reset request still behaves identically (same generic response)
// whether or not delivery actually happened. That is also why the reset
// link itself is additionally surfaced on the admin user page — support
// can hand it to a merchant by any channel even before Resend is wired up.

export interface EmailEnv {
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
}

const RESEND_URL = "https://api.resend.com/emails";

export async function sendEmail(
  env: EmailEnv, to: string, subject: string, html: string,
): Promise<boolean> {
  const apiKey = env.RESEND_API_KEY ?? "";
  const from = env.EMAIL_FROM ?? "";
  if (!apiKey || !from) {
    console.error("sendEmail: RESEND_API_KEY/EMAIL_FROM not configured — not sent", { to, subject });
    return false;
  }
  try {
    const res = await fetch(RESEND_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from, to, subject, html }),
    });
    if (!res.ok) {
      console.error("sendEmail: Resend rejected the request", { to, subject, status: res.status });
      return false;
    }
    return true;
  } catch (error) {
    console.error("sendEmail: network error", { to, subject, error: String(error) });
    return false;
  }
}

export function passwordResetEmailHtml(resetUrl: string): string {
  return `<!doctype html><html><body style="font-family:sans-serif;color:#17151C;background:#FAF9F5;padding:32px">
<h1 style="font-size:20px">Reset your AgentReady password</h1>
<p>Someone (hopefully you) asked to reset the password on your AgentReady account.</p>
<p><a href="${resetUrl}" style="display:inline-block;background:#E4572E;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:600">Choose a new password</a></p>
<p style="color:#55515E;font-size:13px">This link expires in 1 hour and works once. If you didn't request this, you can ignore this email — your password hasn't changed.</p>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface DeepReportScan {
  storeUrl: string;
  score: number;
  grade: "good" | "fair" | "poor";
  productCount: number;
  checks: { label: string; ok: boolean; detail: string; weight: number }[];
  recommendations: string[];
}

/** The $9 Deep Report's actual deliverable — built from the same scan data
 * the free scan already produced, just formatted as the "prioritized fix
 * list" the pricing page promises. Failing checks first, worst-weighted
 * first, so the top of the email is the highest-impact fix. */
export interface DeepReportAiJudge {
  summary: string;
  suggestions: { title: string; rewrite: string }[];
}

export function deepReportEmailHtml(scan: DeepReportScan, aiJudge?: DeepReportAiJudge | null): string {
  const failing = scan.checks.filter(c => !c.ok).sort((a, b) => b.weight - a.weight);
  const passing = scan.checks.filter(c => c.ok);
  const fixRows = failing.length
    ? failing.map((c, i) => `<tr><td style="padding:10px 12px;border-bottom:1px solid #E5E2DB;color:#98949F;font-family:monospace;font-size:12px">#${i + 1}</td><td style="padding:10px 12px;border-bottom:1px solid #E5E2DB"><strong>${escapeHtml(c.label)}</strong><br><span style="color:#55515E;font-size:13px">${escapeHtml(c.detail)}</span></td></tr>`).join("")
    : `<tr><td colspan="2" style="padding:10px 12px;color:#1F7A4D">Every check passed — nothing to fix right now.</td></tr>`;
  const recRows = scan.recommendations.length
    ? `<ul style="padding-left:20px;color:#55515E">${scan.recommendations.map(r => `<li style="margin-bottom:6px">${escapeHtml(r)}</li>`).join("")}</ul>`
    : "";
  // Deliberately labeled "AI content review," never "tested in ChatGPT" —
  // this is a model judging your existing product text, not a live query
  // against a real AI shopping assistant. See core/aiJudge.ts.
  const aiSection = aiJudge ? `
<h2 style="font-size:16px;margin-top:28px">AI content review</h2>
<p style="color:#55515E">${escapeHtml(aiJudge.summary)}</p>
${aiJudge.suggestions.length ? `<table style="width:100%;border-collapse:collapse;font-size:14px">${aiJudge.suggestions.map(s => `<tr><td style="padding:10px 12px;border-bottom:1px solid #E5E2DB"><strong>${escapeHtml(s.title)}</strong><br><span style="color:#55515E;font-size:13px">Try: ${escapeHtml(s.rewrite)}</span></td></tr>`).join("")}</table>` : ""}` : "";
  return `<!doctype html><html><body style="font-family:sans-serif;color:#17151C;background:#FAF9F5;padding:32px;max-width:640px;margin:0 auto">
<h1 style="font-size:20px">Your AgentReady deep report</h1>
<p style="color:#55515E">${escapeHtml(scan.storeUrl)} · ${scan.productCount} products · scanned readiness grade: <strong>${escapeHtml(scan.grade)}</strong> (${scan.score}/100)</p>
<h2 style="font-size:16px;margin-top:28px">Prioritized fix list — ${failing.length} gap${failing.length === 1 ? "" : "s"}</h2>
<table style="width:100%;border-collapse:collapse;font-size:14px">${fixRows}</table>
${recRows ? `<h2 style="font-size:16px;margin-top:28px">Recommendations</h2>${recRows}` : ""}
${aiSection}
<h2 style="font-size:16px;margin-top:28px">Already passing (${passing.length})</h2>
<p style="color:#55515E;font-size:13px">${passing.map(c => escapeHtml(c.label)).join(" · ") || "—"}</p>
<p style="color:#98949F;font-size:12px;margin-top:32px">This report was generated from your most recent free scan. Re-run the scan any time for an updated one.</p>
</body></html>`;
}

/** Sent once a week per user (see AppStore.usersDueForDigest) — always sent
 * with real numbers, including zero, rather than skipped when there's
 * nothing to report: a "0 this week" email is still honest signal, and
 * silently skipping would make the presence of an email itself imply
 * "something happened," which isn't the promise. */
export function weeklyDigestEmailHtml(stores: { name: string; storeUrl: string; hits: number }[], dashboardUrl: string): string {
  const rows = stores.map(s => `<tr><td style="padding:10px 12px;border-bottom:1px solid #E5E2DB"><strong>${escapeHtml(s.name)}</strong><br><span style="color:#98949F;font-size:12px">${escapeHtml(s.storeUrl)}</span></td><td style="padding:10px 12px;border-bottom:1px solid #E5E2DB;text-align:right;font-family:monospace;font-size:16px">${s.hits}</td></tr>`).join("");
  return `<!doctype html><html><body style="font-family:sans-serif;color:#17151C;background:#FAF9F5;padding:32px;max-width:640px;margin:0 auto">
<h1 style="font-size:20px">Your week on AgentReady</h1>
<p style="color:#55515E">Agent requests to your feed and MCP endpoint over the last 7 days:</p>
<table style="width:100%;border-collapse:collapse;font-size:14px"><tr><th style="text-align:left;padding:8px 12px;font-size:11px;color:#98949F;text-transform:uppercase;border-bottom:2px solid #E5E2DB">Store</th><th style="text-align:right;padding:8px 12px;font-size:11px;color:#98949F;text-transform:uppercase;border-bottom:2px solid #E5E2DB">Requests</th></tr>${rows}</table>
<p style="margin-top:24px"><a href="${dashboardUrl}" style="display:inline-block;background:#E4572E;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:600">Open your dashboard</a></p>
<p style="color:#98949F;font-size:12px;margin-top:24px">You're getting this because you have a store connected on AgentReady. This is a weekly summary, not a marketing email.</p>
</body></html>`;
}
