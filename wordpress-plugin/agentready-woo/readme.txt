=== AgentReady Release Gate for WooCommerce ===
Contributors: agentready
Tags: woocommerce, release testing, mcp, privacy, site health
Requires at least: 6.0
Tested up to: 7.1
Requires PHP: 7.4
Requires Plugins: woocommerce
Stable tag: 1.2.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Check local WooCommerce readiness, then optionally send signed aggregate evidence for an owner-authorized AgentReady Release Gate.

== Description ==

AgentReady Release Gate helps a WooCommerce administrator answer a narrow question: is the agent-facing surface of this specific release supported by attributable evidence?

Development source: https://github.com/tytutueh13-sudo/agentready-woo

**Useful before connecting**

* Shows a local-only snapshot for HTTPS, WooCommerce availability, published-product state, discovery path and outbound-evidence status.
* Detects the WordPress Abilities API and canonical WooCommerce abilities without registering duplicate product or order tools.
* Publishes `/.well-known/agenticweb.md` on the store's own domain.
* Adds the discovery link tag and named crawler rules.
* Makes no external request merely because the plugin was activated or its settings page was opened.

**Optional Release Gate connection**

* Creates a short-lived, signed evidence envelope from a closed set of aggregate checks.
* Sends no customer, order, payment, email, address, product description, URL, log or raw diagnostic field.
* Supports current and previous evidence keys for controlled rotation.
* Schedules a daily send only after an administrator checks the explicit opt-in box and saves a valid connection.
* Allows a WooCommerce administrator to make a one-time manual send.

The AgentReady service combines signed aggregate evidence with public protocol checks to make a version-pinned decision. An unavailable signal becomes `UNMEASURED` or `BLOCKED`; it is not converted into a low score or a confident diagnosis. Release Gate settlement is currently disabled.

**Separate connected-commerce surface**

The discovery document can optionally advertise a connected catalog endpoint for product search, offer lookup and signed cart handoff. This is a separate product surface. It is not required for Release Gate and does not grant Release Gate access. Checkout stays on the merchant's WooCommerce store; the plugin never handles card data.

== External services ==

The plugin can connect to the AgentReady service operated by UtilityHouse at the administrator-configured HTTPS endpoint (normally `https://app.utilityhouse.xyz`).

No request is sent on activation or merely by visiting settings. A request is sent only when an administrator presses "Send Release Gate evidence now", or explicitly enables the daily schedule after entering a valid connection bundle.

The request contains: schema and collector versions, opaque AgentReady store id, generated and expiry timestamps, nonce, key generation id, family name, aggregate WooCommerce state and count, content digest, and an HMAC signature. It does not contain customer, order, payment, email, address, product description, URL, credential or raw log data.

Service terms: https://app.utilityhouse.xyz/terms.html

Service privacy policy: https://app.utilityhouse.xyz/privacy.html

== Installation ==

1. Install and activate the plugin.
2. Go to WooCommerce → AgentReady.
3. Review the local readiness snapshot and discovery document. No external connection is required for these checks.
4. To use Release Gate, create a store connection in the authenticated AgentReady dashboard.
5. Paste the HTTPS endpoint, opaque store id and derived ownership/evidence keys.
6. Use the manual send button once, or separately opt in to a daily aggregate send.

Without steps 4–6, the outbound evidence collector remains off.

== Frequently Asked Questions ==

= Does this collect customers, orders or payment data? =

No. The Release Gate schema accepts only a closed aggregate envelope. Customer, order, payment, email, address, product-description, URL, raw-body and log fields are outside that schema and are rejected by the service.

= Does activation contact AgentReady? =

No. Activation creates the local discovery routes and clears any stale schedule. It neither creates a schedule nor makes an external request.

= When is scheduled evidence enabled? =

Only after a WooCommerce administrator supplies a valid connection, checks the daily-evidence opt-in and saves settings. Clearing the checkbox removes the schedule.

= What happens when evidence cannot be measured? =

The result says `UNMEASURED` or `BLOCKED` with a finite reason code. Missing evidence is not presented as a store failure.

= Does this touch checkout? =

Release Gate does not create orders, reserve stock or handle payment credentials. The optional connected-commerce product can produce a signed cart handoff, but checkout still completes in the buyer's browser on the merchant's store.

= What does it cost? =

The plugin and public preflight are free. Release Gate settlement is disabled while operational evidence is measured. Existing AgentReady account products do not grant Release Gate access.

== Screenshots ==

1. Review the local-only readiness snapshot before connecting.
2. Configure the authenticated Release Gate connection and explicit schedule consent.
3. Send one aggregate evidence envelope manually.
4. Inspect explicit release, hold, partial or abstain outcomes in AgentReady.

== Changelog ==

= 1.2.0 =
* Added a useful local-only readiness snapshot.
* Removed automatic scheduling from activation.
* Added explicit opt-in and revocation for the daily aggregate evidence schedule.
* Separated Release Gate setup from optional connected-commerce discovery.
* Added the complete external-service disclosure.

= 1.1.0 =
* Added signed, aggregate-only Release Gate evidence.
* Added exact-once nonce handling and current/previous key rotation support.
* Added owner proof and authenticated Release Gate connection settings.

= 0.1.0 =
* Initial discovery document, crawler access, link tag and optional connected catalog.
