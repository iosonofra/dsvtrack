#!/bin/sh
set -e

# ==============================================================================
# DSV Tracking Center - Script di installazione automatica per Alpine Linux
# ==============================================================================

BOLD='\033[1m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo "${BLUE}${BOLD}====================================================${NC}"
echo "${BLUE}${BOLD}  DSV - Tracking Center · Setup per Alpine Linux    ${NC}"
echo "${BLUE}${BOLD}====================================================${NC}"

# 1. Verifica permessi root
if [ "$(id -u)" -ne 0 ]; then
    echo "${RED}Errore: questo script deve essere eseguito come root.${NC}" >&2
    exit 1
fi

APP_DIR="/opt/dsv-tracking-center"
APP_USER="dsv"
APP_GROUP="dsv"
APP_PORT="${PORT:-3000}"
REPO_URL="${1:-}"

# 2. Aggiornamento pacchetti Alpine
echo "${YELLOW}==> 1/7 Aggiornamento pacchetti e installazione dipendenze Alpine...${NC}"
apk update
apk add --no-cache nodejs npm git curl tzdata ca-certificates

INSTALL_CAMOFOX="${ENABLE_CAMOFOX:-true}"

if [ "${INSTALL_CAMOFOX}" = "true" ] || [ "${INSTALL_CAMOFOX}" = "1" ]; then
    echo "${YELLOW}==> Installazione dipendenze C++ e browser per Camofox (DSV beta scraper)...${NC}"
    apk add --no-cache python3 make g++ sqlite-dev
    apk add --no-cache gcompat libstdc++ gtk+3.0 dbus-glib libxt alsa-lib \
        libx11 libxcomposite libxcursor libxdamage libxfixes libxi libxrandr \
        libxrender libxscrnsaver libxtst mesa-egl mesa-dri-gallium xvfb \
        font-noto font-liberation fontconfig
fi

# 3. Creazione utente di servizio dedicato (se non esiste)
echo "${YELLOW}==> 2/7 Configurazione utente di sistema '${APP_USER}'...${NC}"
if ! id "${APP_USER}" >/dev/null 2>&1; then
    adduser -D -s /sbin/nologin -h "${APP_DIR}" "${APP_USER}"
    echo "${GREEN}Utente '${APP_USER}' creato con successo.${NC}"
else
    echo "Utente '${APP_USER}' già presente."
fi

