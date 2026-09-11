<?php
/**
 * Plugin Name: UtilityHouse Release Gate for WooCommerce
 * Plugin URI:  https://app.utilityhouse.xyz
 * Description: Checks WooCommerce release readiness locally and optionally sends signed, aggregate-only evidence to UtilityHouse.
 * Version:     1.2.1
 * Author:      UtilityHouse
 * Author URI:  https://utilityhouse.xyz
 * License:     GPL-2.0-or-later
 * License URI: https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain: utilityhouse-release-gate-for-woocommerce
 * Requires at least: 6.0
 * Requires PHP: 7.4
 * Requires Plugins: woocommerce
 * Woo:         utilityhouse-release-gate-for-woocommerce
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'UTILITYHOUSE_RELEASE_GATE_VERSION', '1.2.1' );

require_once plugin_dir_path( __FILE__ ) . 'includes/class-utilityhouse-release-gate.php';

UtilityHouse_Release_Gate::init();

register_activation_hook( __FILE__, function () {
	require_once plugin_dir_path( __FILE__ ) . 'includes/class-utilityhouse-release-gate.php';
	UtilityHouse_Release_Gate::activate();
	flush_rewrite_rules();
} );

register_deactivation_hook( __FILE__, function () {
	UtilityHouse_Release_Gate::deactivate();
	flush_rewrite_rules();
} );
register_uninstall_hook( __FILE__, array( 'UtilityHouse_Release_Gate', 'uninstall_release_evidence' ) );
