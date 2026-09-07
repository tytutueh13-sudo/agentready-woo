FROM wordpress:cli-php8.3

USER root
COPY wordpress-plugin/agentready-woo /opt/agentready-woo
COPY wordpress-plugin/agentready-woo/integration/run.sh /run.sh
RUN chmod 0555 /run.sh

ENTRYPOINT ["/bin/bash", "/run.sh"]
