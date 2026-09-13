import { normalizeStoredDsvStatus } from './shipment-store.js';

export function isWithinActiveHours(config = {}, date = new Date()) {
  if (!config.nightPause) return true;
  const hour = date.getHours();
  const start = Number(config.startHour ?? 8);
  const end = Number(config.endHour ?? 20);
  if (start <= end) {
    return hour >= start && hour <= end;
  }
  // Finestra a cavallo della mezzanotte (es. 22:00 -> 06:00)
  return hour >= start || hour <= end;
}

export function selectCronCandidates(shipments = {}, options = {}) {
  const records = Array.isArray(shipments) ? shipments : Object.values(shipments || {});
  const minIntervalMs = (Number(options.minCheckIntervalHours) || 2) * 3_600_000;
  const batchSize = Math.max(1, Number(options.batchSize) || 25);
  const now = Date.now();

  const candidates = records.filter((record) => {
    if (!record || !record.trackingNumber) return false;
    if (record.archived) return false;
    const status = normalizeStoredDsvStatus(record.dsvStatus);
    if (status === 'Consegnata') return false;

    // Se controllata di recente, salta per evitare richieste ridondanti (salvo forza manuale)
    if (!options.force && record.dsvCheckedAt) {
      const checkedTime = new Date(record.dsvCheckedAt).getTime();
      if (!Number.isNaN(checkedTime) && (now - checkedTime) < minIntervalMs) {
        return false;
      }
    }
    return true;
  });

  // Ordina: prima le spedizioni mai controllate, poi quelle controllate più tempo fa
  candidates.sort((a, b) => {
    const timeA = a.dsvCheckedAt ? new Date(a.dsvCheckedAt).getTime() : 0;
    const timeB = b.dsvCheckedAt ? new Date(b.dsvCheckedAt).getTime() : 0;
    return timeA - timeB;
  });

  return candidates.slice(0, batchSize);
}

export class DsvCronService {
  constructor({
    getSettings,
    saveSettings,
    dsvBetaClientFactory,
    loadShipments,
    syncDsvShipments,
    applyOrderState,
    syncManualState,
    notificationService,
    logger = console,
    jitterFn = () => 4000 + Math.floor(Math.random() * 2000),
  }) {
    this.getSettings = getSettings;
    this.saveSettings = saveSettings;
    this.dsvBetaClientFactory = dsvBetaClientFactory;
    this.loadShipments = loadShipments;
    this.syncDsvShipments = syncDsvShipments;
    this.applyOrderState = applyOrderState;
    this.syncManualState = syncManualState;
    this.notificationService = notificationService;
    this.logger = logger;
    this.jitterFn = jitterFn;

    this.timer = null;
    this.isRunning = false;
    this.cancelRequested = false;
    this.lastRunAt = null;
    this.nextRunAt = null;
    this.lastRunSummary = null;
    this.activeProgress = null;
    this.lastSlaCheckAt = 0;
    this.lastDigestSentDate = null;
  }

