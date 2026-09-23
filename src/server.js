import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import express from 'express';
import multer from 'multer';
import { readDsvWorkbook } from './excel-import.js';
import { PrestaShopClient } from './prestashop-client.js';
import { exportSettingsData, loadSettings, normalizeCronSettings, normalizeDsvStateMappings, normalizeNotificationSettings, restoreSettingsData, saveSettings } from './settings-store.js';
import { DEFAULT_DSV_TRACKING_URL, DSV_DELIVERY_EVENT_STATUSES, DSV_PARSER_VERSION, DSV_SPEED_PROFILES, DsvBetaClient, normalizeBetaSettings } from './dsv-beta-client.js';
import { DsvCronService } from './dsv-cron.js';
import { NotificationService } from './notification-service.js';
import { archiveShipment, deleteArchivedShipment, deleteImportBatch, exportShipmentsData, getAuditLog, getControlCenter, getExistingShipmentsIndex, getImportBatches, getShipment, linkShipmentToPrestaShopOrder, registerImportBatch, restoreShipmentsData, syncAppliedShipments, syncDsvShipments, syncManualPrestaShopState, syncShipmentPrestaShopShipping, syncVerifiedShipments, updateShipmentCase } from './shipment-store.js';

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const port = Number(process.env.PORT ?? 3000);
const VERIFY_BATCH_SIZE = 30;
const VERIFIED_IMPORT_TTL_MS = 15 * 60 * 1000;
const verifiedImports = new Map();
const verificationJobs = new Map();
const applyJobs = new Map();
const dsvBetaJobs = new Map();
const DSV_BETA_BATCH_SIZE = 10;
const DSV_BETA_MAX_ROWS = 100;
const DSV_BETA_JOB_RETENTION_MS = 6 * 60 * 60 * 1000;
const DSV_BETA_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DSV_MOVING_CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const DSV_NOT_FOUND_CACHE_TTL_MS = 60 * 60 * 1000;
const dsvBetaCache = new Map();
const prestashopOrderStateLocks = new Map();

