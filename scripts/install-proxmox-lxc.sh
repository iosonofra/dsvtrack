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

# 3. Scelta distribuzione Linux
if [ "${INSTALL_CAMOFOX}" = "true" ]; then
    DEFAULT_DISTRO="debian"
    echo -e "${YELLOW}Raccomandazione: con Camofox attivo, Debian 12 è consigliata per garantire l'esecuzione nativa di Firefox (glibc).${NC}"
else
    DEFAULT_DISTRO="alpine"
fi

read -rp "$(echo -e "${CYAN}Distribuzione Linux [${DEFAULT_DISTRO}] (debian / alpine): ${NC}")" INPUT_DISTRO
case "$INPUT_DISTRO" in
    [aA]lpine*)
        DISTRO="alpine"
        OSTYPE="alpine"
        DISTRO_LABEL="Alpine Linux"
        ;;
    *)
        DISTRO="debian"
        OSTYPE="debian"
        DISTRO_LABEL="Debian 12 (Bookworm)"
        ;;
esac

# 4. Rilevamento architettura CPU dell'host Proxmox (amd64 vs arm64)
HOST_UNAME=$(uname -m)
case "${HOST_UNAME}" in
    x86_64) ARCH_FILTER="amd64" ;;
    aarch64|arm64) ARCH_FILTER="arm64" ;;
    *) ARCH_FILTER="amd64" ;;
esac
echo -e "Architettura host Proxmox rilevata: ${BOLD}${ARCH_FILTER} (${HOST_UNAME})${NC}"
echo -e "Distribuzione selezionata: ${BOLD}${DISTRO_LABEL}${NC}"

echo ""
echo -e "${YELLOW}==> 1/5 Download template ${DISTRO_LABEL} (${ARCH_FILTER})...${NC}"
pveam update >/dev/null 2>&1 || true

if [ "${DISTRO}" = "debian" ]; then
    TEMPLATE_NAME=$(pveam available --section system | awk '{print $2}' | grep -E "^debian-12-standard.*_${ARCH_FILTER}\.tar" | sort -V | tail -n1)
    if [ -z "${TEMPLATE_NAME}" ]; then
        TEMPLATE_NAME="debian-12-standard_12.7-1_${ARCH_FILTER}.tar.zst"
    fi
else
    TEMPLATE_NAME=$(pveam available --section system | awk '{print $2}' | grep -E "^alpine-[0-9]+\.[0-9]+.*_${ARCH_FILTER}\.tar" | sort -V | tail -n1)
    if [ -z "${TEMPLATE_NAME}" ]; then
        TEMPLATE_NAME="alpine-3.21-default_20241203_${ARCH_FILTER}.tar.xz"
    fi
fi

# Verifica se già scaricato
if ! pveam list "${DEFAULT_TMPL_STORAGE}" | grep -q "${TEMPLATE_NAME}"; then
    echo "Download di ${TEMPLATE_NAME} nello storage ${DEFAULT_TMPL_STORAGE}..."
    pveam download "${DEFAULT_TMPL_STORAGE}" "${TEMPLATE_NAME}"
else
    echo "Template ${TEMPLATE_NAME} già presente nella cache locale."
fi

FULL_TEMPLATE="${DEFAULT_TMPL_STORAGE}:vztmpl/${TEMPLATE_NAME}"

# Se il container esiste già (es. tentativo precedente interrotto), chiedi se rimuoverlo
if pct status "${CTID}" >/dev/null 2>&1; then
    echo ""
    echo -e "${YELLOW}Attenzione: il container ${CTID} esiste già sull'host Proxmox.${NC}"
    read -rp "$(echo -e "${CYAN}Vuoi rimuoverlo e ricrearlo pulito con ${DISTRO_LABEL}? [S/n]: ${NC}")" DESTROY_CONFIRM
    case "$DESTROY_CONFIRM" in
        [nN][oO]|[nN])
            echo -e "${RED}Installazione interrotta. Rilancia lo script scegliendo un Container ID libero.${NC}"
            exit 1
            ;;
        *)
            echo "Rimozione container ${CTID} precedente..."
            pct stop "${CTID}" >/dev/null 2>&1 || true
            pct destroy "${CTID}" --purge 1 >/dev/null 2>&1 || true
            ;;
    esac
