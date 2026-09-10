<?php
/**
 * Plugin Name: AgentReady Release Gate for WooCommerce
 * Plugin URI:  https://app.utilityhouse.xyz
 * Description: Publishes agent discovery and sends signed, aggregate-only WooCommerce evidence for an owner-authorized AgentReady Release Gate. Optional read-only catalogue features remain separate.
 * Version:     1.2.0
 * Author:      AgentReady / UtilityHouse
 * Author URI:  https://utilityhouse.xyz
 * License:     GPL-2.0-or-later
 * License URI: https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain: agentready-woo
 * Requires at least: 6.0
 * Requires PHP: 7.4
 * Requires Plugins: woocommerce
 * Woo:         agentready-woo
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'AGENTREADY_WOO_VERSION', '1.2.0' );

require_once plugin_dir_path( __FILE__ ) . 'includes/class-agentready-woo.php';

AgentReady_Woo::init();

register_activation_hook( __FILE__, function () {
	require_once plugin_dir_path( __FILE__ ) . 'includes/class-agentready-woo.php';
	AgentReady_Woo::activate();
	flush_rewrite_rules();
} );

register_deactivation_hook( __FILE__, function () {
	AgentReady_Woo::deactivate();
	flush_rewrite_rules();
} );
register_uninstall_hook( __FILE__, array( 'AgentReady_Woo', 'uninstall_release_evidence' ) );
