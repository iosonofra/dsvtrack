#!/bin/bash
set -e

# ==============================================================================
# DSV Tracking Center - Script di setup per Debian 12 (Bookworm) su Proxmox LXC
# Ideale per l'esecuzione affidabile di Camofox (browser glibc nativo)
# ==============================================================================

BOLD='\033[1m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}${BOLD}====================================================${NC}"
echo -e "${BLUE}${BOLD}  DSV - Tracking Center · Setup per Debian 12       ${NC}"
echo -e "${BLUE}${BOLD}====================================================${NC}"

if [ "$(id -u)" -ne 0 ]; then
    echo -e "${RED}Errore: questo script deve essere eseguito come root.${NC}" >&2
    exit 1
fi

APP_DIR="/opt/dsv-tracking-center"
APP_USER="dsv"
APP_GROUP="dsv"
APP_PORT="${PORT:-3000}"
REPO_URL="${1:-}"
INSTALL_CAMOFOX="${ENABLE_CAMOFOX:-true}"

export DEBIAN_FRONTEND=noninteractive

echo ""
echo -e "${YELLOW}==> 1/6 Aggiornamento pacchetti e installazione Node.js 22 LTS...${NC}"
apt-get update
apt-get install -y --no-install-recommends curl ca-certificates gnupg git tzdata build-essential python3

# Installazione Node.js 22 LTS via NodeSource ufficiale
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d'.' -f1 | tr -d 'v')" -lt 20 ]; then
    echo "Configurazione repository Node.js 22..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y --no-install-recommends nodejs
fi
echo -e "Node.js installato: ${BOLD}$(node -v)${NC}"

if [ "${INSTALL_CAMOFOX}" = "true" ] || [ "${INSTALL_CAMOFOX}" = "1" ]; then
    echo ""
    echo -e "${YELLOW}==> 2/6 Installazione librerie grafiche e Xvfb per Camofox (Firefox nativo)...${NC}"
    apt-get install -y --no-install-recommends \
        xvfb \
        libgtk-3-0 \
        libasound2 \
        libx11-xcb1 \
        libxcomposite1 \
        libxcursor1 \
        libxdamage1 \
        libxi6 \
        libxtst6 \
        libnss3 \
        libatk1.0-0 \
        libatk-bridge2.0-0 \
        libepoxy0 \
        libgbm1 \
        libdrm2 \
        libxrandr2 \
        libxkbcommon0 \
        fonts-liberation \
        dbus \
        libdbus-glib-1-2
    
    # Assicura la presenza del machine-id per D-Bus
    dbus-uuidgen --ensure=/etc/machine-id
fi

echo ""
echo -e "${YELLOW}==> 3/6 Creazione utente di sistema '${APP_USER}'...${NC}"
if ! id "${APP_USER}" >/dev/null 2>&1; then
    useradd -r -m -d "${APP_DIR}" -s /usr/sbin/nologin "${APP_USER}"
fi

mkdir -p "${APP_DIR}/data"
mkdir -p "${APP_DIR}/data/camofox-profile"
mkdir -p "${APP_DIR}/.cache/camoufox"
mkdir -p "/var/log"

cd "${APP_DIR}"

if [ ! -f "${APP_DIR}/.env" ]; then
    if [ -f "${APP_DIR}/.env.example" ]; then
        cp "${APP_DIR}/.env.example" "${APP_DIR}/.env"
    fi
fi

echo ""
echo -e "${YELLOW}==> 4/6 Installazione dipendenze Node.js e browser Camoufox...${NC}"
if [ "${INSTALL_CAMOFOX}" = "true" ] || [ "${INSTALL_CAMOFOX}" = "1" ]; then
    npm install --omit=dev
    npm install @askjo/camofox-browser
    echo "Download binario browser Camoufox (glibc nativo per Linux x86_64)..."
    CAMOUFOX_INSTALL_DIR="${APP_DIR}/.cache/camoufox" npx camoufox-js fetch || true
else
    npm ci --omit=dev --omit=optional || npm install --omit=dev --omit=optional
fi

chown -R "${APP_USER}:${APP_GROUP}" "${APP_DIR}"

echo ""
echo -e "${YELLOW}==> 5/6 Registrazione e avvio servizi di sistema (systemd)...${NC}"
if [ -f "${APP_DIR}/scripts/dsv-tracking-center.service" ]; then
    cp "${APP_DIR}/scripts/dsv-tracking-center.service" /etc/systemd/system/
    systemctl daemon-reload
    systemctl enable --now dsv-tracking-center
    echo -e "${GREEN}Servizio Web App (porta 3000) avviato e abilitato al boot.${NC}"
fi

if [ "${INSTALL_CAMOFOX}" = "true" ] || [ "${INSTALL_CAMOFOX}" = "1" ]; then
    if [ -f "${APP_DIR}/scripts/camofox.service" ]; then
        cp "${APP_DIR}/scripts/camofox.service" /etc/systemd/system/
        systemctl daemon-reload
        systemctl enable --now camofox
        echo -e "${GREEN}Servizio Camofox (porta 9377) avviato e abilitato al boot.${NC}"
    fi
fi

IP_ADDR=$(ip -4 addr show eth0 2>/dev/null | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | head -n1 || hostname -I | awk '{print $1}' || echo "127.0.0.1")

echo ""
echo -e "${GREEN}${BOLD}====================================================${NC}"
echo -e "${GREEN}${BOLD}  Installazione completata con successo su Debian!  ${NC}"
echo -e "${GREEN}${BOLD}====================================================${NC}"
echo ""
echo -e "  Web App (UI)    : ${CYAN}${BOLD}http://${IP_ADDR}:${APP_PORT}${NC}"
if [ "${INSTALL_CAMOFOX}" = "true" ] || [ "${INSTALL_CAMOFOX}" = "1" ]; then
echo -e "  Camofox Scraper : ${GREEN}ATTIVO su http://127.0.0.1:9377 (Locale LXC)${NC}"
fi
echo ""
echo "Comandi utili (systemd):"
echo "  systemctl status dsv-tracking-center"
echo "  systemctl status camofox"
echo "  journalctl -u dsv-tracking-center -f"
echo "  journalctl -u camofox -f"
echo ""
