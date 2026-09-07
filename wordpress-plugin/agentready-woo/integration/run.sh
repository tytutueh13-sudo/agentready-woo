#!/usr/bin/env bash
set -euo pipefail

WP="php -d memory_limit=512M /usr/local/bin/wp --allow-root --path=/var/www/html"
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "  ok  - $*"; }

echo "== Installing a disposable WordPress + WooCommerce store =="
$WP core download --force --quiet
$WP config create --dbname=wordpress --dbuser=wordpress --dbpass=agentready-harness --dbhost=db --force --quiet
$WP core install --url=http://localhost --title="AgentReady harness" --admin_user=admin --admin_password=harness-only --admin_email=admin@example.invalid --skip-email --quiet
$WP plugin install woocommerce --activate --quiet
cp -R /opt/agentready-woo /var/www/html/wp-content/plugins/agentready-woo

echo "== HPOS: ${AGENTREADY_HPOS} =="
if [ "${AGENTREADY_HPOS}" = "on" ]; then
  $WP option update woocommerce_custom_orders_table_enabled yes --quiet || true
  $WP wc hpos enable --user=admin 2>/dev/null || true
else
  $WP option update woocommerce_custom_orders_table_enabled no --quiet || true
fi

echo "== Activation is inert until explicitly connected =="
$WP plugin activate agentready-woo --quiet
for option in agentready_woo_worker_url agentready_woo_release_gate_key agentready_woo_release_store_id agentready_woo_release_evidence_current; do
  value=$($WP option get "$option" 2>/dev/null || true)
  [ -z "$value" ] || fail "$option existed before connection"
done
scheduled=$($WP cron event list --fields=hook --format=csv 2>/dev/null | grep -c '^agentready_woo_release_evidence$' || true)
[ "$scheduled" = "1" ] || fail "expected one daily evidence event, got $scheduled"
$WP eval 'if (AgentReady_Woo::run_release_evidence() !== false) { exit(1); }' || fail "unconfigured evidence sender was not inert"
ok "activation scheduled one inert aggregate collector and stored no credentials"

echo "== A real WooCommerce catalogue produces only an aggregate rollup =="
$WP eval '$product = new WC_Product_Simple(); $product->set_name("Disposable fixture"); $product->set_regular_price("10.00"); $product->set_status("publish"); $product->save();' --quiet
rollup=$($WP eval 'echo wp_json_encode(AgentReady_Woo::release_woo_rollup());')
[ "$rollup" = '{"state":"PASS","count":1}' ] || fail "unexpected real Woo rollup: $rollup"
echo "$rollup" | grep -Eiq 'product|customer|order|payment|@|http' && fail "aggregate rollup leaked a forbidden value"
ok "real Woo product becomes PASS/count=1 without product or shopper data"

echo "== Connection bundle values work and remain hidden in admin HTML =="
store_id="store_harness001"
evidence_key="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
ownership_key="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
$WP option update agentready_woo_worker_url https://app.example --quiet
$WP option update agentready_woo_release_store_id "$store_id" --quiet
$WP option update agentready_woo_release_evidence_current "$evidence_key" --quiet
$WP option update agentready_woo_release_evidence_key_id current --quiet
$WP option update agentready_woo_release_gate_key "$ownership_key" --quiet
admin_html=$($WP eval 'wp_set_current_user(1); ob_start(); AgentReady_Woo::settings_page(); echo ob_get_clean();')
echo "$admin_html" | grep -q "$evidence_key" && fail "evidence key rendered in admin HTML"
echo "$admin_html" | grep -q "$ownership_key" && fail "ownership key rendered in admin HTML"
ok "stored connection keys are write-only in the settings UI"