# 4. Acquisizione o preparazione directory applicazione
echo "${YELLOW}==> 3/7 Predisposizione directory applicazione in ${APP_DIR}...${NC}"
SCRIPT_SOURCE_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [ -d "${SCRIPT_SOURCE_DIR}/src" ] && [ "${SCRIPT_SOURCE_DIR}" != "${APP_DIR}" ]; then
    echo "Copia dei file sorgenti correnti in ${APP_DIR}..."
    mkdir -p "${APP_DIR}"
    cp -r "${SCRIPT_SOURCE_DIR}"/* "${APP_DIR}/"
    [ -f "${SCRIPT_SOURCE_DIR}/.env.example" ] && cp "${SCRIPT_SOURCE_DIR}/.env.example" "${APP_DIR}/"
elif [ -n "${REPO_URL}" ] && [ ! -d "${APP_DIR}/src" ]; then
    echo "Clonazione repository GitHub da ${REPO_URL}..."
    mkdir -p "${APP_DIR}"
    git clone "${REPO_URL}" "${APP_DIR}"
fi

if [ ! -f "${APP_DIR}/package.json" ]; then
    echo "${RED}Errore: ${APP_DIR}/package.json non trovato. Fornisci l'URL GitHub come argomento:${NC}" >&2
    echo "  sh $0 https://github.com/TUO-USERNAME/TUO-REPO.git" >&2
    exit 1
fi

cd "${APP_DIR}"

# 5. Configurazione file .env e directory dati
echo "${YELLOW}==> 4/7 Configurazione ambiente e cartella dati...${NC}"
mkdir -p "${APP_DIR}/data"
mkdir -p "${APP_DIR}/data/camofox-profile"
mkdir -p "${APP_DIR}/.cache/camoufox"
mkdir -p "/var/log"

if [ ! -f "${APP_DIR}/.env" ]; then
    if [ -f "${APP_DIR}/.env.example" ]; then
        cp "${APP_DIR}/.env.example" "${APP_DIR}/.env"
        echo "${GREEN}Creato file .env da .env.example (modificalo con le credenziali PrestaShop).${NC}"
    else
        cat <<EOF > "${APP_DIR}/.env"
PORT=${APP_PORT}
PRESTASHOP_URL=https://shop.example.com
PRESTASHOP_WEBSERVICE_KEY=
CAMOFOX_PORT=9377
CAMOFOX_URL=http://127.0.0.1:9377
EOF
        echo "${GREEN}Creato file .env di default.${NC}"
    fi
fi

# 6. Installazione dipendenze Node.js
echo "${YELLOW}==> 5/7 Installazione dipendenze Node.js...${NC}"
if [ "${INSTALL_CAMOFOX}" = "true" ] || [ "${INSTALL_CAMOFOX}" = "1" ]; then
    echo "Installazione completa con supporto Camofox..."
    npm install --omit=dev
    echo "Download binario del browser Camoufox..."
    CAMOUFOX_INSTALL_DIR="${APP_DIR}/.cache/camoufox" npx camoufox-js fetch || true
else
    npm ci --omit=dev --omit=optional || npm install --omit=dev --omit=optional
fi

# Assegnazione permessi
chown -R "${APP_USER}:${APP_GROUP}" "${APP_DIR}"
chown -R "${APP_USER}:${APP_GROUP}" "${APP_DIR}/data"

# 7. Installazione servizio Camofox (se abilitato)
if [ "${INSTALL_CAMOFOX}" = "true" ] || [ "${INSTALL_CAMOFOX}" = "1" ]; then
    echo "${YELLOW}==> 6/7 Installazione servizio OpenRC per Camofox (/etc/init.d/camofox)...${NC}"
    CAMOFOX_INIT="${APP_DIR}/scripts/camofox.initd"
    if [ -f "${CAMOFOX_INIT}" ]; then
        cp "${CAMOFOX_INIT}" /etc/init.d/camofox
        chmod +x /etc/init.d/camofox
        rc-update add camofox default
        rc-service camofox restart || rc-service camofox start || true
        echo "${GREEN}Servizio Camofox registrato su porta 9377.${NC}"
    fi
fi

# 8. Installazione servizio OpenRC Web App
echo "${YELLOW}==> 7/7 Installazione servizio OpenRC Web App (/etc/init.d/dsv-tracking-center)...${NC}"
INIT_SCRIPT="${APP_DIR}/scripts/dsv-tracking-center.initd"

if [ -f "${INIT_SCRIPT}" ]; then
    cp "${INIT_SCRIPT}" /etc/init.d/dsv-tracking-center
    chmod +x /etc/init.d/dsv-tracking-center
    rc-update add dsv-tracking-center default
    rc-service dsv-tracking-center restart || rc-service dsv-tracking-center start
else
    echo "${RED}Attenzione: ${INIT_SCRIPT} non trovato. Servizio OpenRC non installato.${NC}" >&2
fi

# Rilevamento IP per il messaggio finale
IP_ADDR=$(ip -4 addr show eth0 2>/dev/null | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | head -n1 || hostname -i 2>/dev/null || echo "127.0.0.1")

echo ""
echo "${GREEN}${BOLD}====================================================${NC}"
echo "${GREEN}${BOLD}  Installazione completata con successo!            ${NC}"
echo "${GREEN}${BOLD}====================================================${NC}"
echo ""
echo "  Stato Web App  : ${GREEN}ATTIVO (Porta ${APP_PORT})${NC}"
if [ "${INSTALL_CAMOFOX}" = "true" ] || [ "${INSTALL_CAMOFOX}" = "1" ]; then
echo "  Stato Camofox  : ${GREEN}ATTIVO (Porta 9377 - Solo localhost)${NC}"
fi
echo "  URL Web App    : ${BOLD}http://${IP_ADDR}:${APP_PORT}${NC}"
echo "  Cartella App   : ${APP_DIR}"
echo "  File config    : ${APP_DIR}/.env"
echo "  Log Web App    : /var/log/dsv-tracking-center.log"
echo "  Log Camofox    : /var/log/camofox.log"
echo ""
echo "Comandi utili di gestione:"
echo "  rc-service dsv-tracking-center status   (stato Web App)"
echo "  rc-service camofox status               (stato Camofox)"
echo "  rc-service dsv-tracking-center restart  (riavvia Web App)"
echo "  rc-service camofox restart              (riavvia Camofox)"
echo "  tail -f /var/log/dsv-tracking-center.log (log Web App)"
echo "  tail -f /var/log/camofox.log             (log Camofox)"
echo ""
