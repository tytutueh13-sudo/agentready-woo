// AI content readiness judge — the honest version of "does ChatGPT already
// recommend you". A brand-new small store almost never shows up in a real
// AI model's live knowledge or search results yet, so literally testing
// "ask ChatGPT about my store" would return a useless "no" for nearly every
// customer. Instead this reads the ALREADY-SCANNED product data (titles,
// descriptions) and has a model judge it the way a shopping agent would:
// is this description specific enough to answer a buyer's question, or is
// it generic marketing fluff an agent can't act on? That's a real,
// actionable signal — never sold as "we tested you in live ChatGPT."
//
// Uses OpenAI's GPT-5 Nano: cheapest verified per-token price for a short,
// structured-reasoning task like this (checked against Anthropic's and
// Google's own pricing pages — Nano came out roughly 2-15x cheaper than
// the next options for this workload), and at AgentReady's scan volume the
// absolute cost is a rounding error either way.

export interface AiJudgeEnv {
  OPENAI_API_KEY?: string;
}

export interface AiJudgeProduct {
  title: string;
  description: string;
  hasImage: boolean;
}

export interface AiJudgeResult {
  summary: string;
  suggestions: { title: string; rewrite: string }[];
}

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-5-nano";

function buildPrompt(storeUrl: string, products: AiJudgeProduct[]): string {
  const listing = products.map((p, i) =>
    `${i + 1}. "${p.title}" — description: ${p.description ? `"${p.description}"` : "(empty)"} — has image: ${p.hasImage}`,
  ).join("\n");
  return `You are judging whether an AI shopping agent (like ChatGPT or Claude) could confidently ` +
    `recommend and describe these products to a buyer, using only the text given — not general ` +
    `knowledge about the store. Store: ${storeUrl}\n\nProducts:\n${listing}\n\n` +
    `Respond with strict JSON: {"summary": "2-3 sentences, direct and specific, no fluff", ` +
    `"suggestions": [{"title": "<product title>", "rewrite": "<a better 1-2 sentence description ` +
    `an agent could actually use>"}]} — one suggestion per product listed, in the same order.`;
}

/** Returns null (never throws) whenever this can't run: no API key
 * configured, nothing to judge, or the call fails — the deep report and
 * everything else must keep working exactly as before this existed. */
export async function judgeReadiness(
  env: AiJudgeEnv, storeUrl: string, products: AiJudgeProduct[],
): Promise<AiJudgeResult | null> {
  const apiKey = env.OPENAI_API_KEY ?? "";
  if (!apiKey || products.length === 0) return null;
  try {
    const res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: buildPrompt(storeUrl, products) }],
      }),
    });
    if (!res.ok) {
      console.error("judgeReadiness: OpenAI rejected the request", { status: res.status });
      return null;
    }
    const body = await res.json() as { choices?: { message?: { content?: string } }[] };
    const content = body.choices?.[0]?.message?.content;
    if (!content) return null;
    const parsed = JSON.parse(content) as Partial<AiJudgeResult>;
    if (typeof parsed.summary !== "string" || !Array.isArray(parsed.suggestions)) return null;
    const suggestions = parsed.suggestions.filter(
      (s): s is { title: string; rewrite: string } => typeof s?.title === "string" && typeof s?.rewrite === "string",
    );
    return { summary: parsed.summary, suggestions };
  } catch (error) {
    console.error("judgeReadiness: network or parse error", { error: String(error) });
    return null;
  }
}
