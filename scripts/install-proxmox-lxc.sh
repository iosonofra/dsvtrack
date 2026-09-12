#!/bin/bash
set -e

# ==============================================================================
# DSV Tracking Center - Proxmox VE Automated LXC Creator (Alpine Linux)
# Da eseguire direttamente nella shell dell'host Proxmox VE
# ==============================================================================

BOLD='\033[1m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

echo ""
echo -e "${BLUE}${BOLD}==============================================================${NC}"
echo -e "${BLUE}${BOLD}   DSV - Tracking Center · Installazione Automatica Proxmox   ${NC}"
echo -e "${BLUE}${BOLD}   LXC Container Ultraleggero (Alpine Linux + Node.js)        ${NC}"
echo -e "${BLUE}${BOLD}==============================================================${NC}"
echo ""

# 1. Verifica ambiente Proxmox VE
if ! command -v pveversion >/dev/null 2>&1; then
    echo -e "${RED}Errore: questo script deve essere eseguito su un host Proxmox VE.${NC}" >&2
    exit 1
fi

# 2. Parametri di default e interattivi
NEXT_ID=$(pvesh get /cluster/nextid 2>/dev/null || echo "150")

read -rp "$(echo -e "${CYAN}Container ID [${NEXT_ID}]: ${NC}")" INPUT_CTID
CTID="${INPUT_CTID:-$NEXT_ID}"

read -rp "$(echo -e "${CYAN}Hostname container [dsv-tracking]: ${NC}")" INPUT_HOSTNAME
CT_HOSTNAME="${INPUT_HOSTNAME:-dsv-tracking}"

# Rilevamento storage predefinito per container
DEFAULT_STORAGE=$(pvesm status -content rootdir 2>/dev/null | awk 'NR>1 && $3=="active" {print $1; exit}' || echo "local-lvm")
read -rp "$(echo -e "${CYAN}Storage per il disco LXC [${DEFAULT_STORAGE}]: ${NC}")" INPUT_STORAGE
CT_STORAGE="${INPUT_STORAGE:-$DEFAULT_STORAGE}"

# Rilevamento storage per i template (vztmpl)
DEFAULT_TMPL_STORAGE=$(pvesm status -content vztmpl 2>/dev/null | awk 'NR>1 && $3=="active" {print $1; exit}' || echo "local")

# Opzione Camofox sullo stesso LXC
read -rp "$(echo -e "${CYAN}Vuoi installare anche Camofox per lo scraper beta DSV nello stesso LXC? [S/n]: ${NC}")" INPUT_CAMOFOX
case "$INPUT_CAMOFOX" in
    [nN][oO]|[nN])
        INSTALL_CAMOFOX="false"
        DEFAULT_DISK="4"
        DEFAULT_RAM="512"
        ;;
    *)
        INSTALL_CAMOFOX="true"
        DEFAULT_DISK="8"
        DEFAULT_RAM="1536"
        ;;
esac

read -rp "$(echo -e "${CYAN}Dimensione disco in GB [${DEFAULT_DISK}]: ${NC}")" INPUT_DISK
CT_DISK="${INPUT_DISK:-$DEFAULT_DISK}"

read -rp "$(echo -e "${CYAN}RAM in MB [${DEFAULT_RAM}]${INSTALL_CAMOFOX:+ (minimo 1536MB raccomandati per Camofox)}: ${NC}")" INPUT_RAM
CT_RAM="${INPUT_RAM:-$DEFAULT_RAM}"

read -rp "$(echo -e "${CYAN}Cores CPU [2]: ${NC}")" INPUT_CORES
CT_CORES="${INPUT_CORES:-2}"

read -rp "$(echo -e "${CYAN}Bridge di rete [vmbr0]: ${NC}")" INPUT_BRIDGE
CT_BRIDGE="${INPUT_BRIDGE:-vmbr0}"

read -rp "$(echo -e "${CYAN}Indirizzo IP [dhcp] (oppure es. 192.168.1.50/24): ${NC}")" INPUT_IP
CT_IP="${INPUT_IP:-dhcp}"

if [ "${CT_IP}" != "dhcp" ]; then
    read -rp "$(echo -e "${CYAN}Gateway predefinito (es. 192.168.1.1): ${NC}")" CT_GW
fi

