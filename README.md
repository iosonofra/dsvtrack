# Importatore tracking PrestaShop

Web app Node.js per importare tracking DSV da Excel, ricercare gli ordini con il loro riferimento e impostare tracking, corriere e stato.

## Avvio

1. Facoltativamente copia `.env.example` in `.env` per definire la configurazione iniziale. URL e chiave inseriti dall'interfaccia vengono conservati localmente in `data/settings.json`, escluso dal controllo versione.
2. Installa le dipendenze con `npm install`.
3. Avvia con `npm run dev`.
4. Apri `http://localhost:3000`.

La chiave Webservice deve avere almeno permessi di lettura su `orders`, `order_states`, `carriers`, `order_carriers` e di scrittura su `order_carriers` e `order_histories`.

## Flusso

1. Configura e verifica la connessione al negozio.
2. L'app scarica gli stati e i corrieri disponibili.
3. Carica il file DSV e seleziona stato e corriere.
4. Controlla l'anteprima: righe senza riferimento o con riferimenti duplicati non sono applicabili.
5. Conferma l'importazione. L'esecuzione dettagliata verrà registrata nel registro importazioni.

## Centro di controllo spedizioni

Ogni verifica PrestaShop, verifica DSV beta e aggiornamento confermato alimenta un archivio locale in `data/shipments.json` (escluso dal controllo versione). Il centro di controllo mostra conteggi operativi, filtri, eccezioni e lo storico delle operazioni per singolo tracking. È in sola lettura: non invia aggiornamenti né esegue controlli automatici.

## Nota di compatibilita'

Il modulo `src/prestashop-client.js` e' l'unico punto che conosce le API di PrestaShop. Il parser/importatore non dipende dalla versione del negozio: questo permette di adattare il connettore durante il passaggio dalla 1.7.6.5 alla versione successiva.

## DSV/Schenker: beta estrema facoltativa

Questa funzione è una consultazione separata della pagina pubblica DSV tramite un servizio Camofox in esecuzione **solo sul computer locale**. È spenta per impostazione iniziale e non può modificare ordini, tracking, corrieri o stati in PrestaShop.

- Seleziona esplicitamente fino a 10 righe già verificate nell'importatore.
- Dal Centro di controllo puoi verificare una singola spedizione dal suo dettaglio oppure selezionare fino a 10 righe e avviare una verifica multipla.
- Le richieste vengono elaborate una alla volta, a distanza di 5 secondi; i risultati sono riutilizzati dalla cache locale per 24 ore.
- Tutti gli avvii, inclusi quelli dall'importatore e dal Centro di controllo, passano da una sola coda locale: non vengono mai eseguite automazioni Camofox in parallelo.
- Non inserisce credenziali, non tenta di superare CAPTCHA e si ferma quando la pagina richiede un intervento umano.
- Il collegamento pubblico usato è `https://www.dsv.com/mydsv/tracking-public/?refNumber=TRACKINGDAINSERIRE&language_region=it-IT_IT`: il segnaposto viene sostituito con il numero di spedizione. Il riconoscimento della pagina è volutamente conservativo: un risultato non riconosciuto è indicato come “Da verificare manualmente”.

Il progetto include già Camofox Browser. Per avviarlo usa `npm run camofox`: lo script imposta la porta `9377`, limita l'ascolto a `127.0.0.1`, disabilita la telemetria e rimuove qualunque configurazione proxy. Poi attivare e salvare la sezione “DSV/Schenker · Beta estrema” nell'app. Se Camofox è protetto da chiave, impostare `CAMOFOX_ACCESS_KEY` nell'ambiente dell'app, senza inserirla nell'interfaccia. Non esporre la porta 9377 in rete e non configurare account DSV nella beta.
