=== UtilityHouse Release Gate for WooCommerce ===
Contributors: shinjungwook
Tags: woocommerce, release testing, mcp, privacy, site health
Requires at least: 6.0
Tested up to: 7.1
Requires PHP: 7.4
Requires Plugins: woocommerce
Stable tag: 1.2.1
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Check WooCommerce release readiness locally, then opt in to signed aggregate evidence for an owner-authorized release decision.

== Description ==

Know what your WooCommerce store can prove before a release ships.

UtilityHouse Release Gate gives store owners, agencies and release engineers a useful local checkpoint before any external service is connected. It shows what WordPress can measure, what remains unavailable, and whether outbound evidence is still off.

When an administrator chooses to connect, the plugin signs a closed aggregate evidence envelope. UtilityHouse combines that envelope with public Store API, crawler, structured-data and MCP checks to make a version-pinned release decision. Missing or unreadable evidence stays visible instead of being turned into a reassuring score.

**Useful before connecting anything**

* Shows a local-only snapshot for HTTPS, WooCommerce availability, published-product state, discovery path and outbound-evidence status.
* Detects the WordPress Abilities API and canonical WooCommerce abilities without registering duplicate product or order tools.
* Publishes `/.well-known/agenticweb.md` on the store's own domain.
* Adds the discovery link tag and named crawler rules.
* Makes no external request merely because the plugin was activated or its settings page was opened.

**Built for an honest release decision**

* Keeps `PASS`, `HOLD`, `UNMEASURED` and `BLOCKED` distinct.
* Pins evidence to the release being checked instead of making a general store claim.
* Leaves checkout, orders, inventory and payment credentials outside the Release Gate.

**Optional Release Gate connection**

* Creates a short-lived, signed evidence envelope from a closed set of aggregate checks.
* Sends no customer, order, payment, email, address, product description, URL, log or raw diagnostic field.
* Supports current and previous evidence keys for controlled rotation.
* Schedules a daily send only after an administrator checks the explicit opt-in box and saves a valid connection.
* Allows a WooCommerce administrator to make a one-time manual send.

The UtilityHouse service combines signed aggregate evidence with public protocol checks to make a version-pinned decision. An unavailable signal becomes `UNMEASURED` or `BLOCKED`; it is not converted into a low score or a confident diagnosis. Release Gate settlement is currently disabled.

**Separate connected-commerce surface**

The discovery document can optionally advertise a connected catalog endpoint for product search, offer lookup and signed cart handoff. This is a separate product surface. It is not required for Release Gate and does not grant Release Gate access. Checkout stays on the merchant's WooCommerce store; the plugin never handles card data.

== External services ==

The plugin can connect to the UtilityHouse Release Gate service at the administrator-configured HTTPS endpoint (normally `https://app.utilityhouse.xyz`).

No request is sent on activation or merely by visiting settings. A request is sent only when an administrator presses "Send Release Gate evidence now", or explicitly enables the daily schedule after entering a valid connection bundle.

The request contains: schema and collector versions, opaque UtilityHouse store id, generated and expiry timestamps, nonce, key generation id, family name, aggregate WooCommerce state and count, content digest, and an HMAC signature. It does not contain customer, order, payment, email, address, product description, URL, credential or raw log data.

Service terms: https://app.utilityhouse.xyz/terms.html

Service privacy policy: https://app.utilityhouse.xyz/privacy.html

== Installation ==

1. Install and activate the plugin.
2. Go to WooCommerce → Release Gate.
3. Review the local readiness snapshot and discovery document. No external connection is required for these checks.
4. To use Release Gate, create a store connection in the authenticated UtilityHouse dashboard.
5. Paste the HTTPS endpoint, opaque store id and derived ownership/evidence keys.
6. Use the manual send button once, or separately opt in to a daily aggregate send.

Without steps 4–6, the outbound evidence collector remains off.

== Frequently Asked Questions ==

= Does this collect customers, orders or payment data? =

No. The Release Gate schema accepts only a closed aggregate envelope. Customer, order, payment, email, address, product-description, URL, raw-body and log fields are outside that schema and are rejected by the service.

= Does activation contact UtilityHouse? =

No. Activation creates the local discovery routes and clears any stale schedule. It neither creates a schedule nor makes an external request.

= When is scheduled evidence enabled? =

Only after a WooCommerce administrator supplies a valid connection, checks the daily-evidence opt-in and saves settings. Clearing the checkbox removes the schedule.

= What happens when evidence cannot be measured? =

The result says `UNMEASURED` or `BLOCKED` with a finite reason code. Missing evidence is not presented as a store failure.

= Does this touch checkout? =

Release Gate does not create orders, reserve stock or handle payment credentials. The optional connected-commerce product can produce a signed cart handoff, but checkout still completes in the buyer's browser on the merchant's store.

= What does it cost? =

The plugin and public preflight are free. Release Gate settlement is disabled while operational evidence is measured. Existing UtilityHouse account products do not grant Release Gate access.

== Screenshots ==

1. Review the local-only WooCommerce readiness snapshot before connecting any external service.
2. Keep the authenticated connection and daily evidence schedule off until an administrator explicitly opts in.
3. Inspect the local discovery record and send one aggregate evidence envelope only when the store owner chooses.

== Changelog ==

= 1.2.1 =
* Renamed the plugin and package to UtilityHouse Release Gate for WooCommerce.
* Built the Store API discovery URL with WordPress `rest_url()` so custom REST prefixes work correctly.

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
