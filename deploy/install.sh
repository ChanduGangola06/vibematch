#!/usr/bin/env bash
# VibeMatch v2 one-click installer — Ubuntu 22.04 / 24.04, run as root.
#   sudo bash install.sh chat.example.com admin@example.com
# Installs Docker, generates secrets, obtains a Let's Encrypt certificate and starts the stack.
set -Eeuo pipefail

DOMAIN="${1:-}"; EMAIL="${2:-}"
APP_DIR="${APP_DIR:-/opt/vibematch}"
LOG_FILE="/var/log/vibematch-install.log"

log()  { printf '\033[0;32m[%s] %s\033[0m\n' "$(date '+%F %T')" "$*" | tee -a "$LOG_FILE"; }
fail() { printf '\033[0;31m[%s] %s\033[0m\n' "$(date '+%F %T')" "$*" | tee -a "$LOG_FILE" >&2; exit 1; }
trap 'fail "Installer failed on line $LINENO — see $LOG_FILE"' ERR

[[ $EUID -eq 0 ]] || fail "Run as root (sudo)."
[[ -n "$DOMAIN" && -n "$EMAIL" ]] || fail "Usage: sudo bash install.sh <domain> <email>"
[[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || fail "Invalid domain: $DOMAIN"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # the vibematch-v2 folder this script lives in

log "Installing Docker…"
if ! command -v docker >/dev/null; then
  apt-get update -y && apt-get install -y ca-certificates curl gnupg certbot
  curl -fsSL https://get.docker.com | sh
fi
command -v certbot >/dev/null || apt-get install -y certbot
docker compose version >/dev/null || fail "Docker Compose plugin missing."

log "Copying the application to $APP_DIR…"
mkdir -p "$APP_DIR"
cp -a "$SRC_DIR/backend" "$SRC_DIR/deploy" "$APP_DIR/"
[[ -d "$SRC_DIR/web/dist" ]] && { mkdir -p "$APP_DIR/deploy/web"; cp -a "$SRC_DIR/web/dist/." "$APP_DIR/deploy/web/"; }
mkdir -p "$APP_DIR/deploy/web"
cd "$APP_DIR/deploy"

if [[ ! -f .env ]]; then
  log "Generating secrets…"
  cat > .env <<ENV
DOMAIN=$DOMAIN
PUBLIC_URL=https://$DOMAIN
CORS_ORIGINS=https://$DOMAIN
WEBAUTHN_RP_ID=$DOMAIN
JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n')
SETTINGS_ENCRYPTION_KEY=$(openssl rand -base64 32 | tr -d '\n')
LOG_LEVEL=info
EXPOSE_OPENAPI=false
ADMIN_IP_ALLOWLIST=
ENV
  chmod 600 .env
else
  log ".env already exists — keeping your secrets."
fi

if [[ ! -d "/etc/letsencrypt/live/$DOMAIN" ]]; then
  log "Requesting a certificate for $DOMAIN…"
  command -v ufw >/dev/null && ufw allow 80,443/tcp >/dev/null || true
  certbot certonly --standalone --non-interactive --agree-tos -m "$EMAIL" -d "$DOMAIN"
  # renew twice a day; reload nginx when a certificate changed
  echo "0 3,15 * * * root certbot renew -q --deploy-hook 'docker compose -f $APP_DIR/deploy/docker-compose.yml exec -T nginx nginx -s reload'" > /etc/cron.d/vibematch-certbot
fi

log "Building and starting the stack…"
docker compose up -d --build
log "Waiting for the API to become healthy…"
for _ in $(seq 1 60); do
  curl -fsk "https://$DOMAIN/health/live" >/dev/null 2>&1 && break || sleep 3
done
curl -fsk "https://$DOMAIN/health/live" >/dev/null || fail "API did not become healthy: docker compose logs api"

log "Done. Open https://$DOMAIN/install to create the first administrator."
log "Back up $APP_DIR/deploy/.env — SETTINGS_ENCRYPTION_KEY is required to read stored secrets."
