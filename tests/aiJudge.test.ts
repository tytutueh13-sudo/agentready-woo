import test from "node:test";
import assert from "node:assert/strict";
import { AI_MAX_OUTPUT_TOKENS, AI_MODEL, judgeReadiness, safeProducts } from "../src/core/aiJudge.ts";

const PRODUCTS = [{ title: "Wool Cap", description: "A warm merino wool cap.", hasImage: true }];

test("judgeReadiness returns null without the Workers AI binding", async () => {
  assert.equal(await judgeReadiness({}, PRODUCTS), null);
});

test("judgeReadiness sends only the bounded product projection to Workers AI", async () => {
  let called = false;
  const result = await judgeReadiness({ AI: { run: async (model, input) => {
    called = true;
    assert.equal(model, AI_MODEL);
    assert.equal(input.max_tokens, AI_MAX_OUTPUT_TOKENS);
    assert.match(String((input.messages as { content: string }[])[0].content), /Wool Cap/);
    assert.doesNotMatch(String((input.messages as { content: string }[])[0].content), /store\.example/);
    return { response: JSON.stringify({
      summary: "The product needs a clearer material and fit description.",
      suggestions: [{ title: "Wool Cap", rewrite: "A warm merino wool cap with a soft, close fit." }],
    }) };
  } } }, PRODUCTS);
  assert.equal(called, true);
  assert.equal(result?.suggestions[0]?.title, "Wool Cap");
});

test("safeProducts drops sensitive content, duplicates, and excess products before model input", () => {
  const safe = safeProducts([
    { title: "Order #123", description: "A normal product", hasImage: true },
    { title: "Wool Cap", description: "Contact a@shop.example for help", hasImage: true },
    ...PRODUCTS,
    { title: "Wool Cap", description: "duplicate", hasImage: false },
    { title: "Scarf", description: "Soft cotton.", hasImage: true },
    { title: "Socks", description: "Everyday socks.", hasImage: true },
    { title: "Gloves", description: "Would exceed cap.", hasImage: true },
  ]);
  assert.deepEqual(safe.map(product => product.title), ["Wool Cap", "Scarf", "Socks"]);
});

test("judgeReadiness rejects unknown titles, sensitive replies, malformed objects, and binding failures", async () => {
  const responses = [
    { response: JSON.stringify({ summary: "Fine", suggestions: [{ title: "Unknown", rewrite: "No" }] }) },
    { response: JSON.stringify({ summary: "Email buyer@example.com", suggestions: [] }) },
    { response: JSON.stringify({ summary: "Fine", suggestions: [{ title: "Wool Cap", rewrite: "Fine", extra: true }] }) },
    { response: "not json" },
  ];
  for (const response of responses) {
    assert.equal(await judgeReadiness({ AI: { run: async () => response } }, PRODUCTS), null);
  }
  assert.equal(await judgeReadiness({ AI: { run: async () => { throw new Error("unavailable"); } } }, PRODUCTS), null);
});
