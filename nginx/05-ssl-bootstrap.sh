#!/bin/sh
set -e
# Runs before envsubst (20-*.sh): ensures PEMs exist so the HTTPS server block can load.

DOMAIN="${DOMAIN_CLIENT_1:-}"
if [ -z "$DOMAIN" ]; then
  echo "ERROR: DOMAIN_CLIENT_1 is not set. Set it in backend-raffles/.env for Nginx/cert paths."
  exit 1
fi

LIVE="/etc/letsencrypt/live/$DOMAIN"
if [ ! -f "$LIVE/fullchain.pem" ] || [ ! -f "$LIVE/privkey.pem" ]; then
  echo "### Bootstrapping temporary self-signed TLS files for $DOMAIN (use init-letsencrypt.sh for real certs)"
  mkdir -p "$LIVE"
  openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
    -keyout "$LIVE/privkey.pem" \
    -out "$LIVE/fullchain.pem" \
    -subj "/CN=$DOMAIN"
fi
