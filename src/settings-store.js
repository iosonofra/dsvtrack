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
    if (status && /^\d+$/.test(stateId) && stateName) mappings[status] = { stateId, stateName };
    return mappings;
  }, {});
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
  };
  await saveSettings(merged);
  return merged;
}


