# Thin wrapper around the published Evolution API image.
# Build from the docker/ directory so the RDS CA bundle is in context:
#   docker build --platform linux/amd64 -f docker/evolution/Dockerfile -t devfathom-evolution docker
#
# v2.3.1 is the tag confirmed on Docker Hub (evoapicloud/evolution-api).
# Upstream called v2.3.7 current in April 2026; bump the ARG after checking
# the registry, and pin a digest before production.
ARG EVOLUTION_IMAGE=evoapicloud/evolution-api:v2.3.1
FROM ${EVOLUTION_IMAGE}

COPY evolution/entrypoint.sh /usr/local/bin/devfathom-evolution-entrypoint.sh
COPY rds/global-bundle.pem /etc/ssl/rds-global-bundle.pem
RUN chmod 755 /usr/local/bin/devfathom-evolution-entrypoint.sh \
  && chmod 644 /etc/ssl/rds-global-bundle.pem

ENV RDS_CA_BUNDLE=/etc/ssl/rds-global-bundle.pem \
    NODE_EXTRA_CA_CERTS=/etc/ssl/rds-global-bundle.pem \
    DATABASE_PROVIDER=postgresql

EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/devfathom-evolution-entrypoint.sh"]
