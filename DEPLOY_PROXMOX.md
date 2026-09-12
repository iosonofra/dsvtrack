# Guida alla Distribuzione su Proxmox VE con Alpine Linux

Questa guida descrive come installare e manutenere **DSV - Tracking Center** e il servizio **Camofox** (scraper anti-detect DSV) su **Proxmox VE** all'interno del **medesimo container LXC** basato su **Alpine Linux**.

---

## 🏛️ Architettura dei Servizi sul Medesimo LXC

All'interno dello stesso container Alpine Linux girano due servizi coordinati tramite **OpenRC**:

```
+-------------------------------------------------------------------------+
|                  LXC Container (Alpine Linux)                           |
|                                                                         |
|   +--------------------------+       +------------------------------+   |
|   |   dsv-tracking-center    |       |           camofox            |   |
|   |      (Porta 3000)        | ----> |         (Porta 9377)         |   |
|   |    Interfaccia Web,      | HTTP  |   Browser headless Camoufox  |   |
|   |  PrestaShop Sync & API   |       |      (Solo 127.0.0.1)        |   |
|   +--------------------------+       +------------------------------+   |
|                 |                                                       |
+-----------------|-------------------------------------------------------+
                  |
         Rete LAN (Porta 3000)
                  v
         Operatori / Browser
```

1. **`dsv-tracking-center` (Porta 3000)**:
   - Server Node.js Express con l'interfaccia operatore, sincronizzazione PrestaShop, import Excel e gestione stati.
   - Esposto sulla rete LAN.
