// Tests for the AI content readiness judge: must never throw, must degrade
// to null (not break the deep report) whenever anything is missing or
// wrong — no key, no products, a bad response, or a network failure.
import test from "node:test";
import assert from "node:assert/strict";
import { judgeReadiness } from "../src/core/aiJudge.ts";

const PRODUCTS = [{ title: "Wool Cap", description: "ok", hasImage: true }];

test("judgeReadiness returns null when no API key is configured", async () => {
  const result = await judgeReadiness({}, "https://store.example.com", PRODUCTS);
  assert.equal(result, null);
});

test("judgeReadiness returns null when there are no products to judge", async () => {
  const result = await judgeReadiness({ OPENAI_API_KEY: "sk-fixture" }, "https://store.example.com", []);
  assert.equal(result, null);
});

test("judgeReadiness parses a well-formed response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String((init as RequestInit).body));
    assert.equal(body.model, "gpt-5-nano");
    assert.match(body.messages[0].content, /Wool Cap/);
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        summary: "Descriptions are too thin for an agent to act on.",
        suggestions: [{ title: "Wool Cap", rewrite: "A warm merino wool cap, one size fits most." }],
      }) } }],
    }), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await judgeReadiness({ OPENAI_API_KEY: "sk-fixture" }, "https://store.example.com", PRODUCTS);
    assert.equal(result?.summary, "Descriptions are too thin for an agent to act on.");
    assert.equal(result?.suggestions[0]?.title, "Wool Cap");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("judgeReadiness returns null when OpenAI rejects the request", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("unauthorized", { status: 401 })) as typeof fetch;
  try {
    const result = await judgeReadiness({ OPENAI_API_KEY: "sk-bad" }, "https://store.example.com", PRODUCTS);
    assert.equal(result, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("judgeReadiness returns null on a malformed response body rather than throwing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    choices: [{ message: { content: "not valid json" } }],
  }), { status: 200 })) as typeof fetch;
  try {
    const result = await judgeReadiness({ OPENAI_API_KEY: "sk-fixture" }, "https://store.example.com", PRODUCTS);
    assert.equal(result, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("judgeReadiness returns null on a network error rather than throwing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("network down"); }) as typeof fetch;
  try {
    const result = await judgeReadiness({ OPENAI_API_KEY: "sk-fixture" }, "https://store.example.com", PRODUCTS);
    assert.equal(result, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("judgeReadiness drops malformed suggestion entries instead of failing the whole result", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({
      summary: "Fine.",
      suggestions: [{ title: "Wool Cap", rewrite: "Better text" }, { title: 42, rewrite: null }],
    }) } }],
  }), { status: 200 })) as typeof fetch;
  try {
    const result = await judgeReadiness({ OPENAI_API_KEY: "sk-fixture" }, "https://store.example.com", PRODUCTS);
    assert.equal(result?.suggestions.length, 1);
    assert.equal(result?.suggestions[0]?.title, "Wool Cap");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
