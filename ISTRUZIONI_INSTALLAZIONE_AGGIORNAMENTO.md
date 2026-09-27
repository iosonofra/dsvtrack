# Istruzioni per Installazione o Aggiornamento Pulito
## DSV - Tracking Center

Questo pacchetto zip contiene l'intera base di codice aggiornata e ripulita (sorgenti `src/`, interfaccia web `public/`, script di sistema `scripts/` e suite di test `tests/`), escludendo cartelle di dati, file di sessione, cache e librerie temporanee.

In questo modo:
- **In caso di aggiornamento**: la tua configurazione (`.env`), le impostazioni salvate (`data/settings.json`), l'archivio delle spedizioni (`data/shipments.json`) e il profilo browser Camofox **non vengono sovrascritti o cancellati**.
- **In caso di nuova installazione**: hai a disposizione un pacchetto completo e pulito pronto per il setup iniziale.

---

### 🚀 Caso 1: Aggiornamento rapido di un'installazione esistente su Proxmox LXC

#### Opzione A: Dall'host Proxmox VE (Consigliato, nessun accesso SSH necessario)
1. Carica il file zip sul server Proxmox (o usa la console del nodo):
   ```bash
   pct push <ID_CONTAINER> dsv-tracking-center-aggiornamento-pulito-2026-09-27.zip /tmp/update.zip
   ```
2. Applica l'aggiornamento e riavvia i servizi:
   ```bash
   pct exec <ID_CONTAINER> -- sh -c "
     unzip -o /tmp/update.zip -d /opt/dsv-tracking-center/ && \
     cd /opt/dsv-tracking-center && \
     npm install --omit=dev && \
     chown -R dsv:dsv /opt/dsv-tracking-center && \
     (rc-service dsv-tracking-center restart 2>/dev/null || systemctl restart dsv-tracking-center 2>/dev/null || true) && \
     (rc-service camofox restart 2>/dev/null || systemctl restart camofox 2>/dev/null || true) && \
     rm -f /tmp/update.zip
   "
   ```

#### Opzione B: Direttamente dall'interno del Container LXC (Shell / SSH)
1. Copia o scarica il file zip nel container (es. in `/tmp/update.zip`).
2. Esegui la sequenza di aggiornamento:
   ```bash
   # Estrai i file aggiornati sovrascrivendo i precedenti
   unzip -o /tmp/update.zip -d /opt/dsv-tracking-center/
   cd /opt/dsv-tracking-center

   # Aggiorna le dipendenze Node.js
   npm install --omit=dev

   # Ripristina la corretta proprietà dei file
   chown -R dsv:dsv /opt/dsv-tracking-center

   # Riavvia i servizi:
   # Su Alpine Linux (OpenRC):
   rc-service dsv-tracking-center restart
   rc-service camofox restart  # se abilitato

   # Su Debian 12 (systemd):
   systemctl restart dsv-tracking-center
   systemctl restart camofox   # se abilitato
   ```

---

### 🆕 Caso 2: Nuova installazione pulita da zero

1. Crea il container LXC su Proxmox (Alpine Linux o Debian 12 consigliata).
2. Estrai il file zip in `/opt/dsv-tracking-center`:
   ```bash
   mkdir -p /opt/dsv-tracking-center
   unzip dsv-tracking-center-aggiornamento-pulito-2026-09-27.zip -d /opt/dsv-tracking-center
   cd /opt/dsv-tracking-center
   ```
3. Avvia lo script di setup automatico:
   - **Su Alpine Linux**:
     ```bash
     sh scripts/setup-alpine.sh
     ```
   - **Su Debian 12**:
     ```bash
     bash scripts/setup-debian.sh
     ```
4. Se non hai ancora configurato PrestaShop, modifica `/opt/dsv-tracking-center/.env` con le tue credenziali oppure inseriscile direttamente dall'interfaccia Web nella sezione **"Sistema · Configurazione"**.

---

### 🔍 Verifica dell'installazione
Per verificare che l'applicazione funzioni correttamente:
- Apri nel browser: `http://<IP_DEL_CONTAINER>:3000`
- Per verificare i test automatizzati nel container:
  ```bash
  cd /opt/dsv-tracking-center && npm test
  ```