2. **`camofox` (Porta 9377)**:
   - Scraper headless basato su Camoufox / Firefox con profile evasion.
   - Vincolato esclusivamente su `127.0.0.1` (loopback locale all'LXC) per garantire la massima sicurezza ed evitare accessi esterni non autorizzati.

---

## 🚀 Requisiti e Risorse Hardware

| Parametro | Solo Web App (Sync PrestaShop) | Con Camofox Attivo (Scraper DSV) | Note |
| :--- | :--- | :--- | :--- |
| **Distribuzione** | **Alpine Linux** (o Debian 12) | **Debian 12** (Consigliata per glibc nativa) | Camoufox/Firefox richiede glibc per evitare stalli futex su musl |
| **RAM** | **512 MB** | **1536 MB – 2048 MB** | Il rendering headless con Camoufox richiede RAM adeguata |
| **CPU** | 1 o 2 vCPU | 2 vCPU | Consigliato 2 core per evitare colli di bottiglia |
| **Disco** | 4 GB | 8 GB – 20 GB | Spazio per binario browser Camoufox e librerie grafiche X11/GTK |
| **Rete** | Bridge standard (`vmbr0`) | Bridge standard (`vmbr0`) | DHCP o IP statico con uscita Internet |

---

## ⚡ Metodo 1: Installazione Automatica da Shell Proxmox (Consigliato)

È disponibile uno script interattivo che esegue tutte le operazioni automaticamente direttamente dal server Proxmox VE:

1. Apri la **Web GUI di Proxmox VE**.
2. Seleziona il tuo **Nodo Proxmox** nella colonna di sinistra e clicca su **>_ Shell** in alto a destra.
3. Se hai già caricato il codice su GitHub, puoi eseguire direttamente il comando:
   ```bash
   bash -c "$(curl -fsSL https://raw.githubusercontent.com/TUO_UTENTE/TUO_REPO/main/scripts/install-proxmox-lxc.sh)"
   ```
   *(In alternativa, puoi copiare lo script [`scripts/install-proxmox-lxc.sh`](file:///c:/Users/franc/.gemini/antigravity/scratch/DSV-IMPORT/scripts/install-proxmox-lxc.sh) sull'host e lanciarlo con `bash install-proxmox-lxc.sh`)*.

4. Lo script ti guiderà chiedendoti:
   - **Installazione Camofox**: `[S/n]` (imposta in automatico 8GB disco e 1536MB RAM).
   - **Container ID**: (rileva in automatico il prossimo ID libero, es. `150`).
   - **Hostname**: (predefinito: `dsv-tracking`).
   - **Storage disco**: (rileva in automatico es. `local-lvm` o `local-zfs`).
   - **Indirizzo IP**: (`dhcp` oppure statico, es. `192.168.1.50/24`).
   - **URL del tuo repository GitHub**: (es. `https://github.com/tuo-account/dsv-tracking.git`).

5. Al termine, il container sarà avviato con entrambi i servizi attivi:
   - **Web App**: `http://<IP_DEL_CONTAINER>:3000`
   - **Camofox Scraper**: `http://127.0.0.1:9377` (interno al container)

---

## 🛠️ Metodo 2: Installazione Manuale su Container Alpine Esistente

Se disponi già di un container o di una macchina virtuale con Alpine Linux:

1. Entra nel container come `root`:
   ```bash
   pct enter <ID_CONTAINER>
   # oppure via SSH al container
   ```

2. Clona il tuo repository GitHub:
   ```bash
   apk add --no-cache git ca-certificates
   git clone https://github.com/TUO_UTENTE/TUO_REPO.git /opt/dsv-tracking-center
   cd /opt/dsv-tracking-center
   ```

3. Rendi eseguibili gli script ed esegui il setup:
   ```bash
   chmod +x scripts/*.sh scripts/*.initd
   
   # Con Camofox abilitato (default):
   ENABLE_CAMOFOX=true sh scripts/setup-alpine.sh
   
   # Oppure solo Web App senza Camofox:
   ENABLE_CAMOFOX=false sh scripts/setup-alpine.sh
   ```

Lo script installerà Node.js, le librerie di sistema, configurerà l'utente `dsv`, scaricherà il binario di Camoufox e registrerà i due servizi di sistema **OpenRC** ad avvio automatico.

---

## 🐳 Metodo 3: Docker & Docker Compose

Se preferisci utilizzare Docker all'interno di Alpine o su un host Docker:

1. Assicurati che Docker e Docker Compose siano installati:
   ```bash
   apk add --no-cache docker docker-compose
   rc-update add docker default
   rc-service docker start
   ```

2. Entra nella cartella del progetto e avvia il container:
   ```bash
   docker compose up -d --build
   ```

I dati operativi e lo storico rimarranno salvati in modo permanente nella cartella `./data` sul disco dell'host.

---

## ⚙️ Configurazione Credenziali PrestaShop e Camofox

I parametri di connessione possono essere configurati in due modi:
1. **Dall'interfaccia grafica web**:
   - Apri `http://<IP_CONTAINER>:3000` nel browser.
   - Vai nella sezione **"Sistema · Configurazione"**.
   - Inserisci l'URL di PrestaShop e la Chiave Webservice e clicca **"Salva configurazione"** (verranno salvati automaticamente in `/opt/dsv-tracking-center/data/settings.json`).
   - Verifica lo stato di Camofox nella medesima schermata.

2. **Dal file `.env`**:
   Puoi modificare direttamente il file `.env` all'interno del container:
   ```bash
   pct exec <ID_CONTAINER> -- nano /opt/dsv-tracking-center/.env
   # oppure via ssh:
   nano /opt/dsv-tracking-center/.env
   ```
   Esempio configurazione:
   ```env
   PORT=3000
   PRESTASHOP_URL=https://tuonegostore.com
   PRESTASHOP_WEBSERVICE_KEY=LA_TUA_CHIAVE_WEBSERVICE
   CAMOFOX_PORT=9377
   CAMOFOX_URL=http://127.0.0.1:9377
   ```
   Riavvia i servizi dopo la modifica:
   ```bash
   rc-service dsv-tracking-center restart
   rc-service camofox restart
   ```

---

## 📋 Comandi di Gestione Quotidiana (OpenRC su Alpine)

Tutti i comandi possono essere eseguiti direttamente dall'interno del container o dall'host Proxmox tramite `pct exec <ID> -- <comando>`:

| Servizio | Azione | Comando nel container | Comando dall'host Proxmox |
| :--- | :--- | :--- | :--- |
| **Web App** | **Stato** | `rc-service dsv-tracking-center status` | `pct exec <ID> -- rc-service dsv-tracking-center status` |
| **Web App** | **Riavvia** | `rc-service dsv-tracking-center restart` | `pct exec <ID> -- rc-service dsv-tracking-center restart` |
| **Web App** | **Log live** | `tail -f /var/log/dsv-tracking-center.log` | `pct exec <ID> -- tail -f /var/log/dsv-tracking-center.log` |
| **Camofox** | **Stato** | `rc-service camofox status` | `pct exec <ID> -- rc-service camofox status` |
| **Camofox** | **Riavvia** | `rc-service camofox restart` | `pct exec <ID> -- rc-service camofox restart` |
| **Camofox** | **Log live** | `tail -f /var/log/camofox.log` | `pct exec <ID> -- tail -f /var/log/camofox.log` |

---

## 🔄 Come Aggiornare l'Applicazione da GitHub

Quando pubblichi nuovi commit o migliorie su GitHub, puoi aggiornare il container in un istante senza perdere impostazioni, profilo browser o spedizioni archiviate:

```bash
pct exec <ID_CONTAINER> -- /opt/dsv-tracking-center/scripts/update.sh
```

Lo script `update.sh`:
- Esegue `git pull` degli ultimi aggiornamenti.
- Riconosce la presenza di Camofox e aggiorna le dipendenze corrette.
- Riavvia automaticamente `camofox` e `dsv-tracking-center` in sicurezza.

---

## 🛡️ Backup e Persistenza Dati

I dati delle spedizioni monitorate, le note interne, le impostazioni e il profilo browser sono conservati in:
- `/opt/dsv-tracking-center/data/settings.json` (configurazione)
- `/opt/dsv-tracking-center/data/shipments.json` (database spedizioni)
- `/opt/dsv-tracking-center/data/camofox-profile/` (sessione browser isolata)

### Per creare un backup istantaneo:
- Dalla GUI di Proxmox VE: seleziona il container > **Backup** > **Backup now** (consigliata modalità *Snapshot*, non richiede interruzione del servizio).
- Per salvare la cartella dati in un tar locale:
  ```bash
  pct exec <ID_CONTAINER> -- tar -czf /root/backup-dsv-$(date +%F).tar.gz /opt/dsv-tracking-center/data
  ```

---

## 🚚 Come Migrare i Dati Esistenti dal PC al Nuovo Container Proxmox

Poiché la cartella `data/` è **giustamente protetta ed esclusa da GitHub** per tutelare la privacy dei clienti e le chiavi API di PrestaShop, il nuovo container appena installato parte con un archivio pulito.

Per ritrovare all'istante tutte le tue **spedizioni (cronologia completa, stati, note)** e le **impostazioni (chiavi e mappature PrestaShop)**, hai a disposizione diverse modalità:

### 🌟 Metodo 1: 1-Click Backup & Restore dalla Web App (Consigliatissimo - Nessun Terminale!)
Puoi fare l'intero passaggio direttamente dal browser in 30 secondi:

1. **Esporta dal PC attuale**:
   - Apri la Web App locale sul tuo computer (`http://localhost:3000`).
   - Vai nella schermata **"Configurazione"** e scorri fino al box **"Backup e ripristino dati"**.
   - Clicca su **"Scarica Backup Completo (.json)"**. Verrà scaricato un file denominato `dsv-backup-YYYY-MM-DD.json` contenente l'intero archivio (tutte le spedizioni attuali e le impostazioni).
2. **Importa nel nuovo container Proxmox**:
   - Apri nel browser l'indirizzo del nuovo container Proxmox (`http://<IP_CONTAINER>:3000`).
   - Vai in **"Configurazione"** > **"Backup e ripristino dati"**.
   - Trascina il file `dsv-backup-YYYY-MM-DD.json` nel riquadro di caricamento (o clicca per selezionarlo).
   - Clicca **"Conferma e Ripristina"**.
3. **Fatto!**
   - Il backend crea in automatico una copia di sicurezza `.bak`, carica tutte le spedizioni in memoria e riallinea la configurazione.
   - La pagina si aggiorna istantaneamente mostrando tutte le tue spedizioni e i badge sincronizzati, senza bisogno di riavvii manuali o comandi SSH.

---

### Metodo 2: Tramite `pct push` da Proxmox (Da Terminale)
Se preferisci operare da riga di comando:
1. Dal tuo PC, copia i file `data/shipments.json` e `data/settings.json` sul server Proxmox (es. in `/tmp/` tramite SCP o WinSCP):
   ```powershell
   scp data/shipments.json root@IP_PROXMOX:/tmp/
   scp data/settings.json root@IP_PROXMOX:/tmp/
   ```
2. Dalla shell di Proxmox VE, trasferiscili direttamente dentro il container LXC:
   ```bash
   pct push <ID_CONTAINER> /tmp/shipments.json /opt/dsv-tracking-center/data/shipments.json
   pct push <ID_CONTAINER> /tmp/settings.json /opt/dsv-tracking-center/data/settings.json
   pct exec <ID_CONTAINER> -- chown -R dsv:dsv /opt/dsv-tracking-center/data
   pct exec <ID_CONTAINER> -- rc-service dsv-tracking-center restart
   ```

---

### Metodo 3: Copia diretta nel filesystem Proxmox
Dalla shell di Proxmox, i file del container si trovano anche direttamente su:
```bash
/var/lib/lxc/<ID_CONTAINER>/rootfs/opt/dsv-tracking-center/data/
```
Puoi incollare i due file `.json` direttamente in questo percorso e reimpostare i permessi con:
```bash
pct exec <ID_CONTAINER> -- chown -R dsv:dsv /opt/dsv-tracking-center/data
pct exec <ID_CONTAINER> -- rc-service dsv-tracking-center restart
```
Non appena riavvii il servizio, ricaricando la pagina `http://<IP_CONTAINER>:3000` ritroverai tutte le spedizioni, le note e le impostazioni esattamente come sul computer locale.

