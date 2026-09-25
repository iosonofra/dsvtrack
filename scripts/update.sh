#!/bin/sh
set -e

# ==============================================================================
# DSV Tracking Center - Script di aggiornamento rapido
# ==============================================================================

BOLD='\033[1m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "${APP_DIR}"

echo "${BLUE}${BOLD}Aggiornamento DSV - Tracking Center...${NC}"

echo "${YELLOW}==> 1/3 Scaricamento ultimi aggiornamenti da GitHub...${NC}"
if [ -d .git ]; then
    git pull
else
    echo "Nessun repository Git rilevato (.git assente): aggiornamento basato su archivio/file locali."
fi

echo "${YELLOW}==> 2/3 Aggiornamento dipendenze...${NC}"
if [ -f /etc/init.d/camofox ]; then
    echo "Supporto Camofox attivo: aggiornamento con dipendenze browser..."
    npm install --omit=dev
else
    npm ci --omit=dev --omit=optional || npm install --omit=dev --omit=optional
fi

# Preserva permessi
chown -R dsv:dsv "${APP_DIR}" 2>/dev/null || true

echo "${YELLOW}==> 3/3 Riavvio dei servizi...${NC}"
if command -v rc-service >/dev/null 2>&1; then
    if [ -f /etc/init.d/camofox ]; then
        rc-service camofox restart || rc-service camofox start || true
        echo "${GREEN}Servizio Camofox riavviato.${NC}"
    fi
    rc-service dsv-tracking-center restart
    echo "${GREEN}Servizio OpenRC dsv-tracking-center riavviato.${NC}"
elif command -v systemctl >/dev/null 2>&1; then
    if systemctl is-enabled --quiet camofox 2>/dev/null || [ -f /etc/systemd/system/camofox.service ]; then
        systemctl restart camofox || true
        echo "${GREEN}Servizio Camofox riavviato.${NC}"
    fi
    systemctl restart dsv-tracking-center
    echo "${GREEN}Servizio systemd dsv-tracking-center riavviato.${NC}"
else
    echo "Riavvia manualmente il processo dell'applicazione."
fi

echo ""
echo "${GREEN}${BOLD}Aggiornamento completato con successo!${NC}"
