=== AgentReady Woo — AI Shopping Agents for WooCommerce ===
Contributors: agentready
Tags: ai, chatgpt, shopping agent, mcp, seo, woocommerce products, agentic commerce, feed, discoverability
Requires at least: 6.0
Tested up to: 6.8
Requires PHP: 7.4
Stable tag: 0.1.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Make your WooCommerce store readable and buyable by AI shopping agents — ChatGPT, Claude, Perplexity and independent agents.

== Description ==

ChatGPT already shops. More than a million Shopify stores were rolled into ChatGPT shopping automatically. Self-hosted WooCommerce stores woke up invisible.

AgentReady Woo is the catch-up. In five minutes, your store becomes readable, in-stock queryable, and buyable by AI shopping agents — with checkout always completing on your own store.

**What the free plugin does today**

* **Agent discovery file** — publishes `/.well-known/agenticweb.md` on your own domain, telling AI agents what your store sells and how to query it.
* **AI crawler access** — explicitly allows the shopping-relevant AI crawlers (GPTBot, OAI-SearchBot, ClaudeBot, PerplexityBot and more) in robots.txt, so agents can actually read your catalog.
* **Discovery link tag** — declares the agent discovery endpoint in your page head.
* **Live preview** — see exactly what agents see, right from the WooCommerce admin.

**Connect an AgentReady endpoint (free scan to get one) and unlock**

* **Agent-readable feed** — your live WooCommerce catalog as structured offers agents can query: price, stock, shipping.
* **MCP endpoint** — agents search products, get offer details, and create signed cart handoffs via the Model Context Protocol.
* **Signed cart handoff** — the agent hands the buyer a signed cart link; checkout happens in the buyer's browser on YOUR store. No card data ever touches the service.
* **Agent-request count** — see how many AI-agent requests your feed and MCP endpoint get, right in your dashboard.

**Why now**

AI-referred shoppers convert +38% higher than traditional search (Adobe Analytics). AI traffic to US retail sites grew +138% year-over-year in May 2026 — the highest share ever recorded (Reuters/Adobe). Shopify merchants got automatic access. This plugin is how self-hosted WooCommerce catches up.

== Installation ==

1. Install and activate the plugin.
2. Go to WooCommerce → AgentReady.
3. Your discovery file is already live at `/.well-known/agenticweb.md`.
4. Optional: run the free scan at agentready.utilityhouse.xyz to get your AgentReady feed + MCP endpoint, then paste the endpoint URL into the settings.

== Frequently Asked Questions ==

= Does this touch my checkout or payment data? =

No. Agents discover products and hand the buyer a signed cart link. The purchase completes in the buyer's browser, on your store, through your existing checkout. No card data ever passes through any AgentReady service.

= Does this slow down my store? =

No. The plugin adds one lightweight discovery file, a few robots.txt lines, and one link tag. The agent feed runs on your AgentReady endpoint, not on your server.

= Is my product data sent anywhere? =

The discovery file is served from your own site. If you connect an AgentReady endpoint, it reads your existing WooCommerce REST API (read-only key that you issue and can revoke in one click) to build the agent feed.

= How is this different from an SEO plugin? =

SEO plugins make you readable to Google's crawler. AgentReady makes you readable, in-stock queryable, and buyable by shopping agents — a different file format, a different protocol, and a checkout path. Google sends humans; agents send buyers with their wallets already out.

= What does it cost? =

The plugin is free. The AgentReady free tier keeps a basic feed and discovery live forever (your top 10 products). Paid tiers add unlimited offers, cart handoff and agent analytics.

== Screenshots ==

1. Connect your store — paste your store URL, issue a read-only WooCommerce API key.
2. Your feed goes live — every product becomes a structured offer agents can query.
3. Agents find you — an agent asks for a product, gets your offer, and hands the buyer a signed cart.
4. See agents show up — a live request count proves they're actually reading your catalog.

== Changelog ==

= 0.1.0 =
* Initial release: agent discovery file, AI crawler robots access, discovery link tag, live preview, endpoint connection.