challenge="cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
proof_document=$(AGENTREADY_CHALLENGE="$challenge" $WP eval '$_GET["challenge"] = getenv("AGENTREADY_CHALLENGE"); $wp = (object) array("query_vars" => array("agentready_ownership" => 1)); AgentReady_Woo::maybe_serve_discovery($wp);')
proof=$(php -r '$document = json_decode($argv[1], true); echo isset($document["proof"]) ? $document["proof"] : "";' "$proof_document")
expected=$(php -r 'echo hash_hmac("sha256", $argv[1], $argv[2]);' "$challenge" "$ownership_key")
[ "$proof" = "$expected" ] || fail "ownership proof did not use the configured connection key"
ok "ownership challenge proof matches the connection contract"

discovery=$($WP eval '$wp = (object) array("query_vars" => array("agentready_discovery" => 1)); AgentReady_Woo::maybe_serve_discovery($wp);')
echo "$discovery" | grep -q '^# AgentReady harness$' || fail "parse_request did not serve the discovery document"
ok "parse_request serves both well-known routes from its actual query vars"

echo "== The real plugin emits one strict signed aggregate envelope =="
capture=$($WP eval '
global $agentready_capture_ok;
$agentready_capture_ok = false;
add_filter("pre_http_request", function($pre, $args, $url) {
  global $agentready_capture_ok;
  $body = json_decode($args["body"], true);
  $top = is_array($body) ? array_keys($body) : array();
  sort($top, SORT_STRING);
  $allowed = array("checks", "collector_version", "digest", "expires_at", "families", "generated_at", "key_id", "nonce", "schema_version", "store_id");
  sort($allowed, SORT_STRING);
  $signature = isset($args["headers"]["X-AgentReady-Evidence-Signature"]) ? $args["headers"]["X-AgentReady-Evidence-Signature"] : "";
  $serialized = wp_json_encode($body);
  $agentready_capture_ok = $url === "https://app.example/api/v2/release-evidence"
    && preg_match("/^[a-f0-9]{64}$/", $signature)
    && $top === $allowed
    && isset($body["checks"]["woo_rollup"])
    && $body["checks"]["woo_rollup"] === array("state" => "PASS", "count" => 1)
    && !preg_match("/(customer|order|payment|product|address|email|authorization|raw_)/i", $serialized)
    && strpos($serialized, get_option("agentready_woo_release_evidence_current")) === false;
  return array("headers" => array(), "body" => "", "response" => array("code" => 201, "message" => "Created"), "cookies" => array(), "filename" => null);
}, 10, 3);
if (!AgentReady_Woo::run_release_evidence() || !$agentready_capture_ok) { exit(1); }
echo "ok";
')
[ "$capture" = "ok" ] || fail "the intercepted aggregate request violated its strict contract"
ok "one signed aggregate request contains no commerce records or credential"

echo "== Invalid connection values fail closed =="
$WP eval 'if (AgentReady_Woo::sanitize_release_id("../bad") !== "" || AgentReady_Woo::sanitize_ownership_key("not-a-key") !== "") { exit(1); }' || fail "invalid id or key was accepted"
ok "invalid ids and keys are rejected"

echo "== Uninstall removes every AgentReady option and cron =="
$WP plugin deactivate agentready-woo --quiet
$WP plugin uninstall agentready-woo --skip-delete --quiet
for option in agentready_woo_worker_url agentready_woo_release_gate_key agentready_woo_release_store_id agentready_woo_release_evidence_current agentready_woo_release_evidence_previous agentready_woo_release_evidence_key_id; do
  value=$($WP option get "$option" 2>/dev/null || true)
  [ -z "$value" ] || fail "$option survived uninstall"
done
scheduled=$($WP cron event list --fields=hook --format=csv 2>/dev/null | grep -c '^agentready_woo_release_evidence$' || true)
[ "$scheduled" = "0" ] || fail "release evidence cron survived uninstall"
ok "uninstall leaves no AgentReady option or scheduled collector"

echo "PASS — WordPress $($WP core version), WooCommerce $($WP plugin get woocommerce --field=version 2>/dev/null || echo '?'), HPOS ${AGENTREADY_HPOS}"