  start() {
    this.stop();
    const settings = this.getSettings();
    const config = settings?.cron;
    if (!config?.enabled) {
      this.nextRunAt = null;
      return;
    }
    const intervalMs = Math.max(15, Number(config.intervalMinutes) || 60) * 60_000;
    this.nextRunAt = new Date(Date.now() + intervalMs).toISOString();

    this.timer = setInterval(() => {
      this.triggerScan({ manual: false }).catch((error) => {
        this.logger.error('[DSV-CRON] Errore durante il ciclo automatico:', error.message);
      });
    }, intervalMs);

    this.logger.log(`[DSV-CRON] Servizio avviato: controllo ogni ${config.intervalMinutes}m. Prossimo avvio: ${this.nextRunAt}`);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async updateConfig(newConfig = {}) {
    const current = this.getSettings();
    const merged = {
      ...current,
      cron: {
        ...(current.cron || {}),
        ...newConfig,
      },
    };
    if (this.saveSettings) {
      await this.saveSettings(merged);
    }
    this.start();
    return this.getStatus();
  }

  getStatus() {
    const settings = this.getSettings();
    const config = settings?.cron || {};
    const withinHours = isWithinActiveHours(config);

    return {
      enabled: Boolean(config.enabled),
      intervalMinutes: Number(config.intervalMinutes) || 60,
      nightPause: Boolean(config.nightPause),
      startHour: Number(config.startHour ?? 8),
      endHour: Number(config.endHour ?? 20),
      batchSize: Number(config.batchSize) || 25,
      minCheckIntervalHours: Number(config.minCheckIntervalHours) || 2,
      isRunning: this.isRunning,
      isNightPaused: Boolean(config.enabled && config.nightPause && !withinHours),
      lastRunAt: this.lastRunAt,
      nextRunAt: this.timer ? this.nextRunAt : null,
      lastRunSummary: this.lastRunSummary,
      activeProgress: this.activeProgress,
    };
  }

  stopScan() {
    if (this.isRunning) {
      this.cancelRequested = true;
      return { ok: true, message: 'Richiesta di interruzione inviata.' };
    }
    return { ok: false, message: 'Nessuna scansione in esecuzione.' };
  }

  async triggerScan({ manual = false } = {}) {
    if (this.isRunning) {
      throw new Error('Un ciclo di controllo delle spedizioni è già in corso.');
    }

    const settings = this.getSettings();
    const config = settings?.cron || {};
    const dsvBetaConfig = settings?.dsvBeta;

    // Se non manuale, verifica se abilitato e nella fascia oraria
    if (!manual) {
      if (!config.enabled) return;
      if (!isWithinActiveHours(config)) {
        this.lastRunSummary = {
          at: new Date().toISOString(),
          type: 'skipped',
          reason: `Pausa notturna attiva (orario attivo: ${config.startHour}:00 - ${config.endHour}:00)`,
        };
        // Ricalcola il prossimo orario
        const intervalMs = Math.max(15, Number(config.intervalMinutes) || 60) * 60_000;
        this.nextRunAt = new Date(Date.now() + intervalMs).toISOString();
        return;
      }
    }

    if (!dsvBetaConfig?.enabled) {
      throw new Error('La funzionalità DSV Beta deve essere abilitata nelle impostazioni per usare Camofox.');
    }

    this.isRunning = true;
    this.cancelRequested = false;
    const startTime = Date.now();

    try {
      const db = await this.loadShipments();
      const candidates = selectCronCandidates(db?.shipments || {}, {
        ...config,
        force: manual,
      });

      if (!candidates.length) {
        this.lastRunAt = new Date().toISOString();
        this.lastRunSummary = {
          at: this.lastRunAt,
          type: 'complete',
          totalCandidates: 0,
          checked: 0,
          deliveredFound: 0,
          errors: 0,
          durationSeconds: 0,
          reason: 'Nessuna spedizione in attesa da verificare',
        };
        return this.lastRunSummary;
      }

      this.activeProgress = {
        completed: 0,
        total: candidates.length,
        currentTracking: candidates[0].trackingNumber,
      };

      const betaClient = this.dsvBetaClientFactory(dsvBetaConfig);
      const results = [];
      let deliveredCount = 0;
      let errorCount = 0;

      for (let i = 0; i < candidates.length; i++) {
        if (this.cancelRequested) {
          this.logger.log('[DSV-CRON] Scansione interrotta dall\'operatore.');
          break;
        }

        const candidate = candidates[i];
        this.activeProgress.currentTracking = candidate.trackingNumber;

        try {
          const outcome = await betaClient.track(candidate.trackingNumber);
          results.push({ trackingNumber: candidate.trackingNumber, ...outcome });

          if (outcome.status === 'Consegnata') {
            deliveredCount++;
          }

          // Se compare captcha o blocco di accesso, effettua reset sessione e pausa prolungata
          if (outcome.reasonCode === 'ACCESS_GUARD' || outcome.status === 'Intervento manuale richiesto') {
            betaClient.resetSession();
            await new Promise((r) => setTimeout(r, 8000));
          }
        } catch (error) {
          errorCount++;
          results.push({
            trackingNumber: candidate.trackingNumber,
            status: 'Errore beta',
            detail: error.message,
          });
          betaClient.resetSession();
        }

        // Sincronizza subito la spedizione nel database locale in modo progressivo
        if (results.length) {
          const latestOutcome = results[results.length - 1];
          await this.syncDsvShipments([latestOutcome]);

          // 1. Auto-allineamento PrestaShop se abilitato per lo stato DSV
          const mapping = settings?.dsvStateMappings?.[latestOutcome.status];
          if (mapping?.autoSync && mapping.stateId && candidate.orderId && this.applyOrderState && this.syncManualState) {
            const currentNormalized = (candidate.currentState || '').trim().toLowerCase();
            const targetNormalized = (mapping.stateName || '').trim().toLowerCase();
            const sameId = candidate.prestaStateId && String(candidate.prestaStateId) === String(mapping.stateId);
            const sameName = currentNormalized && currentNormalized === targetNormalized;

            if (!sameId && !sameName) {
              try {
                await this.applyOrderState({ orderId: candidate.orderId, stateId: mapping.stateId });
                await this.syncManualState({
                  trackingNumber: candidate.trackingNumber,
                  orderId: candidate.orderId,
                  prestaStateId: String(mapping.stateId),
                  stateName: mapping.stateName,
                  origin: 'cron-auto-sync',
                });
                this.logger.log(`[DSV-CRON] Auto-allineato ordine ${candidate.orderId} allo stato "${mapping.stateName}"`);
                if (this.notificationService) {
                  await this.notificationService.notifyAutoSyncSuccess(candidate, mapping.stateName).catch(() => {});
                }
              } catch (syncErr) {
                this.logger.error(`[DSV-CRON] Errore auto-allineamento ordine ${candidate.orderId}:`, syncErr.message);
              }
            }
          }

          // 2. Alert per Eccezioni e Blocchi
          const isExceptionStatus = latestOutcome.status === 'Eccezione DSV' ||
            latestOutcome.status === 'Intervento manuale richiesto' ||
            Boolean(latestOutcome.reasonCode) ||
            /giacenza|fallit|mancat|rifiut/i.test(latestOutcome.status || '') ||
            /giacenza|fallit|mancat|rifiut/i.test(latestOutcome.detail || '');

          if (isExceptionStatus && this.notificationService) {
            await this.notificationService.notifyException(candidate, latestOutcome).catch(() => {});
          }
        }

        this.activeProgress.completed = i + 1;

        // Pacing anti-blocco tra le richieste se ce ne sono altre
        if (i < candidates.length - 1 && !this.cancelRequested) {
          await new Promise((resolve) => setTimeout(resolve, this.jitterFn()));
        }
      }

      // 3. Controllo SLA > 48h e Daily Digest a fine scansione
      if (this.notificationService) {
        await this.checkSlaBreaches().catch((err) => {
          this.logger.error('[DSV-CRON] Errore verifica SLA:', err.message);
        });
        await this.checkDailyDigest().catch((err) => {
          this.logger.error('[DSV-CRON] Errore verifica daily digest:', err.message);
        });
      }

      this.lastRunAt = new Date().toISOString();
      const durationSeconds = Math.round((Date.now() - startTime) / 1000);
      this.lastRunSummary = {
        at: this.lastRunAt,
        type: this.cancelRequested ? 'cancelled' : 'complete',
        totalCandidates: candidates.length,
        checked: this.activeProgress.completed,
        deliveredFound: deliveredCount,
        errors: errorCount,
        durationSeconds,
      };

      return this.lastRunSummary;
    } finally {
      this.isRunning = false;
      this.cancelRequested = false;
      this.activeProgress = null;

      // Ricalcola il prossimo orario se il timer è attivo
      if (this.timer && config?.enabled) {
        const intervalMs = Math.max(15, Number(config.intervalMinutes) || 60) * 60_000;
        this.nextRunAt = new Date(Date.now() + intervalMs).toISOString();
      }
    }
  }

  async checkSlaBreaches() {
    const settings = this.getSettings();
    if (!settings?.notifications?.triggers?.sla48h || !this.notificationService) return;

    const now = Date.now();
    // Evita di ripetere l'alert SLA più di una volta ogni 24 ore
    if (this.lastSlaCheckAt && (now - this.lastSlaCheckAt) < 24 * 3600_000) return;

    const db = await this.loadShipments();
    const records = Object.values(db?.shipments || {});
    const thresholdMs = 48 * 3600_000;

    const delayed = records.filter((r) => {
      if (!r || r.archived || r.dsvStatus === 'Consegnata') return false;
      const refTime = r.dsvCheckedAt ? new Date(r.dsvCheckedAt).getTime() : new Date(r.createdAt || 0).getTime();
      return (now - refTime) > thresholdMs;
    });

    if (delayed.length) {
      this.lastSlaCheckAt = now;
      await this.notificationService.notifySlaBreach(delayed);
    }
  }

  async checkDailyDigest() {
    const settings = this.getSettings();
    const triggers = settings?.notifications?.triggers;
    if (!triggers?.dailyDigest || !this.notificationService) return;

    const now = new Date();
    const targetHour = Number(triggers.digestHour ?? 8);
    const targetMinute = Number(triggers.digestMinute ?? 30);
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();

    // Invia se siamo all'interno o oltre la finestra oraria del digest
    const isDigestTime = (currentHour === targetHour && currentMinute >= targetMinute) || (currentHour > targetHour);
    const todayKey = now.toISOString().slice(0, 10);

    if (isDigestTime && this.lastDigestSentDate !== todayKey) {
      const db = await this.loadShipments();
      const records = Object.values(db?.shipments || {});
      const totalActive = records.filter((r) => !r.archived && r.dsvStatus !== 'Consegnata').length;
      const deliveredToday = records.filter((r) => r.dsvStatus === 'Consegnata' && r.dsvCheckedAt && r.dsvCheckedAt.slice(0, 10) === todayKey).length;
      const exceptions = records.filter((r) => !r.archived && (r.dsvStatus === 'Eccezione DSV' || r.caseStatus === 'Aperta')).length;
      const thresholdMs = 48 * 3600_000;
      const delayed = records.filter((r) => !r.archived && r.dsvStatus !== 'Consegnata' && (now.getTime() - new Date(r.dsvCheckedAt || r.createdAt || 0).getTime()) > thresholdMs).length;

      this.lastDigestSentDate = todayKey;
      await this.notificationService.sendDailyDigest({
        totalActive,
        deliveredToday,
        exceptions,
        delayed,
      });
    }
  }
}
