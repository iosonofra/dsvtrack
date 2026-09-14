import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import express from 'express';
import multer from 'multer';
import { readDsvWorkbook } from './excel-import.js';
import { PrestaShopClient } from './prestashop-client.js';
import { exportSettingsData, loadSettings, normalizeCronSettings, normalizeDsvStateMappings, normalizeNotificationSettings, restoreSettingsData, saveSettings } from './settings-store.js';
import { DEFAULT_DSV_TRACKING_URL, DSV_PARSER_VERSION, DsvBetaClient, normalizeBetaSettings } from './dsv-beta-client.js';
import { DsvCronService } from './dsv-cron.js';
import { NotificationService } from './notification-service.js';
import { archiveShipment, exportShipmentsData, getAuditLog, getControlCenter, getExistingShipmentsIndex, getImportBatches, getShipment, registerImportBatch, restoreShipmentsData, syncAppliedShipments, syncDsvShipments, syncManualPrestaShopState, syncShipmentPrestaShopShipping, syncVerifiedShipments, updateShipmentCase } from './shipment-store.js';

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const port = Number(process.env.PORT ?? 3000);
const VERIFY_BATCH_SIZE = 30;
const VERIFIED_IMPORT_TTL_MS = 15 * 60 * 1000;
const verifiedImports = new Map();
const verificationJobs = new Map();
const applyJobs = new Map();
const dsvBetaJobs = new Map();
const DSV_BETA_MAX_ROWS = 10;
const DSV_BETA_INTERVAL_MS = 2_500;
const DSV_BETA_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DSV_MOVING_CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const DSV_NOT_FOUND_CACHE_TTL_MS = 60 * 60 * 1000;
const dsvBetaCache = new Map();
const prestashopOrderStateLocks = new Map();

function naturalJitterInterval() {
  return 2000 + Math.floor(Math.random() * 1200);
}
let dsvBetaQueue = Promise.resolve();
let connection = await loadSettings({
  baseUrl: process.env.PRESTASHOP_URL ?? '',
  apiKey: process.env.PRESTASHOP_WEBSERVICE_KEY ?? '',
  dsvBeta: { enabled: false, camofoxUrl: process.env.CAMOFOX_URL ?? 'http://127.0.0.1:9377', trackingUrl: process.env.DSV_TRACKING_URL ?? DEFAULT_DSV_TRACKING_URL },
  cron: { enabled: false, intervalMinutes: 60, nightPause: true, startHour: 8, endHour: 20, batchSize: 25, minCheckIntervalHours: 2 },
  notifications: normalizeNotificationSettings({}),
});

const notificationService = new NotificationService({
  getSettings: () => connection,
});

const cronService = new DsvCronService({
  getSettings: () => connection,
  saveSettings: async (updated) => {
    connection = updated;
    await saveSettings(connection);
  },
  dsvBetaClientFactory: (cfg) => new DsvBetaClient(cfg),
  loadShipments: exportShipmentsData,
  syncDsvShipments,
  applyOrderState: async ({ orderId, stateId }) => {
    await withPrestaShopOrderStateLock(orderId, () => client().applyOrderStateSafely({ orderId, stateId }));
  },
  syncManualState: syncManualPrestaShopState,
  notificationService,
});

cronService.start();

app.use(express.json());
app.use(express.static('public'));

function client() {
  if (!connection.baseUrl || !connection.apiKey) throw new Error('Inserisci URL e chiave Webservice di PrestaShop.');
  return new PrestaShopClient(connection);
}

async function withPrestaShopOrderStateLock(orderId, operation) {
  const key = String(orderId);
  const previous = prestashopOrderStateLocks.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  prestashopOrderStateLocks.set(key, current);
  try {
    return await current;
  } finally {
    if (prestashopOrderStateLocks.get(key) === current) prestashopOrderStateLocks.delete(key);
  }
}

async function alignShipmentPrestaShopState({ trackingNumber, stateId, targetState, shop }) {
  const initialShipment = await getShipment(trackingNumber);
  if (!initialShipment) throw new Error('Spedizione non presente nel centro di controllo.');
  if (!initialShipment.orderId) throw new Error('La spedizione non è collegata a un ordine PrestaShop aggiornabile.');

  return withPrestaShopOrderStateLock(initialShipment.orderId, async () => {
    const shipment = await getShipment(trackingNumber);
    if (!shipment) throw new Error('Spedizione non presente nel centro di controllo.');
    const sameStateId = shipment.prestaStateId && String(shipment.prestaStateId) === String(stateId);
    const sameStateName = String(shipment.currentState || '').trim().toLocaleLowerCase('it-IT') === String(targetState.name || '').trim().toLocaleLowerCase('it-IT');
    if (sameStateId || sameStateName) {
      return { shipment, skipped: true, message: `L’ordine è già nello stato “${targetState.name}”. Nessun aggiornamento inviato.` };
    }

    const outcome = await shop.applyOrderStateSafely({ orderId: shipment.orderId, stateId });
    const updated = await syncManualPrestaShopState(shipment.trackingNumber, { stateId, stateName: targetState.name });
    return {
      shipment: updated,
      skipped: Boolean(outcome.alreadyApplied),
      recoveredAfterError: Boolean(outcome.recoveredAfterError),
      message: outcome.alreadyApplied
        ? `PrestaShop risultava già nello stato “${targetState.name}”. Archivio locale riallineato senza creare un nuovo evento remoto.`
        : `Ordine aggiornato allo stato “${targetState.name}”. Nessuna email inviata.`,
    };
  });
}