let dsvBetaQueue = Promise.resolve();
let connection = await loadSettings({
  baseUrl: process.env.PRESTASHOP_URL ?? '',
  apiKey: process.env.PRESTASHOP_WEBSERVICE_KEY ?? '',
  dsvBeta: { enabled: false, camofoxUrl: process.env.CAMOFOX_URL ?? 'http://127.0.0.1:9377', trackingUrl: process.env.DSV_TRACKING_URL ?? DEFAULT_DSV_TRACKING_URL, speedProfile: 'safe' },
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

function dsvBetaConfigResponse() {
  const profile = DSV_SPEED_PROFILES[connection.dsvBeta?.speedProfile] || DSV_SPEED_PROFILES.safe;
  const intervalMs = Math.round((profile.manualDelayMs[0] + profile.manualDelayMs[1]) / 2);
  return { ...connection.dsvBeta, maxRows: DSV_BETA_MAX_ROWS, batchSize: DSV_BETA_BATCH_SIZE, intervalMs, cacheHours: DSV_BETA_CACHE_TTL_MS / 3_600_000, movingCacheHours: DSV_MOVING_CACHE_TTL_MS / 3_600_000, parserVersion: DSV_PARSER_VERSION };
}

app.get('/api/dsv-beta/config', (_req, res) => {
  res.json(dsvBetaConfigResponse());
});

app.post('/api/dsv-beta/config', async (req, res) => {
  try {
    connection = { ...connection, dsvBeta: normalizeBetaSettings(req.body ?? {}) };
    await saveSettings(connection);
    res.json(dsvBetaConfigResponse());
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
    if (trackingNumbers.length > DSV_BETA_MAX_ROWS) throw new Error(`La verifica accetta al massimo ${DSV_BETA_MAX_ROWS} spedizioni per operazione.`);
    const queuedAhead = [...dsvBetaJobs.values()].filter((candidate) => ['queued', 'running', 'cancelling'].includes(candidate.status)).length;
    const job = {
      id: randomUUID(),
      status: 'queued',
      cancelRequested: false,
      results: [],
      averageDurationMs: 0,
      config: { ...connection.dsvBeta },
      progress: {
        completed: 0,
        total: trackingNumbers.length,
        batchSize: DSV_BETA_BATCH_SIZE,
        batchIndex: 1,
        batchCount: Math.ceil(trackingNumbers.length / DSV_BETA_BATCH_SIZE),
        queuePosition: queuedAhead,
        phase: 'queued',
        currentTracking: '',
        lastTracking: '',
        lastStatus: '',
        cachedCount: 0,
        errorCount: 0,
        requestedSpeedProfile: connection.dsvBeta?.speedProfile || 'safe',
        effectiveSpeedProfile: connection.dsvBeta?.speedProfile || 'safe',
        fallbackReason: '',
        queuedAt: new Date().toISOString(),
        startedAt: '',
        updatedAt: new Date().toISOString(),
      },
      result: null,
      error: null,
    };
    dsvBetaJobs.set(job.id, job);
    scheduleDsvBetaJob(job, trackingNumbers);
    res.status(202).json({ jobId: job.id, progress: job.progress });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.get('/api/dsv-beta/jobs/:jobId', (req, res) => {
  const job = dsvBetaJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Verifica DSV non trovata o scaduta.' });
  const activeQueue = [...dsvBetaJobs.values()].filter((candidate) => ['queued', 'running', 'cancelling'].includes(candidate.status));
  const queueIndex = activeQueue.findIndex((candidate) => candidate.id === job.id);
  const progress = { ...job.progress, queuePosition: job.status === 'queued' ? Math.max(0, queueIndex) : 0 };
  res.json({
    status: job.status,
    progress,
    partialResults: job.results,
    result: ['complete', 'cancelled', 'failed'].includes(job.status) ? job.result : null,
    error: job.error,
  });
});

app.post('/api/dsv-beta/jobs/:jobId/cancel', (req, res) => {
  const job = dsvBetaJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Verifica DSV non trovata o scaduta.' });
  if (['complete', 'cancelled', 'failed'].includes(job.status)) {
    return res.json({ ok: true, status: job.status, message: 'La verifica è già terminata.' });
  }
  job.cancelRequested = true;
  job.status = 'cancelling';
  job.progress.phase = 'cancelling';
  job.progress.updatedAt = new Date().toISOString();
  res.status(202).json({ ok: true, status: job.status, message: 'La verifica si interromperà dopo la spedizione corrente.' });
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
    const exceptions = records.filter((r) => !r.archived && (DSV_DELIVERY_EVENT_STATUSES.includes(r.dsvStatus) || r.caseStatus === 'Aperta')).length;
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

app.delete('/api/history/batches/:batchId', async (req, res) => {
  try {
    const batch = await deleteImportBatch(req.params.batchId);
    res.json({ ok: true, batchId: batch.id, message: 'Lotto eliminato dallo storico. Le spedizioni collegate non sono state modificate.' });
  } catch (error) {
    const status = /non trovato/i.test(error.message) ? 404 : 400;
    res.status(status).json({ error: error.message });
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
      prestaState: req.query.prestaState,
      checkedAfter: req.query.checkedAfter,
      exceptionOnly: req.query.exceptions === '1',
      archived: req.query.archived === '1' || req.query.archived === 'true',
      page: req.query.page,
      pageSize: req.query.pageSize,
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

async function resolvePrestaShopLinkCandidate(shop, shipment, rawQuery) {
  const query = String(rawQuery || '').trim();
  if (!query) throw new Error('Inserisci un ID ordine o un riferimento PrestaShop.');
  if (query.length > 120) throw new Error('Il riferimento inserito è troppo lungo.');
  const lookup = /^\d+$/.test(query)
    ? { orderId: query, orderReference: '' }
    : { orderId: '', orderReference: query };
  const live = await shop.getOrderLiveShippingInfo(lookup);
  if (live.status !== 'ok') throw new Error(live.error || 'Ordine non trovato su PrestaShop.');

  const states = await shop.listOrderStates().catch(() => []);
  const currentState = states.find((state) => String(state.id) === String(live.currentStateId || ''));
  const localTracking = String(shipment.trackingNumber || '').trim();
  const remoteTracking = String(live.trackingNumber || '').trim();
  const trackingMatches = Boolean(remoteTracking) && remoteTracking.toLocaleLowerCase('it-IT') === localTracking.toLocaleLowerCase('it-IT');

  return {
    orderId: live.orderId,
    orderReference: live.orderReference,
    orderDate: live.orderDate || '',
    currentStateId: live.currentStateId || '',
    currentStateName: currentState?.name || '',
    trackingNumber: remoteTracking,
    carrierId: live.carrierId || '',
    carrierName: live.carrierName || '',
    trackingMatches,
    trackingConflict: Boolean(remoteTracking) && !trackingMatches,
  };
}

app.post('/api/control-center/:trackingNumber/archive', async (req, res) => {
  try {
    const archived = req.body?.archived !== undefined ? Boolean(req.body.archived) : true;
    const shipment = await archiveShipment(req.params.trackingNumber, archived);
    res.json({ shipment, message: archived ? 'Spedizione archiviata.' : 'Spedizione ripristinata tra le attive.' });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.delete('/api/control-center/:trackingNumber', async (req, res) => {
  try {
    const result = await deleteArchivedShipment(req.params.trackingNumber);
    res.json({ ...result, message: 'Spedizione archiviata eliminata definitivamente dal tracking center.' });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.post('/api/control-center/:trackingNumber/prestashop-link/preview', async (req, res) => {
  try {
    const shipment = await getShipment(req.params.trackingNumber);
    if (!shipment) return res.status(404).json({ error: 'Spedizione non presente nel centro di controllo.' });
    const candidate = await resolvePrestaShopLinkCandidate(client(), shipment, req.body?.query);
    res.json({ candidate });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.post('/api/control-center/:trackingNumber/prestashop-link', async (req, res) => {
  try {
    const shipment = await getShipment(req.params.trackingNumber);
    if (!shipment) return res.status(404).json({ error: 'Spedizione non presente nel centro di controllo.' });
    const candidate = await resolvePrestaShopLinkCandidate(client(), shipment, req.body?.query);
    if (candidate.trackingConflict && req.body?.allowTrackingMismatch !== true) {
      throw new Error('Il tracking dell’ordine è diverso. Conferma esplicitamente il collegamento per continuare.');
    }
    const linked = await linkShipmentToPrestaShopOrder(req.params.trackingNumber, {
      orderId: candidate.orderId,
      orderReference: candidate.orderReference,
      orderDate: candidate.orderDate,
      currentStateId: candidate.currentStateId,
      currentStateName: candidate.currentStateName,
      trackingNumberOnPrestaShop: candidate.trackingNumber,
      carrierId: candidate.carrierId,
      carrierName: candidate.carrierName,
    });
    res.json({ shipment: linked, candidate, message: `Spedizione collegata all’ordine ${candidate.orderReference || candidate.orderId}. PrestaShop non è stato modificato.` });
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

    const preserveCarrier = Boolean(req.body?.preserveCarrier);
    const carriers = preserveCarrier ? await shop.listCarriers().catch(() => []) : await shop.listCarriers();
    let carrierId = preserveCarrier ? '' : (req.body?.carrierId ? String(req.body.carrierId).trim() : connection.defaultCarrierId);
    if (!preserveCarrier && !carrierId) {
      const dsvCarrier = carriers.find((c) => /dsv|schenker/i.test(c.name));
      carrierId = dsvCarrier ? dsvCarrier.id : (carriers[0]?.id || '');
    }
    if (!preserveCarrier && !carrierId) throw new Error('Nessun corriere trovato su PrestaShop per l’associazione.');

    const overwrite = Boolean(req.body?.overwrite);
    const skipIfDifferent = Boolean(req.body?.skipIfDifferent);
    let outcome = null;
    let skipped = false;
    try {
      outcome = await shop.applyOrderCarrierOnly({ orderId, trackingNumber: shipment.trackingNumber, carrierId, overwrite });
    } catch (error) {
      if (/già presente/i.test(error.message) && skipIfDifferent) {
        skipped = true;
        outcome = { overwritten: false, skipped: true };
      } else {
        throw error;
      }
    }

    const effectiveCarrierId = String(outcome?.carrierId || carrierId || '').trim();
    const targetCarrier = carriers.find((candidate) => String(candidate.id) === effectiveCarrierId);
    const carrierName = targetCarrier ? targetCarrier.name : (preserveCarrier ? '' : `Corriere #${effectiveCarrierId}`);

    if (!preserveCarrier && (req.body?.setAsDefaultCarrier || !connection.defaultCarrierId)) {
      connection.defaultCarrierId = carrierId;
      connection.defaultCarrierName = carrierName;
      await saveSettings(connection);
    }

    const updated = skipped ? shipment : await syncShipmentPrestaShopShipping(shipment.trackingNumber, {
      orderId,
      orderReference: shipment.orderReference,
      carrierId: effectiveCarrierId,
      carrierName,
      overwritten: Boolean(outcome?.overwritten),
    });

    const targetStateId = req.body?.stateId ? String(req.body.stateId).trim() : '';
    let stateOutcome = null;
    if (targetStateId) {
      stateOutcome = await shop.applyOrderStateSafely({ orderId, stateId: targetStateId });
      const states = await shop.listOrderStates().catch(() => []);
      const matchedState = states.find((state) => String(state.id) === targetStateId);
      await syncManualPrestaShopState(shipment.trackingNumber, {
        stateId: targetStateId,
        stateName: matchedState?.name || `Stato #${targetStateId}`,
      });
    }

    res.json({
      success: true,
      skipped,
      message: skipped
        ? 'Tracking già presente su PrestaShop, spedizione saltata senza sovrascrittura.'
        : outcome.overwritten
          ? preserveCarrier ? 'Tracking sovrascritto senza modificare il corriere.' : `Tracking sovrascritto e corriere impostato su “${carrierName}”.`
          : preserveCarrier ? 'Tracking importato senza modificare il corriere.' : `Tracking importato e corriere impostato su “${carrierName}”.`,
      shipment: updated,
      outcome,
      stateOutcome,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/control-center/bulk-sync-tracking', async (req, res) => {
  try {
    const trackingNumbers = Array.isArray(req.body?.trackingNumbers)
      ? req.body.trackingNumbers.map((tracking) => String(tracking).trim()).filter(Boolean)
      : [];
    if (!trackingNumbers.length) throw new Error('Seleziona almeno una spedizione da sincronizzare.');

    const shop = client();
    const carriers = await shop.listCarriers().catch(() => []);
    const preserveCarrier = Boolean(req.body?.preserveCarrier);
    let carrierId = preserveCarrier ? '' : (req.body?.carrierId ? String(req.body.carrierId).trim() : connection.defaultCarrierId);
    if (!preserveCarrier && !carrierId && carriers.length) {
      const dsvCarrier = carriers.find((carrier) => /dsv|schenker/i.test(carrier.name));
      carrierId = dsvCarrier ? dsvCarrier.id : carriers[0].id;
    }
    if (!preserveCarrier && !carrierId) throw new Error('Nessun corriere trovato su PrestaShop per l’associazione.');

    const targetCarrier = carriers.find((carrier) => String(carrier.id) === String(carrierId));
    const carrierName = targetCarrier ? targetCarrier.name : (preserveCarrier ? 'Corriere esistente' : `Corriere #${carrierId}`);
    const overwrite = Boolean(req.body?.overwrite);
    const skipIfDifferent = Boolean(req.body?.skipIfDifferent ?? !overwrite);
    const targetStateId = req.body?.stateId ? String(req.body.stateId).trim() : '';
    const states = targetStateId ? await shop.listOrderStates().catch(() => []) : [];
    const targetState = states.find((state) => String(state.id) === targetStateId);
    const results = [];

    for (const tracking of trackingNumbers) {
      try {
        const shipment = await getShipment(tracking);
        if (!shipment) throw new Error('Spedizione non presente nel database locale.');

        let orderId = shipment.orderId;
        if (!orderId && shipment.orderReference) {
          const orders = await shop.findOrdersByReference(shipment.orderReference);
          if (orders.length === 1) orderId = orders[0].id;
          else if (orders.length > 1) throw new Error(`Riferimento ambiguo: ${orders.length} ordini trovati`);
          else throw new Error(`Ordine ${shipment.orderReference} non trovato`);
        }
        if (!orderId) throw new Error('Riferimento ordine non collegato.');

        let outcome = null;
        let skipped = false;
        try {
          outcome = await shop.applyOrderCarrierOnly({
            orderId,
            trackingNumber: shipment.trackingNumber,
            carrierId,
            overwrite,
          });
        } catch (error) {
          if (/già presente/i.test(error.message) && skipIfDifferent) {
            skipped = true;
            outcome = { overwritten: false, skipped: true };
          } else {
            throw error;
          }
        }

        const effectiveCarrierId = String(outcome?.carrierId || carrierId || '').trim();
        const effectiveCarrier = carriers.find((candidate) => String(candidate.id) === effectiveCarrierId);
        const effectiveCarrierName = effectiveCarrier ? effectiveCarrier.name : (preserveCarrier ? '' : carrierName);
        if (!skipped) {
          await syncShipmentPrestaShopShipping(shipment.trackingNumber, {
            orderId,
            orderReference: shipment.orderReference,
            carrierId: effectiveCarrierId,
            carrierName: effectiveCarrierName,
            overwritten: Boolean(outcome?.overwritten),
          });
        }

        if (targetStateId && !skipped) {
          await shop.applyOrderStateSafely({ orderId, stateId: targetStateId });
          await syncManualPrestaShopState(shipment.trackingNumber, {
            stateId: targetStateId,
            stateName: targetState?.name || `Stato #${targetStateId}`,
          });
        }

        results.push({
          trackingNumber: tracking,
          orderId,
          orderReference: shipment.orderReference || orderId,
          success: true,
          skipped,
          overwritten: Boolean(outcome?.overwritten),
          detail: skipped
            ? 'Tracking già presente su PrestaShop (non sovrascritto)'
            : outcome?.overwritten
              ? preserveCarrier ? 'Tracking sovrascritto; corriere invariato' : `Tracking sovrascritto (Corriere: ${effectiveCarrierName})`
              : preserveCarrier ? 'Tracking inviato; corriere invariato' : `Tracking inviato (Corriere: ${effectiveCarrierName})`,
        });
      } catch (error) {
        results.push({ trackingNumber: tracking, success: false, error: error.message || 'Errore durante la sincronizzazione' });
      }
    }

    res.json({
      total: trackingNumbers.length,
      successfulCount: results.filter((result) => result.success && !result.skipped).length,
      skippedCount: results.filter((result) => result.success && result.skipped).length,
      failedCount: results.filter((result) => !result.success).length,
      carrierName: preserveCarrier ? 'Invariato' : carrierName,
      results,
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
        const detail = outcome.trackingSkipped
          ? `Ordine ${row.orderId}: tracking già presente, aggiornato solo lo stato`
          : outcome.recoveredAfterError
            ? `Ordine ${row.orderId}: tracking e corriere confermati tramite rilettura dopo una risposta anomala di PrestaShop`
            : `Ordine ${row.orderId}`;
        results.push({ ...row, result: 'Aggiornata', detail });
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

async function pauseDsvBetaJob(job, milliseconds) {
  const deadline = Date.now() + milliseconds;
  while (!job.cancelRequested && Date.now() < deadline) {
    await pause(Math.min(250, deadline - Date.now()));
  }
  return !job.cancelRequested;
}

function cleanupDsvBetaJobLater(job) {
  const timer = setTimeout(() => dsvBetaJobs.delete(job.id), DSV_BETA_JOB_RETENTION_MS);
  timer.unref?.();
}

function dsvBetaJobSafeguards(beta, job) {
  const runtimeProfile = beta?.getRuntimeProfile?.() || {
    requested: job.progress.requestedSpeedProfile,
    effective: job.progress.effectiveSpeedProfile,
    fallbackReason: job.progress.fallbackReason,
  };
  return {
    maxRows: DSV_BETA_MAX_ROWS,
    batchSize: DSV_BETA_BATCH_SIZE,
    batchCount: job.progress.batchCount,
    intervalMs: dsvBetaConfigResponse().intervalMs,
    cacheHours: DSV_BETA_CACHE_TTL_MS / 3_600_000,
    movingCacheHours: DSV_MOVING_CACHE_TTL_MS / 3_600_000,
    parserVersion: DSV_PARSER_VERSION,
    speedProfile: runtimeProfile.requested,
    effectiveSpeedProfile: runtimeProfile.effective,
    fallbackReason: runtimeProfile.fallbackReason,
  };
}

function dsvCacheTtl(result) {
  if (!result || result.parserVersion !== DSV_PARSER_VERSION) return 0;
  if (result.status === 'Consegnata') return DSV_BETA_CACHE_TTL_MS;
  if (['Prenotata', 'In transito', 'Centro di distribuzione', 'In consegna'].includes(result.status)) return DSV_MOVING_CACHE_TTL_MS;
  if (result.status === 'Spedizione non trovata') return DSV_NOT_FOUND_CACHE_TTL_MS;
  return 0;
}

function scheduleDsvBetaJob(job, trackingNumbers) {
  dsvBetaQueue = dsvBetaQueue.then(async () => {
    if (job.cancelRequested) {
      job.status = 'cancelled';
      job.progress.phase = 'cancelled';
      job.progress.finishedAt = new Date().toISOString();
      job.progress.updatedAt = job.progress.finishedAt;
      job.result = { results: job.results, cancelled: true, safeguards: dsvBetaJobSafeguards(null, job) };
      cleanupDsvBetaJobLater(job);
      return;
    }
    job.status = 'running';
    job.progress.phase = 'preparing';
    job.progress.startedAt = new Date().toISOString();
    job.progress.updatedAt = job.progress.startedAt;
    await runDsvBetaJob(job, trackingNumbers);
  }).catch((error) => {
    job.error = error.message;
    job.status = 'failed';
    job.progress.phase = 'failed';
    job.result = { results: job.results, cancelled: false, safeguards: dsvBetaJobSafeguards(null, job) };
    job.progress.updatedAt = new Date().toISOString();
    cleanupDsvBetaJobLater(job);
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
        const detail = outcome.trackingSkipped
          ? `Ordine ${row.orderId}: tracking già presente, aggiornato solo lo stato`
          : outcome.recoveredAfterError
            ? `Ordine ${row.orderId}: tracking e corriere confermati tramite rilettura dopo una risposta anomala di PrestaShop`
            : `Ordine ${row.orderId}`;
        results.push({ ...row, result: 'Aggiornata', detail });
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
  const beta = new DsvBetaClient(job.config);
  try {
    for (const [index, trackingNumber] of trackingNumbers.entries()) {
      if (job.cancelRequested) break;
      const checkStartedAt = Date.now();
      const profileBeforeCheck = beta.getRuntimeProfile();
      Object.assign(job.progress, {
        phase: 'checking',
        batchIndex: Math.floor(index / DSV_BETA_BATCH_SIZE) + 1,
        currentTracking: trackingNumber,
        effectiveSpeedProfile: profileBeforeCheck.effective,
        fallbackReason: profileBeforeCheck.fallbackReason,
        updatedAt: new Date().toISOString(),
      });
      const cached = dsvBetaCache.get(trackingNumber);
      if (cached && cached.expiresAt > Date.now() && cached.parserVersion === DSV_PARSER_VERSION) {
        job.results.push({ trackingNumber, ...cached.value, cached: true });
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
          job.results.push({ trackingNumber, ...cachedValue, cached: true });
        } else {
          try {
            const value = await beta.track(trackingNumber);
            const cacheTtl = dsvCacheTtl(value);
            if (cacheTtl) dsvBetaCache.set(trackingNumber, { value, parserVersion: DSV_PARSER_VERSION, expiresAt: Date.now() + cacheTtl });
            else dsvBetaCache.delete(trackingNumber);
            job.results.push({ trackingNumber, ...value, cached: false });
            if (value.reasonCode === 'ACCESS_GUARD' || value.status === 'Intervento manuale richiesto') {
              await beta.resetSession('Modalità affidabile attivata dopo una richiesta di verifica da parte di DSV.');
              if (index < trackingNumbers.length - 1) await pauseDsvBetaJob(job, 6000 + Math.floor(Math.random() * 2000));
            }
          } catch (error) {
            job.results.push({ trackingNumber, status: 'Errore beta', detail: error.message, source: 'Nessuna modifica è stata eseguita.', cached: false });
            await beta.resetSession('Modalità affidabile attivata dopo un errore di navigazione Camoufox.');
            if (index < trackingNumbers.length - 1) await pauseDsvBetaJob(job, 5000);
          }
        }
      }
      const lastResult = job.results[job.results.length - 1];
      await syncDsvShipments([lastResult]);
      if (!lastResult.cached) {
        const durationMs = Date.now() - checkStartedAt;
        job.averageDurationMs = job.averageDurationMs
          ? Math.round((job.averageDurationMs * 0.65) + (durationMs * 0.35))
          : durationMs;
      }
      const runtimeProfile = beta.getRuntimeProfile();
      Object.assign(job.progress, {
        completed: index + 1,
        phase: job.cancelRequested ? 'cancelling' : index < trackingNumbers.length - 1 && !lastResult?.cached ? 'waiting' : 'checking',
        lastTracking: lastResult?.trackingNumber || trackingNumber,
        lastStatus: lastResult?.status || '',
        cachedCount: job.results.filter((result) => result.cached).length,
        errorCount: job.results.filter((result) => result.status === 'Errore beta').length,
        averageDurationMs: job.averageDurationMs,
        liveSampleCount: job.results.filter((result) => !result.cached).length,
        effectiveSpeedProfile: runtimeProfile.effective,
        fallbackReason: runtimeProfile.fallbackReason,
        updatedAt: new Date().toISOString(),
      });
      if (!job.cancelRequested && index < trackingNumbers.length - 1 && !lastResult?.cached) {
        await pauseDsvBetaJob(job, beta.getPacingDelay('manual'));
      }
    }
    job.result = { results: job.results, cancelled: job.cancelRequested, safeguards: dsvBetaJobSafeguards(beta, job) };
    job.progress.phase = job.cancelRequested ? 'cancelled' : 'complete';
    job.progress.currentTracking = '';
    job.status = job.cancelRequested ? 'cancelled' : 'complete';
    job.progress.finishedAt = new Date().toISOString();
    job.progress.updatedAt = job.progress.finishedAt;
  } catch (error) {
    job.error = error.message;
    job.status = 'failed';
    job.progress.phase = 'failed';
    job.progress.currentTracking = '';
    job.result = { results: job.results, cancelled: false, safeguards: dsvBetaJobSafeguards(beta, job) };
    job.progress.updatedAt = new Date().toISOString();
  }
  finally {
    await beta.close();
    cleanupDsvBetaJobLater(job);
  }
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
