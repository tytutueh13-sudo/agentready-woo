<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class AgentReady_Woo {

	const OPTION_WORKER_URL = 'agentready_woo_worker_url';
	const SCAN_URL          = 'https://agentready.utilityhouse.xyz';

	public static function init() {
		add_action( 'admin_menu', array( __CLASS__, 'admin_menu' ) );
		add_action( 'admin_init', array( __CLASS__, 'register_settings' ) );
		add_action( 'init', array( __CLASS__, 'add_rewrite' ) );
		add_filter( 'query_vars', array( __CLASS__, 'query_vars' ) );
		add_action( 'parse_request', array( __CLASS__, 'maybe_serve_discovery' ) );
		add_filter( 'robots_txt', array( __CLASS__, 'robots_txt' ), 10, 2 );
		add_action( 'wp_head', array( __CLASS__, 'discovery_link_tag' ) );
	}

	public static function add_rewrite() {
		add_rewrite_rule( '^\.well-known/agenticweb\.md$', 'index.php?agentready_discovery=1', 'top' );
	}

	public static function query_vars( $vars ) {
		$vars[] = 'agentready_discovery';
		return $vars;
	}

	public static function maybe_serve_discovery() {
		if ( ! get_query_var( 'agentready_discovery' ) ) {
			return;
		}
		header( 'Content-Type: text/markdown; charset=utf-8' );
		echo esc_html( self::discovery_markdown() );
		exit;
	}

	public static function endpoint( $path ) {
		$worker = untrailingslashit( get_option( self::OPTION_WORKER_URL, '' ) );
		return $worker ? $worker . $path : '';
	}

	public static function discovery_markdown() {
		$feed  = self::endpoint( '/feed' );
		$mcp   = self::endpoint( '/mcp' );
		$lines = array();
		$lines[] = '# ' . get_bloginfo( 'name' );
		$lines[] = '';
		$lines[] = get_bloginfo( 'description' );
		$lines[] = '';
		$lines[] = '## Agentic commerce';
		$lines[] = '';
		if ( $feed ) {
			$lines[] = 'This store is agent-ready. Products are readable, in-stock queryable, and buyable via signed cart handoff. Checkout completes on this store.';
			$lines[] = '';
			$lines[] = '- feed: ' . $feed;
			$lines[] = '- mcp: ' . $mcp;
			$lines[] = '- protocol: MCP + signed cart handoff';
		} else {
			$lines[] = 'This store publishes WooCommerce products through its REST API.';
			$lines[] = '';
			$lines[] = '- feed: ' . esc_url( home_url( '/wp-json/wc/store/v1/products' ) );
			$lines[] = '- note: full agent commerce (offers, signed cart handoff, agent analytics) via AgentReady Woo.';
		}
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
		register_setting( 'agentready_woo', self::OPTION_WORKER_URL, array( 'type' => 'string', 'sanitize_callback' => 'esc_url_raw' ) );
	}

	public static function settings_page() {
		if ( ! current_user_can( 'manage_woocommerce' ) ) {
			return;
		}
		$worker = get_option( self::OPTION_WORKER_URL, '' );
		?>
		<div class="wrap">
			<h1>AgentReady</h1>
			<p>Makes this store readable and buyable by AI shopping agents. Checkout always completes on your own store — no card data leaves your site.</p>

			<?php if ( ! $worker ) : ?>
			<div style="max-width:640px;border-left:4px solid #E4572E;background:#fff;padding:12px 16px;margin:16px 0">
				<strong>Your store is only half agent-ready.</strong> The discovery file and robots access below help agents find you.
				Connect an AgentReady feed for offers, signed cart handoff and agent analytics —
				<a href="<?php echo esc_url( self::SCAN_URL ); ?>" target="_blank" rel="noopener">run the free scan</a> to see your store as agents see it.
			</div>
			<?php endif; ?>

			<form method="post" action="options.php">
				<?php settings_fields( 'agentready_woo' ); ?>
				<table class="form-table" role="presentation">
					<tr>
						<th scope="row"><label for="arw-worker">AgentReady endpoint</label></th>
						<td>
							<input name="<?php echo esc_attr( self::OPTION_WORKER_URL ); ?>" id="arw-worker" type="url" class="regular-text code"
								placeholder="https://mcp.utilityhouse.xyz/your-store" value="<?php echo esc_attr( $worker ); ?>" />
							<p class="description">Your AgentReady feed + MCP endpoint. Run the free scan to get yours.</p>
						</td>
					</tr>
				</table>
				<?php submit_button(); ?>
			</form>

			<h2>What agents see right now</h2>
			<p><code><a href="<?php echo esc_url( home_url( '/.well-known/agenticweb.md' ) ); ?>" target="_blank" rel="noopener"><?php echo esc_html( home_url( '/.well-known/agenticweb.md' ) ); ?></a></code></p>
			<pre style="background:#fff;border:1px solid #dcdcde;padding:12px;max-width:640px;white-space:pre-wrap"><?php echo esc_html( self::discovery_markdown() ); ?></pre>
		</div>
		<?php
	}
}
