=== AgentReady Woo — Release evidence for WooCommerce ===
Contributors: agentready
Tags: woocommerce, release testing, mcp, agentic commerce, privacy
Requires at least: 6.0
Tested up to: 7.1
Requires PHP: 7.4
Stable tag: 1.1.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Publish agent discovery and send signed, aggregate-only WooCommerce evidence to an owner-authorized AgentReady Release Gate.

== Description ==

AgentReady Woo gives a WooCommerce owner two deliberately separate capabilities.

**Release Gate evidence**

* Creates a short-lived, signed evidence envelope from a closed set of aggregate checks.
* Sends no customer, order, payment, email, address, URL, log or raw diagnostic fields.
* Supports current/previous evidence keys for controlled rotation.
* Runs daily only after an administrator configures an authenticated connection bundle.
* Can also be sent manually by a WooCommerce administrator.

The AgentReady service combines that signed evidence with public protocol checks to make a version-pinned release decision. An unavailable signal becomes `UNMEASURED` or `BLOCKED`; it is not converted into a low score or a confident diagnosis. Release Gate settlement is currently disabled.

**Store discovery and optional connected catalogue**

* Publishes `/.well-known/agenticweb.md` on the store's own domain.
* Adds a discovery link tag and explicit access for named AI crawlers.
* Can connect a separate read-only AgentReady catalogue endpoint for product search, offer lookup and human-approved cart handoff.

The connected catalogue is not required for Release Gate. Checkout stays on the merchant's WooCommerce store, and this plugin never handles card data.

== Installation ==

1. Install and activate the plugin.
2. Go to WooCommerce → AgentReady.
3. Confirm the discovery document at `/.well-known/agenticweb.md`.
4. In your authenticated AgentReady dashboard, create a store connection bundle.
5. Paste the opaque store id and derived ownership/evidence keys into the plugin settings.
6. Send one evidence envelope and verify the receipt in the AgentReady dashboard.

Without steps 4–6 the Release Gate collector remains inert. The discovery document still works.

== Frequently Asked Questions ==

= Does this collect customers, orders or payment data? =

No. The Release Gate schema accepts only a closed aggregate envelope. Customer, order, payment, email, address, URL, raw body and log fields are not part of that schema and are rejected by the service.

= What happens when evidence cannot be measured? =

The result says `UNMEASURED` or `BLOCKED` with a finite reason code. Missing evidence is not presented as a store failure.

= Does activation immediately send data? =

No. The scheduled collector is inert until a WooCommerce administrator configures the store id and derived evidence key. Administrators can revoke or rotate the connection from the AgentReady dashboard.

= Does this touch checkout? =

No. Release Gate does not create orders or handle payment credentials. The optional connected catalogue can produce a signed cart handoff, but checkout still completes in the buyer's browser on the merchant's store.

= What does it cost? =

The plugin and public preflight are free. Release Gate settlement is disabled while operational evidence is measured. Existing AgentReady account products do not grant Release Gate access.

== Screenshots ==

1. Configure the authenticated Release Gate connection bundle.
2. Send aggregate evidence now or let the daily schedule run.
3. Verify the evidence receipt and version-pinned run in the AgentReady dashboard.
4. Inspect explicit accepted, rejected, partial, blocked or unmeasured outcomes.

== Changelog ==

= 1.1.0 =
* Added signed, aggregate-only Release Gate evidence.
* Added exact-once nonce handling and current/previous key rotation support.
* Added owner proof and authenticated Release Gate connection settings.
* Rewrote public documentation around the measured privacy and abstention contract.

= 0.1.0 =
* Initial discovery document, crawler access, link tag and optional connected catalogue.