read -rp "$(echo -e "${CYAN}URL Repository GitHub [https://github.com/USERNAME/REPO.git]: ${NC}")" GITHUB_REPO

echo ""
echo -e "${YELLOW}==> 1/5 Download template Alpine Linux più recente...${NC}"
pveam update >/dev/null 2>&1 || true

# Ricerca template Alpine più recente (3.21 -> 3.20 -> standard)
TEMPLATE_NAME=$(pveam available --section system | awk '{print $2}' | grep -E '^alpine-[0-9]+\.[0-9]+' | sort -V | tail -n1)
if [ -z "${TEMPLATE_NAME}" ]; then
    TEMPLATE_NAME="alpine-3.21-default_20241203_amd64.tar.xz"
fi

# Verifica se già scaricato
if ! pveam list "${DEFAULT_TMPL_STORAGE}" | grep -q "${TEMPLATE_NAME}"; then
    echo "Download di ${TEMPLATE_NAME} nello storage ${DEFAULT_TMPL_STORAGE}..."
    pveam download "${DEFAULT_TMPL_STORAGE}" "${TEMPLATE_NAME}"
else
    echo "Template ${TEMPLATE_NAME} già presente nella cache locale."
fi

FULL_TEMPLATE="${DEFAULT_TMPL_STORAGE}:vztmpl/${TEMPLATE_NAME}"

echo ""
echo -e "${YELLOW}==> 2/5 Creazione container LXC (ID: ${CTID}, Hostname: ${CT_HOSTNAME})...${NC}"

NET_CONFIG="name=eth0,bridge=${CT_BRIDGE},ip=${CT_IP},firewall=1"
[ -n "${CT_GW}" ] && NET_CONFIG="${NET_CONFIG},gw=${CT_GW}"

pct create "${CTID}" "${FULL_TEMPLATE}" \
    --ostype alpine \
    --hostname "${CT_HOSTNAME}" \
    --cores "${CT_CORES}" \
    --memory "${CT_RAM}" \
    --swap 256 \
    --rootfs "${CT_STORAGE}:${CT_DISK}" \
    --net0 "${NET_CONFIG}" \
    --features nesting=1 \
    --unprivileged 1 \
    --onboot 1

echo ""
echo -e "${YELLOW}==> 3/5 Avvio container e attesa connettività...${NC}"
pct start "${CTID}"
sleep 3

# Attesa acquisizione rete se DHCP
echo "Verifica connettività di rete del container..."
for i in $(seq 1 15); do
    if pct exec "${CTID}" -- ping -c 1 -W 2 1.1.1.1 >/dev/null 2>&1; then
        break
    fi
    sleep 1
done

echo ""
echo -e "${YELLOW}==> 4/5 Configurazione software e dipendenze in Alpine...${NC}"

pct exec "${CTID}" -- /bin/sh -c "apk update && apk add --no-cache git ca-certificates curl"
pct exec "${CTID}" -- /bin/sh -c "rm -rf /opt/dsv-tracking-center && git clone '${GITHUB_REPO}' /opt/dsv-tracking-center"
pct exec "${CTID}" -- /bin/sh -c "chmod +x /opt/dsv-tracking-center/scripts/*.sh /opt/dsv-tracking-center/scripts/*.initd"
pct exec "${CTID}" -- /bin/sh -c "ENABLE_CAMOFOX='${INSTALL_CAMOFOX}' sh /opt/dsv-tracking-center/scripts/setup-alpine.sh '${GITHUB_REPO}'"

echo ""
echo -e "${YELLOW}==> 5/5 Rilevamento indirizzo di rete...${NC}"
CONTAINER_IP=$(pct exec "${CTID}" -- ip -4 addr show eth0 2>/dev/null | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | head -n1 || echo "${CT_IP}")

echo ""
echo -e "${GREEN}${BOLD}==============================================================${NC}"
echo -e "${GREEN}${BOLD}  Installazione completata con successo!                      ${NC}"
echo -e "${GREEN}${BOLD}==============================================================${NC}"
echo ""
echo -e "  Container ID    : ${BOLD}${CTID}${NC}"
echo -e "  Hostname        : ${BOLD}${CT_HOSTNAME}${NC}"
echo -e "  Stato           : ${GREEN}IN ESECUZIONE${NC}"
echo -e "  Web App (UI)    : ${CYAN}${BOLD}http://${CONTAINER_IP}:3000${NC}"
if [ "${INSTALL_CAMOFOX}" = "true" ]; then
echo -e "  Camofox Scraper : ${GREEN}ATTIVO su http://127.0.0.1:9377 (Locale LXC)${NC}"
fi
echo ""
echo -e "  File .env       : ${BOLD}/opt/dsv-tracking-center/.env${NC} (nel container)"
echo -e "  Log Web App     : ${BOLD}/var/log/dsv-tracking-center.log${NC}"
if [ "${INSTALL_CAMOFOX}" = "true" ]; then
echo -e "  Log Camofox     : ${BOLD}/var/log/camofox.log${NC}"
fi
echo ""
echo -e "Comandi rapidi dalla shell di Proxmox:"
echo -e "  Entrare nella shell LXC   : ${BOLD}pct enter ${CTID}${NC}"
echo -e "  Modificare le credenziali : ${BOLD}pct exec ${CTID} -- nano /opt/dsv-tracking-center/.env${NC}"
echo -e "  Riavviare la Web App      : ${BOLD}pct exec ${CTID} -- rc-service dsv-tracking-center restart${NC}"
if [ "${INSTALL_CAMOFOX}" = "true" ]; then
echo -e "  Riavviare Camofox         : ${BOLD}pct exec ${CTID} -- rc-service camofox restart${NC}"
fi
echo -e "  Aggiornare da GitHub      : ${BOLD}pct exec ${CTID} -- /opt/dsv-tracking-center/scripts/update.sh${NC}"
echo -e "  Vedere i log live         : ${BOLD}pct exec ${CTID} -- tail -f /var/log/dsv-tracking-center.log${NC}"
echo ""
