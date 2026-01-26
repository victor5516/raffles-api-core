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

# Dynamic domain list based on .env
domains=($DOMAIN_CLIENT_1 $DOMAIN_CLIENT_2)
rsa_key_size=4096
data_path="./certbot"
email="$SSL_EMAIL" # Email from .env
staging=0

if [ -d "$data_path" ]; then
  read -p "Data already exists in $data_path. Do you want to continue and replace certificates? (y/N) " decision
  if [ "$decision" != "Y" ] && [ "$decision" != "y" ]; then
    exit
  fi
fi

if [ ! -e "$data_path/conf/options-ssl-nginx.conf" ] || [ ! -e "$data_path/conf/ssl-dhparams.pem" ]; then
  echo "### Downloading recommended TLS parameters..."
  mkdir -p "$data_path/conf"
  curl -s https://raw.githubusercontent.com/certbot/certbot/master/certbot-nginx/certbot_nginx/_internal/tls_configs/options-ssl-nginx.conf > "$data_path/conf/options-ssl-nginx.conf"
  curl -s https://raw.githubusercontent.com/certbot/certbot/master/certbot/certbot/ssl-dhparams.pem > "$data_path/conf/ssl-dhparams.pem"
fi

echo "### Creating dummy certificates for $domains..."
for domain in "${domains[@]}"; do
  path="$data_path/conf/live/$domain"
  mkdir -p "$path"
  if [ ! -e "$path/fullchain.pem" ]; then
    echo "Generating dummy for $domain..."
    $DOCKER_COMPOSE run --rm --entrypoint "\
      openssl req -x509 -nodes -newkey rsa:$rsa_key_size -days 1\
        -keyout '/etc/letsencrypt/live/$domain/privkey.pem' \
        -out '/etc/letsencrypt/live/$domain/fullchain.pem' \
        -subj '/CN=localhost'" certbot
  fi
done

echo "### Starting Nginx..."
$DOCKER_COMPOSE up --force-recreate -d nginx
echo "### Nginx started. Waiting..."
sleep 5

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
$DOCKER_COMPOSE exec nginx nginx -s reload