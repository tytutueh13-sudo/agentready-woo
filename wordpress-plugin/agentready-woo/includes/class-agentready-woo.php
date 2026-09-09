<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class AgentReady_Woo {
	/** Aggregate-only Release Gate envelope. Callers provide the derived key;
	 * this collector never reads customers, orders, payments, or credentials. */
	public static function release_gate_evidence_envelope( $store_id, $key, $nonce, $checks, $key_id = 'current' ) {
		$key_id = $key_id === 'previous' ? 'previous' : 'current';
		$now = gmdate( 'c' );
		$body = array( 'schema_version' => '2026-09-06', 'store_id' => $store_id, 'generated_at' => $now, 'expires_at' => gmdate( 'c', time() + 300 ), 'nonce' => $nonce, 'key_id' => $key_id, 'collector_version' => AGENTREADY_WOO_VERSION, 'families' => array( 'woo' ), 'checks' => $checks );
		ksort( $body['checks'] ); sort( $body['families'], SORT_STRING );
		$canonical = wp_json_encode( $body, JSON_UNESCAPED_SLASHES );
		$body['digest'] = hash( 'sha256', $canonical );
		return array( 'evidence' => $body, 'signature' => hash_hmac( 'sha256', $canonical, $key ) );
	}

	/** Send only the closed aggregate envelope. `$derived_key` is the per-store,
	 * per-key-generation value from the authenticated connection bundle; neither that value nor
	 * the HTTP body is persisted or logged by this plugin. */
	public static function submit_release_gate_evidence( $endpoint, $store_id, $derived_key, $nonce, $checks, $key_id = 'current' ) {
		$origin = self::sanitize_worker_origin( $endpoint );
		if ( ! function_exists( 'wp_remote_post' ) || ! $origin ) {
			return new WP_Error( 'agentready_release_evidence_unavailable' );
		}
		$envelope = self::release_gate_evidence_envelope( $store_id, $derived_key, $nonce, $checks, $key_id );
		return wp_remote_post( $origin . '/api/v2/release-evidence', array(
			'timeout' => 10,
			'redirection' => 0,
			'headers' => array(
				'Content-Type' => 'application/json',
				'X-AgentReady-Evidence-Signature' => $envelope['signature'],
			),
			'body' => wp_json_encode( $envelope['evidence'], JSON_UNESCAPED_SLASHES ),
		) );
	}

	const OPTION_WORKER_URL = 'agentready_woo_worker_url';
	const OPTION_OWNERSHIP_KEY = 'agentready_woo_release_gate_key';
	const OPTION_RELEASE_STORE_ID = 'agentready_woo_release_store_id';
	const OPTION_RELEASE_CURRENT_KEY = 'agentready_woo_release_evidence_current';
	const OPTION_RELEASE_PREVIOUS_KEY = 'agentready_woo_release_evidence_previous';
	const OPTION_RELEASE_KEY_ID = 'agentready_woo_release_evidence_key_id';
	const OPTION_RELEASE_ENABLED = 'agentready_woo_release_evidence_enabled';
	const CRON_RELEASE_EVIDENCE = 'agentready_woo_release_evidence';
	const SCAN_URL          = 'https://app.utilityhouse.xyz';

	public static function init() {
		add_action( 'admin_menu', array( __CLASS__, 'admin_menu' ) );
		add_action( 'admin_init', array( __CLASS__, 'register_settings' ) );
		add_action( 'init', array( __CLASS__, 'add_rewrite' ) );
		add_action( 'init', array( __CLASS__, 'sync_release_evidence_schedule' ), 20 );
		add_filter( 'query_vars', array( __CLASS__, 'query_vars' ) );
		add_action( 'parse_request', array( __CLASS__, 'maybe_serve_discovery' ), 10, 1 );
		add_filter( 'robots_txt', array( __CLASS__, 'robots_txt' ), 10, 2 );
		add_action( 'wp_head', array( __CLASS__, 'discovery_link_tag' ) );
		add_action( 'admin_post_agentready_release_evidence', array( __CLASS__, 'admin_submit_release_evidence' ) );
		add_action( self::CRON_RELEASE_EVIDENCE, array( __CLASS__, 'run_release_evidence' ) );
	}

	/** Activation publishes local discovery only. Outbound evidence is never
	 * scheduled until a WooCommerce administrator explicitly enables it. */
	public static function activate() {
		self::add_rewrite();
		if ( function_exists( 'wp_clear_scheduled_hook' ) ) {
			wp_clear_scheduled_hook( self::CRON_RELEASE_EVIDENCE );
		}
	}

	public static function deactivate() {
		if ( function_exists( 'wp_clear_scheduled_hook' ) ) {
			wp_clear_scheduled_hook( self::CRON_RELEASE_EVIDENCE );
		}
	}

	public static function release_connection_ready() {
		$endpoint = get_option( self::OPTION_WORKER_URL, '' );
		$store_id = get_option( self::OPTION_RELEASE_STORE_ID, '' );
		$key_id = get_option( self::OPTION_RELEASE_KEY_ID, 'current' );
		$key = get_option( $key_id === 'previous' ? self::OPTION_RELEASE_PREVIOUS_KEY : self::OPTION_RELEASE_CURRENT_KEY, '' );
		return self::sanitize_worker_origin( $endpoint ) !== ''
			&& self::sanitize_release_id( $store_id )
			&& preg_match( '/^[a-f0-9]{64}$/', (string) $key );
	}

	public static function sync_release_evidence_schedule() {
		if ( ! function_exists( 'wp_next_scheduled' ) || ! function_exists( 'wp_clear_scheduled_hook' ) ) {
			return;
		}
		$enabled = get_option( self::OPTION_RELEASE_ENABLED, '0' ) === '1';
		$scheduled = wp_next_scheduled( self::CRON_RELEASE_EVIDENCE );
		if ( $enabled && self::release_connection_ready() && ! $scheduled ) {
			wp_schedule_event( time() + 300, 'daily', self::CRON_RELEASE_EVIDENCE );
		} elseif ( ( ! $enabled || ! self::release_connection_ready() ) && $scheduled ) {
			wp_clear_scheduled_hook( self::CRON_RELEASE_EVIDENCE );
		}
	}

	public static function add_rewrite() {
		add_rewrite_rule( '^\.well-known/agenticweb\.md$', 'index.php?agentready_discovery=1', 'top' );
		add_rewrite_rule( '^\.well-known/agentready-ownership$', 'index.php?agentready_ownership=1', 'top' );
	}

	public static function query_vars( $vars ) {
		$vars[] = 'agentready_discovery';
		$vars[] = 'agentready_ownership';
		return $vars;
	}

	public static function maybe_serve_discovery( $wp = null ) {
		$query_vars = is_object( $wp ) && isset( $wp->query_vars ) && is_array( $wp->query_vars ) ? $wp->query_vars : array();
		$ownership = ! empty( $query_vars['agentready_ownership'] ) || ( function_exists( 'get_query_var' ) && get_query_var( 'agentready_ownership' ) );
		$discovery = ! empty( $query_vars['agentready_discovery'] ) || ( function_exists( 'get_query_var' ) && get_query_var( 'agentready_discovery' ) );
		if ( $ownership ) {
			self::serve_ownership_proof();
		}
		if ( ! $discovery ) {
			return;
		}
		header( 'Content-Type: text/markdown; charset=utf-8' );
		echo esc_html( self::discovery_markdown() );
		exit;
	}

	/** A short-lived ownership proof only. It never creates a cart, order,
	 * reservation, email, webhook or payment. The configured key is a
	 * per-store HMAC key and is never emitted, logged, or placed in the URL. */
	public static function serve_ownership_proof() {
		// Public, read-only challenge endpoint; no session or WordPress state is mutated.
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended
		$challenge = isset( $_GET['challenge'] ) ? sanitize_text_field( wp_unslash( $_GET['challenge'] ) ) : '';
		$key = (string) get_option( self::OPTION_OWNERSHIP_KEY, '' );
		if ( ! preg_match( '/^[a-f0-9]{64}$/', $key ) || ! preg_match( '/^[a-f0-9]{32,128}$/', $challenge ) ) {
			status_header( 404 );
			header( 'Content-Type: application/json; charset=utf-8' );
			echo wp_json_encode( array( 'code' => 'ownership_proof_unavailable' ) );
			exit;
		}
		header( 'Cache-Control: no-store' );
		self::allow_dashboard_origin();
		header( 'Content-Type: application/json; charset=utf-8' );
		echo wp_json_encode( array( 'challenge' => $challenge, 'proof' => hash_hmac( 'sha256', $challenge, $key ) ) );
		exit;
	}

	/** The authenticated dashboard verifies control by fetching this public
	 * proof in the merchant's browser. Permit only the exact configured Worker
	 * origin; never reflect an arbitrary Origin and never allow credentials. */
	public static function allow_dashboard_origin() {
		$origin = isset( $_SERVER['HTTP_ORIGIN'] ) ? sanitize_url( wp_unslash( $_SERVER['HTTP_ORIGIN'] ) ) : '';
		$worker = (string) get_option( self::OPTION_WORKER_URL, '' );
		$parts = wp_parse_url( $worker );
		if ( ! is_array( $parts ) || ( $parts['scheme'] ?? '' ) !== 'https' || empty( $parts['host'] ) ) {
			return;
		}
		$expected = 'https://' . strtolower( (string) $parts['host'] );
		if ( isset( $parts['port'] ) ) {
			$expected .= ':' . (int) $parts['port'];
		}
		if ( $origin !== $expected ) {
			return;
		}
		header( 'Access-Control-Allow-Origin: ' . $expected );
		header( 'Vary: Origin', false );
	}

	public static function discovery_markdown() {
		$lines = array();
		$lines[] = '# ' . get_bloginfo( 'name' );
		$lines[] = '';
		$lines[] = get_bloginfo( 'description' );
		$lines[] = '';
		$lines[] = '## AgentReady Release Gate';
		$lines[] = '';
		$lines[] = 'This plugin publishes a local discovery record. It does not claim that a store or release passed AgentReady checks.';
		$lines[] = '';
		$lines[] = '- public Store API: ' . esc_url( home_url( '/wp-json/wc/store/v1/products' ) );
		$lines[] = '- passive preflight: ' . self::SCAN_URL;
		$lines[] = '- owner evidence: sent only after explicit administrator consent';
		$lines[] = '';
		return implode( "\n", $lines );
	}

	public static function robots_txt( $output, $public ) {
		if ( ! $public ) {
			return $output;
		}
		$agents = array( 'GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-SearchBot', 'Claude-User', 'PerplexityBot', 'Google-Extended', 'Applebot-Extended', 'CCBot' );
		$lines  = array( '', '# AgentReady Woo: AI shopping agents are welcome' );
		foreach ( $agents as $agent ) {
			$lines[] = 'User-agent: ' . $agent;
			$lines[] = 'Allow: /';
		}
		$lines[] = '';
		return $output . implode( "\n", $lines );
	}

	public static function discovery_link_tag() {
		printf( '<link rel="agenticweb" href="%s" />' . "\n", esc_url( home_url( '/.well-known/agenticweb.md' ) ) );
	}

	public static function admin_menu() {
		add_submenu_page(
			'woocommerce',
			'AgentReady',
			'AgentReady',
			'manage_woocommerce',
			'agentready-woo',
			array( __CLASS__, 'settings_page' )
		);
	}

	public static function register_settings() {
		register_setting( 'agentready_woo', self::OPTION_WORKER_URL, array( 'type' => 'string', 'sanitize_callback' => array( __CLASS__, 'sanitize_worker_origin' ) ) );
		register_setting( 'agentready_woo', self::OPTION_OWNERSHIP_KEY, array( 'type' => 'string', 'sanitize_callback' => function( $v ) { return self::sanitize_release_key( $v, self::OPTION_OWNERSHIP_KEY ); } ) );
		register_setting( 'agentready_woo', self::OPTION_RELEASE_STORE_ID, array( 'type' => 'string', 'sanitize_callback' => array( __CLASS__, 'sanitize_release_id' ) ) );
		register_setting( 'agentready_woo', self::OPTION_RELEASE_CURRENT_KEY, array( 'type' => 'string', 'sanitize_callback' => function( $v ) { return self::sanitize_release_key( $v, self::OPTION_RELEASE_CURRENT_KEY ); } ) );
		register_setting( 'agentready_woo', self::OPTION_RELEASE_PREVIOUS_KEY, array( 'type' => 'string', 'sanitize_callback' => function( $v ) { return self::sanitize_release_key( $v, self::OPTION_RELEASE_PREVIOUS_KEY ); } ) );
		register_setting( 'agentready_woo', self::OPTION_RELEASE_KEY_ID, array( 'type' => 'string', 'sanitize_callback' => function( $v ) { return $v === 'previous' ? 'previous' : 'current'; } ) );
		register_setting( 'agentready_woo', self::OPTION_RELEASE_ENABLED, array( 'type' => 'string', 'sanitize_callback' => function( $v ) { return $v === '1' ? '1' : '0'; } ) );
	}

	public static function sanitize_release_id( $value ) { return preg_match( '/^[A-Za-z0-9_-]{8,100}$/', (string) $value ) ? $value : ''; }
	/** Accept one HTTPS service origin only. Paths and credentials would change
	 * where evidence is sent and are therefore rejected instead of normalized. */
	public static function sanitize_worker_origin( $value ) {
		$value = trim( (string) $value );
		$parts = wp_parse_url( $value );
		if ( ! is_array( $parts ) || ( $parts['scheme'] ?? '' ) !== 'https' || ( $parts['host'] ?? '' ) !== 'app.utilityhouse.xyz'
			|| ! empty( $parts['user'] ) || ! empty( $parts['pass'] ) || ! empty( $parts['query'] ) || ! empty( $parts['fragment'] )
			|| isset( $parts['port'] ) || ( isset( $parts['path'] ) && $parts['path'] !== '' && $parts['path'] !== '/' ) ) {
			return '';
		}
		return self::SCAN_URL;
	}
	/** Blank password fields preserve a configured derived key, so opening the
	 * settings page can never disclose or accidentally erase it. */
	public static function sanitize_release_key( $value, $option ) { if ( trim( (string) $value ) === '' ) return (string) get_option( $option, '' ); return self::sanitize_ownership_key( $value ); }
	/** Read-only aggregate only: Woo availability is represented by a count,
	 * never product/customer/order/payment values or URLs. */
	public static function release_woo_rollup() { if ( ! function_exists( 'wc_get_products' ) ) return array( 'state' => 'UNMEASURED', 'count' => 0 ); try { $ids = wc_get_products( array( 'limit' => 1, 'return' => 'ids', 'status' => 'publish' ) ); if ( ! is_array( $ids ) ) return array( 'state' => 'FAIL', 'count' => 0 ); return array( 'state' => count( $ids ) > 0 ? 'PASS' : 'FAIL', 'count' => count( $ids ) ); } catch ( Throwable $e ) { return array( 'state' => 'UNMEASURED', 'count' => 0 ); } }
	public static function run_release_evidence( $manual = false ) { if ( ! $manual && get_option( self::OPTION_RELEASE_ENABLED, '0' ) !== '1' ) return false; $endpoint = get_option( self::OPTION_WORKER_URL, '' ); $store_id = get_option( self::OPTION_RELEASE_STORE_ID, '' ); $key_id = get_option( self::OPTION_RELEASE_KEY_ID, 'current' ); $key = get_option( $key_id === 'previous' ? self::OPTION_RELEASE_PREVIOUS_KEY : self::OPTION_RELEASE_CURRENT_KEY, '' ); if ( ! self::release_connection_ready() ) return false; $nonce = wp_generate_password( 32, false, false ); $response = self::submit_release_gate_evidence( $endpoint, $store_id, $key, $nonce, array( 'woo_rollup' => self::release_woo_rollup() ), $key_id ); return ! is_wp_error( $response ) && wp_remote_retrieve_response_code( $response ) >= 200 && wp_remote_retrieve_response_code( $response ) < 300; }
	public static function admin_submit_release_evidence() { if ( ! current_user_can( 'manage_woocommerce' ) || ! check_admin_referer( 'agentready_release_evidence' ) ) wp_die( 'forbidden' ); $sent = self::run_release_evidence( true ); wp_safe_redirect( add_query_arg( 'agentready_evidence', $sent ? 'sent' : 'failed', admin_url( 'admin.php?page=agentready-woo' ) ) ); exit; }
	public static function uninstall_release_evidence() { wp_clear_scheduled_hook( self::CRON_RELEASE_EVIDENCE ); foreach ( array( self::OPTION_WORKER_URL, self::OPTION_OWNERSHIP_KEY, self::OPTION_RELEASE_STORE_ID, self::OPTION_RELEASE_CURRENT_KEY, self::OPTION_RELEASE_PREVIOUS_KEY, self::OPTION_RELEASE_KEY_ID, self::OPTION_RELEASE_ENABLED ) as $key ) delete_option( $key ); }

	/** Local-only snapshot. It performs no HTTP request and returns no product,
	 * shopper, order or payment record. */
	public static function canonical_woo_abilities_available() {
		if ( ! function_exists( 'wp_get_ability' ) ) {
			return false;
		}
		return null !== wp_get_ability( 'woocommerce/products-query' )
			|| null !== wp_get_ability( 'woocommerce/product-create' );
	}

	public static function local_readiness_snapshot() {
		$home = function_exists( 'home_url' ) ? home_url( '/' ) : '';
		$https = strpos( (string) $home, 'https://' ) === 0;
		$woo = function_exists( 'wc_get_products' );
		$rollup = self::release_woo_rollup();
		return array(
			'https' => $https ? 'PASS' : 'HOLD',
			'woocommerce' => $woo ? 'PASS' : 'UNMEASURED',
			'published_product' => $rollup['state'],
			'wordpress_abilities_api' => function_exists( 'wp_register_ability' ) ? 'AVAILABLE' : 'NOT_AVAILABLE',
			'woocommerce_canonical_abilities' => self::canonical_woo_abilities_available() ? 'DETECTED' : 'NOT_DETECTED',
			'agentready_store_abilities' => 'NONE_REGISTERED',
			'discovery_path' => '/.well-known/agenticweb.md',
			'outbound_evidence' => get_option( self::OPTION_RELEASE_ENABLED, '0' ) === '1' ? 'ENABLED' : 'OFF',
		);
	}

	public static function sanitize_ownership_key( $value ) {
		$value = strtolower( preg_replace( '/[^a-f0-9]/', '', (string) $value ) );
		return strlen( $value ) === 64 ? $value : '';
	}

	public static function settings_page() {
		if ( ! current_user_can( 'manage_woocommerce' ) ) {
			return;
		}
		$worker = get_option( self::OPTION_WORKER_URL, '' );
		$release_store = get_option( self::OPTION_RELEASE_STORE_ID, '' );
		$release_key_id = get_option( self::OPTION_RELEASE_KEY_ID, 'current' );
		$release_enabled = get_option( self::OPTION_RELEASE_ENABLED, '0' ) === '1';
		$snapshot = self::local_readiness_snapshot();
		// Display-only result from our nonce-protected admin redirect; no state is mutated.
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended
		$evidence_notice = isset( $_GET['agentready_evidence'] ) ? sanitize_key( wp_unslash( $_GET['agentready_evidence'] ) ) : '';
		?>
		<div class="wrap">
			<h1>AgentReady Release Gate</h1>
			<p>Inspect local WooCommerce readiness first. Connect only when you want an owner-authorized, version-pinned release decision from signed aggregate evidence.</p>
			<?php if ( $evidence_notice ) : ?><div class="notice notice-<?php echo $evidence_notice === 'sent' ? 'success' : 'error'; ?>"><p><?php echo $evidence_notice === 'sent' ? esc_html__( 'Aggregate evidence sent.', 'agentready-woo' ) : esc_html__( 'Evidence was not sent. Check the HTTPS endpoint, store id and derived key.', 'agentready-woo' ); ?></p></div><?php endif; ?>

			<h2>Local readiness snapshot</h2>
			<p>This table is computed inside WordPress. Opening it makes no external request.</p>
			<table class="widefat striped" style="max-width:760px"><tbody>
			<?php foreach ( $snapshot as $label => $value ) : ?><tr><th scope="row"><?php echo esc_html( ucwords( str_replace( '_', ' ', $label ) ) ); ?></th><td><code><?php echo esc_html( $value ); ?></code></td></tr><?php endforeach; ?>
			</tbody></table>

			<form method="post" action="options.php">
				<?php settings_fields( 'agentready_woo' ); ?>
				<table class="form-table" role="presentation">
					<tr>
						<th scope="row"><label for="arw-worker">AgentReady endpoint</label></th>
						<td>
							<input name="<?php echo esc_attr( self::OPTION_WORKER_URL ); ?>" id="arw-worker" type="url" class="regular-text code"
								placeholder="https://app.utilityhouse.xyz" value="<?php echo esc_attr( $worker ); ?>" />
							<p class="description">The HTTPS AgentReady service endpoint from your authenticated connection bundle. Saving this alone sends nothing.</p>
						</td>
					</tr>
					<tr><th scope="row"><label for="arw-release-store">Release Gate store id</label></th><td><input name="<?php echo esc_attr( self::OPTION_RELEASE_STORE_ID ); ?>" id="arw-release-store" type="text" class="regular-text code" value="<?php echo esc_attr( $release_store ); ?>" /><p class="description">The opaque store id from your authenticated AgentReady connection bundle.</p></td></tr>
					<tr><th scope="row"><label for="arw-release-current">Release Gate derived keys</label></th><td><input name="<?php echo esc_attr( self::OPTION_RELEASE_CURRENT_KEY ); ?>" id="arw-release-current" type="password" class="regular-text code" autocomplete="new-password" value="" placeholder="Current key (leave blank to keep)" /><br /><input name="<?php echo esc_attr( self::OPTION_RELEASE_PREVIOUS_KEY ); ?>" type="password" class="regular-text code" autocomplete="new-password" value="" placeholder="Previous key during rotation (optional)" /><p class="description">These per-store derived keys are never displayed after save and are used only for short-lived evidence signatures.</p></td></tr>
					<tr><th scope="row"><label for="arw-release-key-id">Active derived key</label></th><td><select name="<?php echo esc_attr( self::OPTION_RELEASE_KEY_ID ); ?>" id="arw-release-key-id"><option value="current" <?php selected( $release_key_id, 'current' ); ?>>Current</option><option value="previous" <?php selected( $release_key_id, 'previous' ); ?>>Previous</option></select></td></tr>
					<tr><th scope="row">Scheduled evidence</th><td><label><input name="<?php echo esc_attr( self::OPTION_RELEASE_ENABLED ); ?>" type="checkbox" value="1" <?php checked( $release_enabled ); ?> /> Enable one signed aggregate evidence send per day</label><p class="description">Off by default. When enabled with a valid connection, this sends only collector version, opaque store id, timestamp, nonce, key id, Woo family name and aggregate PASS/FAIL/UNMEASURED state with count. Disable it here to remove the schedule.</p></td></tr>
					<tr>
						<th scope="row"><label for="arw-release-key">Release Gate ownership key</label></th>
						<td><input name="<?php echo esc_attr( self::OPTION_OWNERSHIP_KEY ); ?>" id="arw-release-key" type="password" class="regular-text code" autocomplete="new-password" value="" placeholder="Ownership key (leave blank to keep)" />
							<p class="description">Paste the 64-character per-store key from your authenticated AgentReady connection bundle. It is never displayed after save and is used only to HMAC short-lived ownership challenges.</p></td>
					</tr>
				</table>
				<?php submit_button(); ?>
			</form>
			<h2>Release Gate evidence</h2>
			<p>The button is explicit one-time consent to contact the configured AgentReady service. It checks only whether a published product exists and never transmits product details, customers, orders, payments, or credentials.</p>
			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>"><input type="hidden" name="action" value="agentready_release_evidence" /><?php wp_nonce_field( 'agentready_release_evidence' ); submit_button( 'Send Release Gate evidence now', 'secondary', 'submit', false ); ?></form>

			<details style="max-width:760px;margin-top:28px"><summary><strong>Public agent discovery</strong></summary><p>This local document links the public Store API and passive preflight without asserting that either has passed.</p>
			<h2>What agents see right now</h2>
			<p><code><a href="<?php echo esc_url( home_url( '/.well-known/agenticweb.md' ) ); ?>" target="_blank" rel="noopener"><?php echo esc_html( home_url( '/.well-known/agenticweb.md' ) ); ?></a></code></p>
			<pre style="background:#fff;border:1px solid #dcdcde;padding:12px;max-width:640px;white-space:pre-wrap"><?php echo esc_html( self::discovery_markdown() ); ?></pre>
			</details>
		</div>
		<?php
	}
}