fi

echo ""
echo -e "${YELLOW}==> 2/5 Creazione container LXC (ID: ${CTID}, Hostname: ${CT_HOSTNAME}, OS: ${DISTRO_LABEL})...${NC}"

NET_CONFIG="name=eth0,bridge=${CT_BRIDGE},ip=${CT_IP},firewall=1"
[ -n "${CT_GW}" ] && NET_CONFIG="${NET_CONFIG},gw=${CT_GW}"

pct create "${CTID}" "${FULL_TEMPLATE}" \
    --ostype "${OSTYPE}" \
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
if ! pct start "${CTID}"; then
    echo -e "${RED}Errore durante l'avvio del container ${CTID}.${NC}"
    echo "Diagnostica LXC:"
    pct start "${CTID}" --debug || true
    exit 1
fi
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
echo -e "${YELLOW}==> 4/5 Configurazione software e dipendenze in ${DISTRO_LABEL}...${NC}"

if [ "${DISTRO}" = "debian" ]; then
    pct exec "${CTID}" -- /bin/bash -c "apt-get update && apt-get install -y curl git ca-certificates"
    pct exec "${CTID}" -- /bin/bash -c "rm -rf /opt/dsv-tracking-center && git clone '${GITHUB_REPO}' /opt/dsv-tracking-center"
    pct exec "${CTID}" -- /bin/bash -c "chmod +x /opt/dsv-tracking-center/scripts/*.sh"
    pct exec "${CTID}" -- /bin/bash -c "ENABLE_CAMOFOX='${INSTALL_CAMOFOX}' bash /opt/dsv-tracking-center/scripts/setup-debian.sh '${GITHUB_REPO}'"
else
    pct exec "${CTID}" -- /bin/sh -c "apk update && apk add --no-cache git ca-certificates curl"
    pct exec "${CTID}" -- /bin/sh -c "rm -rf /opt/dsv-tracking-center && git clone '${GITHUB_REPO}' /opt/dsv-tracking-center"
    pct exec "${CTID}" -- /bin/sh -c "chmod +x /opt/dsv-tracking-center/scripts/*.sh /opt/dsv-tracking-center/scripts/*.initd"
    pct exec "${CTID}" -- /bin/sh -c "ENABLE_CAMOFOX='${INSTALL_CAMOFOX}' sh /opt/dsv-tracking-center/scripts/setup-alpine.sh '${GITHUB_REPO}'"
fi

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
if [ "${DISTRO}" = "debian" ]; then
echo -e "  Riavviare la Web App      : ${BOLD}pct exec ${CTID} -- systemctl restart dsv-tracking-center${NC}"
if [ "${INSTALL_CAMOFOX}" = "true" ]; then
echo -e "  Riavviare Camofox         : ${BOLD}pct exec ${CTID} -- systemctl restart camofox${NC}"
fi
echo -e "  Vedere i log live         : ${BOLD}pct exec ${CTID} -- journalctl -u dsv-tracking-center -f${NC}"
else
echo -e "  Riavviare la Web App      : ${BOLD}pct exec ${CTID} -- rc-service dsv-tracking-center restart${NC}"
if [ "${INSTALL_CAMOFOX}" = "true" ]; then
echo -e "  Riavviare Camofox         : ${BOLD}pct exec ${CTID} -- rc-service camofox restart${NC}"
fi
echo -e "  Vedere i log live         : ${BOLD}pct exec ${CTID} -- tail -f /var/log/dsv-tracking-center.log${NC}"
fi
echo -e "  Aggiornare da GitHub      : ${BOLD}pct exec ${CTID} -- /opt/dsv-tracking-center/scripts/update.sh${NC}"
echo ""
