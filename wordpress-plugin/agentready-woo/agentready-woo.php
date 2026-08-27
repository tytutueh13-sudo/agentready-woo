<?php
/**
 * Plugin Name: AgentReady Woo
 * Plugin URI:  https://agentready.utilityhouse.xyz
 * Description: Makes your WooCommerce store readable and buyable by AI shopping agents — ChatGPT, Claude, and independent agents. Publishes an agent discovery file, opens robots.txt to AI crawlers, and (optionally) connects your AgentReady feed, MCP endpoint and agent analytics.
 * Version:     0.1.0
 * Author:      AgentReady / UtilityHouse
 * Author URI:  https://agentready.utilityhouse.xyz
 * License:     GPL-2.0-or-later
 * License URI: https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain: agentready-woo
 * Requires at least: 6.0
 * Requires PHP: 7.4
 * Woo:         agentready-woo
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'AGENTREADY_WOO_VERSION', '0.1.0' );

require_once plugin_dir_path( __FILE__ ) . 'includes/class-agentready-woo.php';

AgentReady_Woo::init();

register_activation_hook( __FILE__, function () {
	require_once plugin_dir_path( __FILE__ ) . 'includes/class-agentready-woo.php';
	AgentReady_Woo::add_rewrite();
	flush_rewrite_rules();
} );

register_deactivation_hook( __FILE__, 'flush_rewrite_rules' );