app.get('/api/config', (_req, res) => res.json({ baseUrl: connection.baseUrl, configured: Boolean(connection.apiKey) }));
app.post('/api/config', async (req, res) => {
  const { baseUrl, apiKey } = req.body ?? {};
  if (!/^https?:\/\//.test(baseUrl ?? '')) return res.status(400).json({ error: 'L’URL deve iniziare con http:// o https://.' });
  connection = { ...connection, baseUrl, apiKey: apiKey || connection.apiKey };
  await saveSettings(connection);
  res.json({ baseUrl: connection.baseUrl, configured: Boolean(connection.apiKey) });
});

app.post('/api/config/test', async (_req, res) => {
  try {
    const results = await client().testConnection();
    res.json({ results, passed: results.every((item) => item.authorized) });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.get('/api/backup/export', async (_req, res) => {
  try {
    const shipmentsData = await exportShipmentsData();
    const settingsData = exportSettingsData(connection);
    const dateStr = new Date().toISOString().slice(0, 10);
    const payload = {
      format: 'dsv-tracking-center-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      stats: {
        shipmentsCount: shipmentsData.count,
      },
      settings: settingsData,
      shipments: shipmentsData.shipments,
    };
    const filename = `dsv-backup-${dateStr}.json`;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(JSON.stringify(payload, null, 2));
  } catch (error) {
    res.status(500).json({ error: `Errore durante la creazione del backup: ${error.message}` });
  }
});

app.post('/api/backup/restore', upload.single('file'), async (req, res) => {
  try {
    let payload = null;
    if (req.file?.buffer) {
      try {
        payload = JSON.parse(req.file.buffer.toString('utf8'));
      } catch {
        return res.status(400).json({ error: 'Il file caricato non è un file JSON valido.' });
      }
    } else if (req.body && typeof req.body === 'object') {
      payload = req.body;
    }

    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({ error: 'Nessun dato di backup fornito per il ripristino.' });
    }

    const shipments = payload.shipments || (payload.format ? {} : payload);
    const settings = payload.settings;

    if (!shipments || typeof shipments !== 'object' || Array.isArray(shipments)) {
      return res.status(400).json({ error: 'Il backup non contiene una struttura spedizioni valida.' });
    }

    let restoredSettings = false;
    if (settings && typeof settings === 'object') {
      connection = await restoreSettingsData(settings, {
        baseUrl: process.env.PRESTASHOP_URL ?? '',
        apiKey: process.env.PRESTASHOP_WEBSERVICE_KEY ?? '',
      });
      restoredSettings = true;
      cronService.start();
    }

    const { restoredCount } = await restoreShipmentsData(shipments);

    res.json({
      success: true,
      restoredCount,
      restoredSettings,
      exportedAt: payload.exportedAt || null,
      message: `Ripristino completato con successo: ${restoredCount} spedizioni${restoredSettings ? ' e impostazioni PrestaShop' : ''} ripristinate.`,
    });
  } catch (error) {
    res.status(400).json({ error: `Errore durante il ripristino: ${error.message}` });
  }
});

app.get('/api/dsv-beta/config', (_req, res) => {
  res.json({ ...connection.dsvBeta, maxRows: DSV_BETA_MAX_ROWS, intervalMs: DSV_BETA_INTERVAL_MS, cacheHours: DSV_BETA_CACHE_TTL_MS / 3_600_000, movingCacheHours: DSV_MOVING_CACHE_TTL_MS / 3_600_000, parserVersion: DSV_PARSER_VERSION });
});

app.post('/api/dsv-beta/config', async (req, res) => {
  try {
    connection = { ...connection, dsvBeta: normalizeBetaSettings(req.body ?? {}) };
    await saveSettings(connection);
    res.json({ ...connection.dsvBeta, maxRows: DSV_BETA_MAX_ROWS, intervalMs: DSV_BETA_INTERVAL_MS, cacheHours: DSV_BETA_CACHE_TTL_MS / 3_600_000, movingCacheHours: DSV_MOVING_CACHE_TTL_MS / 3_600_000, parserVersion: DSV_PARSER_VERSION });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.post('/api/dsv-beta/test', async (_req, res) => {
  try {
    const beta = new DsvBetaClient(connection.dsvBeta);
    await beta.testConnection();
    res.json({ ok: true, message: 'Camofox locale è raggiungibile. La beta non usa credenziali DSV né aggira CAPTCHA.' });
  } catch (error) { res.status(400).json({ error: `Connessione Camofox non disponibile: ${error.message}` }); }
});

app.post('/api/dsv-beta/jobs', (req, res) => {
  try {
    if (!connection.dsvBeta?.enabled) throw new Error('Attiva prima la beta DSV/Schenker e salva la configurazione.');
    const trackingNumbers = [...new Set((req.body?.trackingNumbers ?? []).map((value) => String(value).trim()).filter(Boolean))];
    if (!trackingNumbers.length) throw new Error('Seleziona almeno una riga con un tracking da verificare.');
    if (trackingNumbers.length > DSV_BETA_MAX_ROWS) throw new Error(`La beta accetta al massimo ${DSV_BETA_MAX_ROWS} spedizioni per avvio.`);
    const job = { id: randomUUID(), status: 'queued', progress: { completed: 0, total: trackingNumbers.length }, result: null, error: null };
    dsvBetaJobs.set(job.id, job);
    scheduleDsvBetaJob(job, trackingNumbers);
    res.status(202).json({ jobId: job.id, progress: job.progress });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.get('/api/dsv-beta/jobs/:jobId', (req, res) => {
  const job = dsvBetaJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Verifica DSV non trovata o scaduta.' });
  res.json({ status: job.status, progress: job.progress, result: job.status === 'complete' ? job.result : null, error: job.error });
});

app.get('/api/cron/status', (_req, res) => {
  res.json(cronService.getStatus());
});

app.post('/api/cron/config', async (req, res) => {
  try {
    const updated = normalizeCronSettings(req.body ?? {});
    await cronService.updateConfig(updated);
    res.json({ ok: true, config: updated, status: cronService.getStatus() });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/cron/trigger', (req, res) => {
  try {
    if (cronService.isRunning) {
      return res.status(409).json({ error: 'Un ciclo di controllo delle spedizioni è già in corso.' });
    }
    void cronService.triggerScan({ manual: true }).catch((err) => {
      console.error('[DSV-CRON] Errore scansione manuale:', err.message);
    });
    res.status(202).json({
      ok: true,
      message: 'Scansione avviata in background.',
      status: cronService.getStatus(),
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/cron/stop', (_req, res) => {
  try {
    const result = cronService.stopScan();
    res.json({ ...result, status: cronService.getStatus() });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/catalog', async (_req, res) => {
  try {
    const shop = client();
    const [statuses, carriers] = await Promise.all([shop.listOrderStates(), shop.listCarriers()]);
    res.json({ statuses, carriers });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.get('/api/settings/default-carrier', (_req, res) => {
  res.json({ defaultCarrierId: connection.defaultCarrierId || '', defaultCarrierName: connection.defaultCarrierName || '' });
});

app.post('/api/settings/default-carrier', async (req, res) => {
  try {
    const carrierId = String(req.body?.carrierId || '').trim();
    const carrierName = String(req.body?.carrierName || '').trim();
    connection = { ...connection, defaultCarrierId: carrierId, defaultCarrierName: carrierName };
    await saveSettings(connection);
    res.json({ ok: true, defaultCarrierId: carrierId, defaultCarrierName: carrierName });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.get('/api/dsv-state-mappings', (_req, res) => {
  res.json({ mappings: normalizeDsvStateMappings(connection.dsvStateMappings) });
});

app.post('/api/dsv-state-mappings', async (req, res) => {
  try {
    const requested = normalizeDsvStateMappings(req.body?.mappings);
    const states = await client().listOrderStates();
    const statesById = new Map(states.map((state) => [String(state.id), state]));
    const mappings = Object.entries(requested).reduce((output, [dsvStatus, target]) => {
      const state = statesById.get(String(target.stateId));
      if (!state) throw new Error(`Lo stato PrestaShop associato a “${dsvStatus}” non è più disponibile.`);
      output[dsvStatus] = {
        stateId: String(state.id),
        stateName: String(state.name),
        autoSync: Boolean(target.autoSync),
      };
      return output;
    }, {});
    connection = { ...connection, dsvStateMappings: mappings };
    await saveSettings(connection);
    res.json({ mappings, message: `${Object.keys(mappings).length} associazioni salvate.` });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.get('/api/notifications/config', (_req, res) => {
  res.json({ notifications: normalizeNotificationSettings(connection.notifications) });
});

app.post('/api/notifications/config', async (req, res) => {
  try {
    const notifications = normalizeNotificationSettings(req.body ?? {});
    connection = { ...connection, notifications };
    await saveSettings(connection);
    res.json({ ok: true, notifications, message: 'Impostazioni di notifica salvate con successo.' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/notifications/test-telegram', async (req, res) => {
  try {
    const config = req.body || connection.notifications?.telegram || {};
    const result = await notificationService.testTelegram(config);
    res.json({ ok: true, message: 'Messaggio di prova inviato con successo su Telegram!', result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/notifications/test-email', async (req, res) => {
  try {
    const config = req.body || connection.notifications?.email || {};
    const result = await notificationService.testEmail(config);
    res.json({ ok: true, message: 'Email di prova inviata con successo!', result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/notifications/trigger-digest', async (_req, res) => {
  try {
    const db = await exportShipmentsData();
    const records = Object.values(db?.shipments || {});
    const now = new Date();
    const todayKey = now.toISOString().slice(0, 10);
    const totalActive = records.filter((r) => !r.archived && r.dsvStatus !== 'Consegnata').length;
    const deliveredToday = records.filter((r) => r.dsvStatus === 'Consegnata' && r.dsvCheckedAt && r.dsvCheckedAt.slice(0, 10) === todayKey).length;
    const exceptions = records.filter((r) => !r.archived && (r.dsvStatus === 'Eccezione DSV' || r.caseStatus === 'Aperta')).length;
    const thresholdMs = 48 * 3600_000;
    const delayed = records.filter((r) => !r.archived && r.dsvStatus !== 'Consegnata' && (now.getTime() - new Date(r.dsvCheckedAt || r.createdAt || 0).getTime()) > thresholdMs).length;

    const result = await notificationService.sendDailyDigest({
      totalActive,
      deliveredToday,
      exceptions,
      delayed,
    });
    res.json({ ok: true, message: 'Digest inviato con successo ai canali attivi.', result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/history/batches', async (req, res) => {
  try {
    const batches = await getImportBatches();
    res.json(batches);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/history/batches/:batchId/export', async (req, res) => {
  try {
    const batches = await getImportBatches();
    const batch = batches.find((b) => b.id === req.params.batchId);
    if (!batch) return res.status(404).send('Lotto non trovato');

    const { shipments } = await exportShipmentsData();
    const csvRows = [
      ['Data/Ora Importazione', 'Numero Spedizione', 'Riferimento Ordine', 'ID Ordine', 'Stato PrestaShop', 'Stato DSV', 'Dettaglio DSV', 'Archiviata'],
    ];

    for (const trk of batch.trackingNumbers) {
      const rec = shipments[trk] || { trackingNumber: trk };
      csvRows.push([
        batch.at ? new Date(batch.at).toLocaleString('it-IT') : '',
        rec.trackingNumber || '',
        rec.orderReference || '',
        rec.orderId || '',
        rec.currentState || '—',
        rec.dsvStatus || 'Non verificato',
        (rec.dsvDetail || '').replace(/[\r\n]+/g, ' '),
        rec.archived ? 'Sì' : 'No',
      ]);
    }

    const csvContent = '\uFEFF' + csvRows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="lotto-${batch.id}.csv"`);
    res.send(csvContent);
  } catch (error) {
    res.status(500).send(error.message);
  }
});

app.get('/api/history/audit-log', async (req, res) => {
  try {
    const result = await getAuditLog({
      type: req.query.type,
      query: req.query.query,
      dateFrom: req.query.dateFrom,
      dateTo: req.query.dateTo,
      limit: req.query.limit,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/history/audit-log/export', async (req, res) => {
  try {
    const { events } = await getAuditLog({
      type: req.query.type,
      query: req.query.query,
      dateFrom: req.query.dateFrom,
      dateTo: req.query.dateTo,
      limit: 5000,
    });

    const csvRows = [
      ['Data/Ora', 'Tipo Evento', 'Tracking', 'Riferimento Ordine', 'Stato PrestaShop', 'Stato DSV', 'Azione/Esito', 'Dettaglio'],
    ];

    for (const ev of events) {
      csvRows.push([
        ev.at ? new Date(ev.at).toLocaleString('it-IT') : '',
        ev.type || '',
        ev.trackingNumber || '',
        ev.orderReference || '',
        ev.currentState || '—',
        ev.dsvStatus || '—',
        ev.label || '',
        (ev.detail || '').replace(/[\r\n]+/g, ' '),
      ]);
    }

    const csvContent = '\uFEFF' + csvRows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csvContent);
  } catch (error) {
    res.status(500).send(error.message);
  }
});

app.get('/api/control-center', async (req, res) => {
  try {
    const result = await getControlCenter({
      query: req.query.query,
      status: req.query.status,
      dsvStatus: req.query.dsvStatus,
      checkedAfter: req.query.checkedAfter,
      exceptionOnly: req.query.exceptions === '1',
      archived: req.query.archived === '1' || req.query.archived === 'true',
    });
    res.json({ ...result, stateMappings: normalizeDsvStateMappings(connection.dsvStateMappings) });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/control-center/:trackingNumber', async (req, res) => {
  try {
    const shipment = await getShipment(req.params.trackingNumber);
    if (!shipment) return res.status(404).json({ error: 'Spedizione non presente nel centro di controllo.' });
    res.json(shipment);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/control-center/:trackingNumber/archive', async (req, res) => {
  try {
    const archived = req.body?.archived !== undefined ? Boolean(req.body.archived) : true;
    const shipment = await archiveShipment(req.params.trackingNumber, archived);
    res.json({ shipment, message: archived ? 'Spedizione archiviata.' : 'Spedizione ripristinata tra le attive.' });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.patch('/api/control-center/:trackingNumber/case', async (req, res) => {
  try { res.json(await updateShipmentCase(req.params.trackingNumber, req.body ?? {})); }
  catch (error) { res.status(400).json({ error: error.message }); }
});

app.post('/api/control-center/:trackingNumber/prestashop-state', async (req, res) => {
  try {
    const stateId = String(req.body?.stateId || '').trim();
    if (!stateId) throw new Error('Seleziona lo stato PrestaShop di destinazione.');
    const shop = client();
    const states = await shop.listOrderStates();
    const targetState = states.find((state) => String(state.id) === stateId);
    if (!targetState) throw new Error('Lo stato PrestaShop selezionato non è disponibile.');
    res.json(await alignShipmentPrestaShopState({ trackingNumber: req.params.trackingNumber, stateId, targetState, shop }));
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.post('/api/control-center/bulk-prestashop-state', async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) throw new Error('Nessuna spedizione specificata per l’allineamento.');
    const shop = client();
    const states = await shop.listOrderStates();
    const statesMap = new Map(states.map((state) => [String(state.id), state]));

    const results = [];
    for (const item of items) {
      const tracking = String(item.trackingNumber || '').trim();
      const stateId = String(item.stateId || '').trim();
      try {
        if (!tracking) throw new Error('Numero di spedizione mancante.');
        const shipment = await getShipment(tracking);
        if (!shipment) throw new Error('Spedizione non presente nel centro di controllo.');
        if (!shipment.orderId) throw new Error('La spedizione non è collegata a un ordine PrestaShop.');
        if (!stateId) throw new Error('Stato PrestaShop non specificato.');
        const targetState = statesMap.get(stateId);
        if (!targetState) throw new Error('Lo stato PrestaShop selezionato non è disponibile.');

        const outcome = await alignShipmentPrestaShopState({ trackingNumber: tracking, stateId, targetState, shop });
        results.push({ trackingNumber: tracking, orderId: shipment.orderId, success: true, ...outcome });
      } catch (err) {
        results.push({ trackingNumber: tracking, success: false, error: err.message });
      }
    }

    const successfulCount = results.filter((r) => r.success && !r.skipped).length;
    const skippedCount = results.filter((r) => r.skipped).length;
    const failedCount = results.filter((r) => !r.success).length;

    res.json({
      total: items.length,
      successfulCount,
      skippedCount,
      failedCount,
      results,
    });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.get('/api/control-center/:trackingNumber/prestashop-live', async (req, res) => {
  try {
    const shipment = await getShipment(req.params.trackingNumber);
    if (!shipment) return res.status(404).json({ ok: false, error: 'Spedizione non presente nel centro di controllo.' });
    if (!connection.baseUrl || !connection.apiKey) {
      return res.json({ ok: false, notConfigured: true, error: 'PrestaShop non configurato. Configura prima URL e chiave API.' });
    }
    const shop = client();
    const live = await shop.getOrderLiveShippingInfo({
      orderId: shipment.orderId,
      orderReference: shipment.orderReference,
    });
    if (live.status !== 'ok') {
      return res.json({
        ok: false,
        error: live.error || 'Impossibile leggere i dati di spedizione da PrestaShop.',
        details: live,
      });
    }

    const carriers = await shop.listCarriers().catch(() => []);
    let defaultCarrierId = connection.defaultCarrierId || '';
    let defaultCarrierName = connection.defaultCarrierName || '';

    if (!defaultCarrierId && carriers.length) {
      const dsvCarrier = carriers.find((c) => /dsv|schenker/i.test(c.name));
      if (dsvCarrier) {
        defaultCarrierId = dsvCarrier.id;
        defaultCarrierName = dsvCarrier.name;
      } else {
        defaultCarrierId = carriers[0].id;
        defaultCarrierName = carriers[0].name;
      }
    } else if (defaultCarrierId && !defaultCarrierName) {
      const found = carriers.find((c) => String(c.id) === String(defaultCarrierId));
      if (found) defaultCarrierName = found.name;
    }

    const dsvTracking = String(shipment.trackingNumber || '').trim();
    const liveTracking = String(live.trackingNumber || '').trim();
    let trackingStatus = 'missing';
    if (liveTracking) {
      trackingStatus = liveTracking.toLocaleLowerCase('it-IT') === dsvTracking.toLocaleLowerCase('it-IT')
        ? 'matches'
        : 'differs';
    }

    const carrierMatches = defaultCarrierId ? String(live.carrierId) === String(defaultCarrierId) : false;

    res.json({
      ok: true,
      orderId: live.orderId,
      orderReference: live.orderReference,
      liveTracking,
      dsvTracking,
      trackingStatus,
      liveCarrierId: live.carrierId,
      liveCarrierName: live.carrierName,
      defaultCarrierId,
      defaultCarrierName,
      carrierMatches,
      availableCarriers: carriers,
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/control-center/:trackingNumber/sync-prestashop', async (req, res) => {
  try {
    const shipment = await getShipment(req.params.trackingNumber);
    if (!shipment) throw new Error('Spedizione non presente nel centro di controllo.');
    const shop = client();

    let orderId = shipment.orderId;
    if (!orderId && shipment.orderReference) {
      const orders = await shop.findOrdersByReference(shipment.orderReference);
      if (orders.length === 1) orderId = orders[0].id;
    }
    if (!orderId) throw new Error('Impossibile determinare l’ordine PrestaShop collegato a questa spedizione.');

    const carriers = await shop.listCarriers();
    let carrierId = req.body?.carrierId ? String(req.body.carrierId).trim() : connection.defaultCarrierId;
    if (!carrierId) {
      const dsvCarrier = carriers.find((c) => /dsv|schenker/i.test(c.name));
      carrierId = dsvCarrier ? dsvCarrier.id : (carriers[0]?.id || '');
    }
    if (!carrierId) throw new Error('Nessun corriere attivo trovato su PrestaShop per l’associazione.');

    const targetCarrier = carriers.find((c) => String(c.id) === String(carrierId));
    const carrierName = targetCarrier ? targetCarrier.name : `Corriere #${carrierId}`;

    const overwrite = Boolean(req.body?.overwrite);
    const outcome = await shop.applyOrderCarrierOnly({
      orderId,
      trackingNumber: shipment.trackingNumber,
      carrierId,
      overwrite,
    });

    if (req.body?.setAsDefaultCarrier || !connection.defaultCarrierId) {
      connection.defaultCarrierId = carrierId;
      connection.defaultCarrierName = carrierName;
      await saveSettings(connection);
    }

    const updated = await syncShipmentPrestaShopShipping(shipment.trackingNumber, {
      orderId,
      orderReference: shipment.orderReference,
      carrierId,
      carrierName,
      overwritten: outcome.overwritten,
    });

    res.json({
      success: true,
      message: outcome.overwritten
        ? `Tracking sovrascritto e corriere impostato su “${carrierName}”.`
        : `Tracking importato e corriere impostato su “${carrierName}”.`,
      shipment: updated,
      outcome,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/import/manual-row', async (req, res) => {
  try {
    const trackingNumber = String(req.body?.trackingNumber || '').trim();
    const orderReference = String(req.body?.orderReference || '').trim();
    const sourceRow = Number(req.body?.sourceRow) || 1;

    if (!trackingNumber && !orderReference) {
      return res.status(400).json({ error: 'Inserisci almeno il numero di tracking e il riferimento ordine.' });
    }
    if (!trackingNumber) {
      return res.status(400).json({ error: 'Numero tracking mancante.' });
    }
    if (!orderReference) {
      return res.status(400).json({ error: 'Riferimento ordine mancante.' });
    }

    const { byTracking, byReference } = await getExistingShipmentsIndex();
    const existing = byTracking.get(trackingNumber) || byReference.get(orderReference);

    if (existing) {
      return res.json({
        sourceRow,
        trackingNumber,
        orderReference,
        validation: 'Già importata (saltata)',
        alreadyImported: true,
        canApply: false,
        existingTracking: existing.trackingNumber,
        currentState: existing.currentState || '—',
        dsvStatus: existing.dsvStatus || '—',
      });
    }

    res.json({
      sourceRow,
      trackingNumber,
      orderReference,
      validation: 'Pronta per la verifica',
      alreadyImported: false,
      canApply: true,
      currentState: '—',
      dsvStatus: '—',
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/import/preview', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) throw new Error('Seleziona un file Excel.');
    const { byTracking, byReference } = await getExistingShipmentsIndex();
    const rawRows = readDsvWorkbook(req.file.buffer);
    const rows = rawRows.map((row) => {
      if (row.validation !== 'Pronta per la verifica') return row;
      const existing = (row.trackingNumber && byTracking.get(row.trackingNumber))
        || (row.orderReference && byReference.get(row.orderReference));
      if (existing) {
        return {
          ...row,
          validation: 'Già importata (saltata)',
          alreadyImported: true,
          canApply: false,
          existingTracking: existing.trackingNumber,
          currentState: existing.currentState || '—',
          dsvStatus: existing.dsvStatus || '—',
        };
      }
      return row;
    });
    const summary = rows.reduce((result, row) => {
      result.total += 1;
      if (row.alreadyImported) result.skipped += 1;
      else if (row.validation === 'Pronta per la verifica') result.ready += 1;
      else result.invalid += 1;
      return result;
    }, { total: 0, ready: 0, skipped: 0, invalid: 0 });
    res.json({ summary, rows });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.post('/api/import/verification-jobs', (req, res) => {
  const { rows, filename, origin } = req.body ?? {};
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'Carica prima un file da verificare.' });
  const candidates = rows.filter((row) => row.validation === 'Pronta per la verifica' && !row.alreadyImported);
  const job = { id: randomUUID(), filename, origin, status: 'running', progress: { completed: 0, total: candidates.length }, result: null, error: null };
  verificationJobs.set(job.id, job);
  void runVerification(job, rows);
  res.status(202).json({ jobId: job.id, progress: job.progress });
});

app.get('/api/import/verification-jobs/:jobId', (req, res) => {
  const job = verificationJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Verifica non trovata o scaduta.' });
  res.json({ status: job.status, progress: job.progress, result: job.status === 'complete' ? job.result : null, error: job.error });
});

app.post('/api/import/apply', async (req, res) => {
  try {
    const { verificationId, carrierId, stateId, selectedSourceRows, updateTracking, updateState } = req.body ?? {};
    const verified = verifiedImports.get(verificationId);
    if (!verified || verified.expiresAt < Date.now()) throw new Error('La verifica è scaduta. Eseguila nuovamente prima di importare.');
    const selectedRows = new Set((selectedSourceRows ?? []).map(Number));
    const rows = verified.rows.filter((row) => row.canApply && selectedRows.has(Number(row.sourceRow)));
    if (!rows.length) throw new Error('Seleziona almeno una riga pronta per aggiornamento.');
    if (!updateTracking && !updateState) throw new Error('Scegli almeno un aggiornamento: tracking/corriere o stato ordine.');
    if (updateTracking && !carrierId) throw new Error('Seleziona un corriere per aggiornare tracking e corriere.');
    if (updateState && !stateId) throw new Error('Seleziona uno stato ordine da applicare.');
    const shop = client();
    const results = [];
    for (const row of rows) {
      if (!row.canApply) { results.push({ ...row, result: 'Saltata', detail: row.verification || row.validation || 'Non verificata' }); continue; }
      try {
        const outcome = await shop.applyOrderUpdate({ orderId: row.orderId, trackingNumber: row.trackingNumber, carrierId, stateId, updateTracking, updateState });
        results.push({ ...row, result: 'Aggiornata', detail: outcome.trackingSkipped ? `Ordine ${row.orderId}: tracking già presente, aggiornato solo lo stato` : `Ordine ${row.orderId}` });
      } catch (error) { results.push({ ...row, result: 'Errore', detail: error.message }); }
    }
    const summary = results.reduce((output, item) => { output[item.result] = (output[item.result] ?? 0) + 1; return output; }, {});
    await syncAppliedShipments(results);
    verifiedImports.delete(verificationId);
    res.json({ summary, results });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.post('/api/import/apply-jobs', (req, res) => {
  try {
    const prepared = prepareApply(req.body ?? {});
    if (prepared.verified.inUse) throw new Error('Un aggiornamento per questa verifica è già in corso.');
    prepared.verified.inUse = true;
    const job = { id: randomUUID(), status: 'running', progress: { completed: 0, total: prepared.rows.length }, result: null, error: null };
    applyJobs.set(job.id, job);
    void runApplyJob(job, prepared);
    res.status(202).json({ jobId: job.id, progress: job.progress });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.get('/api/import/apply-jobs/:jobId', (req, res) => {
  const job = applyJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Aggiornamento non trovato o scaduto.' });
  res.json({ status: job.status, progress: job.progress, result: job.status === 'complete' ? job.result : null, error: job.error });
});

app.use((error, _req, res, _next) => res.status(500).json({ error: error.message || 'Errore inatteso.' }));
app.listen(port, () => console.log(`Importatore disponibile su http://localhost:${port}`));

function chunks(items, size) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_value, index) => items.slice(index * size, index * size + size));
}

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function dsvCacheTtl(result) {
  if (!result || result.parserVersion !== DSV_PARSER_VERSION) return 0;
  if (result.status === 'Consegnata') return DSV_BETA_CACHE_TTL_MS;
  if (['Prenotata', 'In transito', 'Centro di distribuzione', 'In consegna'].includes(result.status)) return DSV_MOVING_CACHE_TTL_MS;
  if (result.status === 'Spedizione non trovata') return DSV_NOT_FOUND_CACHE_TTL_MS;
  return 0;
}

function scheduleDsvBetaJob(job, trackingNumbers) {
  dsvBetaQueue = dsvBetaQueue.then(async () => {
    job.status = 'running';
    await runDsvBetaJob(job, trackingNumbers);
  }).catch((error) => {
    job.error = error.message;
    job.status = 'failed';
  });
}

function prepareApply(payload) {
  const { verificationId, carrierId, stateId, selectedSourceRows, updateTracking, updateState } = payload;
  const verified = verifiedImports.get(verificationId);
  if (!verified || verified.expiresAt < Date.now()) throw new Error('La verifica è scaduta. Eseguila nuovamente prima di importare.');
  const selectedRows = new Set((selectedSourceRows ?? []).map(Number));
  const rows = verified.rows.filter((row) => row.canApply && selectedRows.has(Number(row.sourceRow)));
  if (!rows.length) throw new Error('Seleziona almeno una riga pronta per aggiornamento.');
  if (!updateTracking && !updateState) throw new Error('Scegli almeno un aggiornamento: tracking/corriere o stato ordine.');
  if (updateTracking && !carrierId) throw new Error('Seleziona un corriere per aggiornare tracking e corriere.');
  if (updateState && !stateId) throw new Error('Seleziona uno stato ordine da applicare.');
  return { verified, verificationId, carrierId, stateId, updateTracking: Boolean(updateTracking), updateState: Boolean(updateState), rows };
}

async function runApplyJob(job, prepared) {
  try {
    const shop = client();
    const results = [];
    for (const [index, row] of prepared.rows.entries()) {
      try {
        const outcome = await shop.applyOrderUpdate({ orderId: row.orderId, trackingNumber: row.trackingNumber, carrierId: prepared.carrierId, stateId: prepared.stateId, updateTracking: prepared.updateTracking, updateState: prepared.updateState });
        results.push({ ...row, result: 'Aggiornata', detail: outcome.trackingSkipped ? `Ordine ${row.orderId}: tracking già presente, aggiornato solo lo stato` : `Ordine ${row.orderId}` });
      } catch (error) { results.push({ ...row, result: 'Errore', detail: error.message }); }
      job.progress.completed = index + 1;
    }
    const summary = results.reduce((output, item) => { output[item.result] = (output[item.result] ?? 0) + 1; return output; }, {});
    await syncAppliedShipments(results);
    verifiedImports.delete(prepared.verificationId);
    job.result = { summary, results };
    job.status = 'complete';
  } catch (error) {
    prepared.verified.inUse = false;
    job.error = error.message;
    job.status = 'failed';
  }
}

async function runDsvBetaJob(job, trackingNumbers) {
  try {
    const beta = new DsvBetaClient(connection.dsvBeta);
    const results = [];
    for (const [index, trackingNumber] of trackingNumbers.entries()) {
      const cached = dsvBetaCache.get(trackingNumber);
      if (cached && cached.expiresAt > Date.now() && cached.parserVersion === DSV_PARSER_VERSION) {
        results.push({ trackingNumber, ...cached.value, cached: true });
      } else {
        const existing = await getShipment(trackingNumber);
        if (existing?.dsvStatus === 'Consegnata') {
          const cachedValue = {
            status: 'Consegnata',
            detail: existing.dsvDetail || 'Spedizione già consegnata (salto intelligente).',
            rawStatus: existing.dsvRawStatus || 'Consegnata',
            evidence: existing.dsvEvidence || 'store-delivered',
            confidence: 1,
            reasonCode: 'ALREADY_DELIVERED',
            statusDateRaw: existing.dsvStatusDateRaw || '',
            statusAt: existing.dsvStatusAt || '',
            statusDatePrecision: existing.dsvStatusDatePrecision || '',
            source: 'Archivio locale (spedizione completata)',
            trackingUrl: existing.dsvTrackingUrl || '',
            timeline: existing.dsvTimeline || [],
          };
          dsvBetaCache.set(trackingNumber, { value: cachedValue, parserVersion: DSV_PARSER_VERSION, expiresAt: Date.now() + DSV_BETA_CACHE_TTL_MS });
          results.push({ trackingNumber, ...cachedValue, cached: true });
        } else {
          try {
            const value = await beta.track(trackingNumber);
            const cacheTtl = dsvCacheTtl(value);
            if (cacheTtl) dsvBetaCache.set(trackingNumber, { value, parserVersion: DSV_PARSER_VERSION, expiresAt: Date.now() + cacheTtl });
            else dsvBetaCache.delete(trackingNumber);
            results.push({ trackingNumber, ...value, cached: false });
            if (value.reasonCode === 'ACCESS_GUARD' || value.status === 'Intervento manuale richiesto') {
              beta.resetSession();
              if (index < trackingNumbers.length - 1) await pause(6000 + Math.floor(Math.random() * 2000));
            }
          } catch (error) {
            results.push({ trackingNumber, status: 'Errore beta', detail: error.message, source: 'Nessuna modifica è stata eseguita.' });
            beta.resetSession();
            if (index < trackingNumbers.length - 1) await pause(5000);
          }
        }
      }
      job.progress.completed = index + 1;
      const lastResult = results[results.length - 1];
      if (index < trackingNumbers.length - 1 && !lastResult?.cached) {
        await pause(naturalJitterInterval());
      }
    }
    job.result = { results, safeguards: { maxRows: DSV_BETA_MAX_ROWS, intervalMs: DSV_BETA_INTERVAL_MS, cacheHours: DSV_BETA_CACHE_TTL_MS / 3_600_000, movingCacheHours: DSV_MOVING_CACHE_TTL_MS / 3_600_000, parserVersion: DSV_PARSER_VERSION } };
    await syncDsvShipments(results);
    job.status = 'complete';
  } catch (error) { job.error = error.message; job.status = 'failed'; }
}

async function runVerification(job, rows) {
  try {
    const shop = client();
    const candidates = rows.filter((row) => row.validation === 'Pronta per la verifica' && !row.alreadyImported);
    const stateNames = new Map();
    try {
      const states = await shop.listOrderStates();
      for (const state of states) stateNames.set(String(state.id), state.name);
    } catch { /* The order can still be verified; the state will fall back to its id. */ }
    const outcomes = new Map();
    for (const batch of chunks(candidates, VERIFY_BATCH_SIZE)) {
      try {
        const checks = await shop.inspectOrdersByReferences(batch.map((row) => row.orderReference), stateNames);
        for (const check of checks) outcomes.set(check.reference, check);
      } catch (error) {
        for (const row of batch) outcomes.set(row.orderReference, { status: 'Errore di verifica', detail: error.message });
      }
      job.progress.completed += batch.length;
    }
    const verified = rows.map((row) => {
      if (row.alreadyImported) return { ...row, verification: 'Già importata (saltata)', canApply: false };
      if (row.validation !== 'Pronta per la verifica') return { ...row, verification: row.validation, canApply: false };
      const check = outcomes.get(row.orderReference);
      return { ...row, verification: check.status, existingTracking: check.existingTracking ?? '', orderId: check.orderId ?? '', orderDate: check.orderDate ?? '', prestaStateId: check.prestaStateId ?? '', currentState: check.currentState ?? '—', canApply: ['Pronta per aggiornamento', 'Tracking già presente'].includes(check.status) };
    });
    const summary = verified.reduce((output, row) => { output[row.verification] = (output[row.verification] ?? 0) + 1; return output; }, {});
    await syncVerifiedShipments(verified);
    try {
      await registerImportBatch({
        origin: job.origin || 'excel',
        filename: job.filename || (job.origin === 'manual' ? 'Inserimento manuale' : 'File Excel'),
        totalRows: rows.length,
        newCount: verified.filter((r) => !r.alreadyImported && r.validation === 'Pronta per la verifica').length,
        skippedCount: verified.filter((r) => r.alreadyImported).length,
        trackingNumbers: verified.map((r) => r.trackingNumber).filter(Boolean),
      });
    } catch (batchErr) {
      console.error('[BATCH] Errore registrazione lotto:', batchErr.message);
    }
    const verificationId = randomUUID();
    verifiedImports.set(verificationId, { rows: verified, expiresAt: Date.now() + VERIFIED_IMPORT_TTL_MS });
    job.result = { verificationId, summary, rows: verified, requestPlan: { batches: Math.ceil(candidates.length / VERIFY_BATCH_SIZE), maxRequests: 1 + Math.ceil(candidates.length / VERIFY_BATCH_SIZE) * 2, intervalMs: 800 } };
    job.status = 'complete';
  } catch (error) {
    job.error = error.message;
    job.status = 'failed';
  }
}
