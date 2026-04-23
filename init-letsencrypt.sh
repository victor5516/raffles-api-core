#!/bin/bash

# Detect Docker Compose command
if docker compose version &>/dev/null; then
    DOCKER_COMPOSE="docker compose"
elif docker-compose version &>/dev/null; then
    DOCKER_COMPOSE="docker-compose"
else
    echo "Error: Docker Compose no está instalado."
    echo "Instala Docker Compose con:"
    echo "  sudo mkdir -p /usr/local/lib/docker/cli-plugins"
    echo "  sudo curl -SL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-aarch64 -o /usr/local/lib/docker/cli-plugins/docker-compose"
    echo "  sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose"
    exit 1
fi

# Load variables from .env
if [ -f .env ]; then
  export $(cat .env | grep -v '#' | awk '/=/ {print $1}')
else
  echo "Error: .env file not found"
  exit 1
fi

# Dynamic domain list based on .env (single tenant by default)
domains=()
if [ -n "$DOMAIN_CLIENT_1" ]; then
  domains+=("$DOMAIN_CLIENT_1")
fi
if [ -n "${DOMAIN_CLIENT_2:-}" ]; then
  domains+=("$DOMAIN_CLIENT_2")
fi

if [ ${#domains[@]} -eq 0 ]; then
  echo "Error: define at least DOMAIN_CLIENT_1 in .env"
  exit 1
fi
rsa_key_size=4096
data_path="./certbot"
email="$SSL_EMAIL" # Email from .env
staging=0

if [ -e "$data_path" ] && [ ! -w "$data_path" ]; then
  echo "Error: $data_path exists but is not writable by $(id -un) (common if Docker created it as root)."
  echo "Fix on the host, then re-run this script:"
  echo "  sudo chown -R \"$(id -un):$(id -gn)\" \"$data_path\""
  echo "  # or reset:  sudo rm -rf \"$data_path\" && mkdir -p \"$data_path/conf\" \"$data_path/www\""
  exit 1
fi
if ! mkdir -p "$data_path/conf" "$data_path/www"; then
  echo "Error: cannot create $data_path/conf or $data_path/www"
  exit 1
fi
if ! touch "$data_path/.write_test" 2>/dev/null; then
  echo "Error: $data_path is not writable by $(id -un)."
  exit 1
fi
rm -f "$data_path/.write_test"

if [ -d "$data_path/conf/live" ] || [ -d "$data_path/conf/archive" ]; then
  read -p "Certificate data already exists in $data_path. Continue and replace? (y/N) " decision
  if [ "$decision" != "Y" ] && [ "$decision" != "y" ]; then
    exit
  fi
fi

echo "### Creating dummy certificates for $domains..."
for domain in "${domains[@]}"; do
  if [ ! -e "$data_path/conf/live/$domain/fullchain.pem" ]; then
    echo "Generating dummy for $domain..."
    $DOCKER_COMPOSE run --rm --entrypoint "\
      mkdir -p /etc/letsencrypt/live/$domain && \
      openssl req -x509 -nodes -newkey rsa:$rsa_key_size -days 1\
        -keyout '/etc/letsencrypt/live/$domain/privkey.pem' \
        -out '/etc/letsencrypt/live/$domain/fullchain.pem' \
        -subj '/CN=localhost'" certbot
  fi
done

echo "### Starting Nginx..."
$DOCKER_COMPOSE up --force-recreate -d nginx
echo "### Nginx started. Waiting for :80..."
for i in $(seq 1 30); do
  code="$(curl -sS --connect-timeout 2 -o /dev/null -w "%{http_code}" "http://127.0.0.1:80/" 2>/dev/null || echo "000")"
  if [[ "$code" =~ ^(200|301|302|404|403)$ ]]; then
    echo "Nginx is accepting connections on port 80 (HTTP $code)."
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "Error: Nginx did not become ready on http://127.0.0.1:80 . Check:  $DOCKER_COMPOSE logs nginx"
    echo "Let's Encrypt needs port 80 reachable from the internet (Security Group + DNS A for your API host -> this server's Elastic IP)."
    exit 1
  fi
  sleep 2
done

echo "### Requesting real certificates..."
for domain in "${domains[@]}"; do
  echo ">>> Processing domain: $domain"

  # Remove the dummy
  $DOCKER_COMPOSE run --rm --entrypoint "\
    rm -Rf /etc/letsencrypt/live/$domain && \
    rm -Rf /etc/letsencrypt/archive/$domain && \
    rm -Rf /etc/letsencrypt/renewal/$domain.conf" certbot

  # Request the real one
  echo "Requesting Let's Encrypt certificate for $domain..."

  if [ $staging != "0" ]; then staging_arg="--staging"; fi

  $DOCKER_COMPOSE run --rm --entrypoint "\
    certbot certonly --webroot -w /var/www/certbot \
      $staging_arg \
      --email $email \
      -d $domain \
      --rsa-key-size $rsa_key_size \
      --agree-tos \
      --force-renewal \
      --no-eff-email" certbot
done

echo "### Reloading Nginx to apply changes..."
if $DOCKER_COMPOSE exec -T nginx nginx -s reload 2>/dev/null; then
  echo "Nginx reload OK."
else
  echo "Reload failed (container may be restarting). Restarting nginx..."
  $DOCKER_COMPOSE up -d nginx
fi