import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const settingsPath = join(projectRoot, 'data', 'settings.json');

export function normalizeDsvStateMappings(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.entries(value).slice(0, 100).reduce((mappings, [dsvStatus, target]) => {
    const status = String(dsvStatus || '').trim().slice(0, 160);
    const stateId = String(target?.stateId || '').trim().slice(0, 32);
    const stateName = String(target?.stateName || '').trim().slice(0, 160);
    const autoSync = Boolean(target?.autoSync);
    if (status && /^\d+$/.test(stateId) && stateName) mappings[status] = { stateId, stateName, autoSync };
    return mappings;
  }, {});
}

export function normalizeNotificationSettings(input = {}) {
  const raw = input && typeof input === 'object' ? input : {};
  const telegram = {
    enabled: Boolean(raw.telegram?.enabled),
    botToken: String(raw.telegram?.botToken || '').trim(),
    chatId: String(raw.telegram?.chatId || '').trim(),
  };

  const email = {
    enabled: Boolean(raw.email?.enabled),
    host: String(raw.email?.host || '').trim(),
    port: Math.min(Math.max(Number(raw.email?.port) || 587, 1), 65535),
    secure: Boolean(raw.email?.secure),
    user: String(raw.email?.user || '').trim(),
    pass: String(raw.email?.pass || '').trim(),
    from: String(raw.email?.from || '').trim(),
    to: String(raw.email?.to || '').trim(),
  };

  const triggers = {
    exceptions: raw.triggers?.exceptions !== undefined ? Boolean(raw.triggers?.exceptions) : true,
    sla48h: raw.triggers?.sla48h !== undefined ? Boolean(raw.triggers?.sla48h) : true,
    autoSyncSuccess: raw.triggers?.autoSyncSuccess !== undefined ? Boolean(raw.triggers?.autoSyncSuccess) : true,
    dailyDigest: raw.triggers?.dailyDigest !== undefined ? Boolean(raw.triggers?.dailyDigest) : true,
    digestHour: Math.min(Math.max(Number(raw.triggers?.digestHour ?? 8), 0), 23),
    digestMinute: Math.min(Math.max(Number(raw.triggers?.digestMinute ?? 30), 0), 59),
  };

  return { telegram, email, triggers };
}

export function normalizeCronSettings(input = {}) {
  const enabled = Boolean(input.enabled);
  const intervalMinutes = Math.min(Math.max(Number(input.intervalMinutes) || 60, 15), 1440);
  const nightPause = input.nightPause !== undefined ? Boolean(input.nightPause) : true;
  const startHour = Math.min(Math.max(Number(input.startHour) || 8, 0), 23);
  const endHour = Math.min(Math.max(Number(input.endHour) || 20, 0), 23);
  const batchSize = Math.min(Math.max(Number(input.batchSize) || 25, 1), 100);
  const minCheckIntervalHours = Math.min(Math.max(Number(input.minCheckIntervalHours) || 2, 0.5), 72);
  return { enabled, intervalMinutes, nightPause, startHour, endHour, batchSize, minCheckIntervalHours };
}

export async function loadSettings(defaults) {
  try {
    const parsed = JSON.parse(await readFile(settingsPath, 'utf8'));
    const savedTrackingUrl = parsed.dsvBeta?.trackingUrl;
    const trackingUrl = savedTrackingUrl === 'https://www.dsv.com/en-us/digital-solutions/book-track-with-connect'
      ? (defaults.dsvBeta?.trackingUrl || 'https://www.dsv.com/mydsv/tracking-public/?refNumber=TRACKINGDAINSERIRE&language_region=it-IT_IT')
      : (savedTrackingUrl || defaults.dsvBeta?.trackingUrl || 'https://www.dsv.com/mydsv/tracking-public/?refNumber=TRACKINGDAINSERIRE&language_region=it-IT_IT');
    return {
      baseUrl: parsed.baseUrl || defaults.baseUrl || '',
      apiKey: parsed.apiKey || defaults.apiKey || '',
      dsvBeta: {
        enabled: Boolean(parsed.dsvBeta?.enabled),
        camofoxUrl: parsed.dsvBeta?.camofoxUrl || defaults.dsvBeta?.camofoxUrl || 'http://127.0.0.1:9377',
        trackingUrl,
      },
      dsvStateMappings: normalizeDsvStateMappings(parsed.dsvStateMappings),
      defaultCarrierId: String(parsed.defaultCarrierId || defaults.defaultCarrierId || '').trim(),
      defaultCarrierName: String(parsed.defaultCarrierName || defaults.defaultCarrierName || '').trim(),
      cron: normalizeCronSettings(parsed.cron || defaults.cron),
      notifications: normalizeNotificationSettings(parsed.notifications || defaults.notifications),
    };
  } catch {
    return defaults;
  }
}

