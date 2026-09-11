ARG WP_CLI_IMAGE=wordpress:cli-php8.3
FROM ${WP_CLI_IMAGE}

USER root
COPY wordpress-plugin/utilityhouse-release-gate-for-woocommerce /opt/utilityhouse-release-gate-for-woocommerce
COPY wordpress-plugin/utilityhouse-release-gate-for-woocommerce/integration/run.sh /run.sh
RUN chmod 0555 /run.sh

ENTRYPOINT ["/bin/bash", "/run.sh"]