export async function saveSettings(settings) {
  await mkdir(dirname(settingsPath), { recursive: true });
  const temporaryPath = `${settingsPath}.tmp`;
  await writeFile(temporaryPath, JSON.stringify({
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    dsvBeta: settings.dsvBeta,
    dsvStateMappings: normalizeDsvStateMappings(settings.dsvStateMappings),
    defaultCarrierId: String(settings.defaultCarrierId || '').trim(),
    defaultCarrierName: String(settings.defaultCarrierName || '').trim(),
    cron: normalizeCronSettings(settings.cron),
    notifications: normalizeNotificationSettings(settings.notifications),
  }), 'utf8');
  await rename(temporaryPath, settingsPath);
}

export function exportSettingsData(settings) {
  if (!settings || typeof settings !== 'object') return {};
  return {
    baseUrl: settings.baseUrl || '',
    apiKey: settings.apiKey || '',
    dsvBeta: {
      enabled: Boolean(settings.dsvBeta?.enabled),
      camofoxUrl: settings.dsvBeta?.camofoxUrl || 'http://127.0.0.1:9377',
      trackingUrl: settings.dsvBeta?.trackingUrl || 'https://www.dsv.com/mydsv/tracking-public/?refNumber=TRACKINGDAINSERIRE&language_region=it-IT_IT',
    },
    dsvStateMappings: normalizeDsvStateMappings(settings.dsvStateMappings),
    defaultCarrierId: String(settings.defaultCarrierId || '').trim(),
    defaultCarrierName: String(settings.defaultCarrierName || '').trim(),
    cron: normalizeCronSettings(settings.cron),
    notifications: normalizeNotificationSettings(settings.notifications),
  };
}

export async function restoreSettingsData(importedSettings, defaults = {}) {
  if (!importedSettings || typeof importedSettings !== 'object' || Array.isArray(importedSettings)) {
    throw new Error('Dati impostazioni non validi per il ripristino.');
  }
  try {
    const existingContent = await readFile(settingsPath, 'utf8');
    await writeFile(`${settingsPath}.bak`, existingContent, 'utf8');
  } catch {
    // Nessun backup precedente se non esisteva
  }
  const merged = {
    baseUrl: importedSettings.baseUrl || defaults.baseUrl || '',
    apiKey: importedSettings.apiKey || defaults.apiKey || '',
    dsvBeta: {
      enabled: Boolean(importedSettings.dsvBeta?.enabled),
      camofoxUrl: importedSettings.dsvBeta?.camofoxUrl || defaults.dsvBeta?.camofoxUrl || 'http://127.0.0.1:9377',
      trackingUrl: importedSettings.dsvBeta?.trackingUrl || defaults.dsvBeta?.trackingUrl || 'https://www.dsv.com/mydsv/tracking-public/?refNumber=TRACKINGDAINSERIRE&language_region=it-IT_IT',
    },
    dsvStateMappings: normalizeDsvStateMappings(importedSettings.dsvStateMappings),
    defaultCarrierId: String(importedSettings.defaultCarrierId || defaults.defaultCarrierId || '').trim(),
    defaultCarrierName: String(importedSettings.defaultCarrierName || defaults.defaultCarrierName || '').trim(),
    cron: normalizeCronSettings(importedSettings.cron || defaults.cron),
    notifications: normalizeNotificationSettings(importedSettings.notifications || defaults.notifications),
  };
  await saveSettings(merged);
  return merged;
}


