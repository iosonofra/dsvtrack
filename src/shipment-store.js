import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findDsvStatusEvent, normalizeDsvTimeline, parseDsvEventDate } from './dsv-beta-client.js';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const storePath = join(projectRoot, 'data', 'shipments.json');
let database = null;
let writeChain = Promise.resolve();

async function load() {
  if (database) return database;
  try { database = JSON.parse(await readFile(storePath, 'utf8')); }
  catch { database = { shipments: {} }; }
  database.shipments ||= {};
  let migrated = false;
  for (const record of Object.values(database.shipments)) {
    if (!Array.isArray(record.dsvTimeline)) continue;
    const normalizedTimeline = normalizeDsvTimeline(record.dsvTimeline);
    if (JSON.stringify(normalizedTimeline) !== JSON.stringify(record.dsvTimeline)) {
      record.dsvTimeline = normalizedTimeline;
      migrated = true;
    }
    const storedDate = parseDsvEventDate(record.dsvStatusDateRaw);
    if (record.dsvStatusAt || storedDate.local) continue;
    const event = findDsvStatusEvent(normalizeStoredDsvStatus(record.dsvStatus), normalizedTimeline);
    if (!event?.statusDateRaw) continue;
    record.dsvStatusAt = event.statusAt;
    record.dsvStatusDateRaw = event.statusDateRaw;
    record.dsvStatusDatePrecision = event.statusDatePrecision;
    migrated = true;
  }
  if (migrated) await persist();
  return database;
}

function now() { return new Date().toISOString(); }
function addEvent(record, type, label, detail = '') {
  const last = record.events?.at(-1);
  if (last?.type === type && last.label === label && last.detail === detail) return;
  record.events = [...(record.events || []), { at: now(), type, label, detail }].slice(-30);
}

export function normalizeStoredDsvStatus(value) {
  const normalized = String(value || '').trim().toLocaleLowerCase('it-IT');
  if (/^consegnat[oa]$|^delivered$/.test(normalized)) return 'Consegnata';
  if (/^in consegna$|^out for delivery$/.test(normalized)) return 'In consegna';
  if (/centro di distribuzione|distribution cent(?:er|re)/.test(normalized)) return 'Centro di distribuzione';
  if (/^in transito$|^in transit$/.test(normalized)) return 'In transito';
  if (/^prenotat[oa]$|^booked$/.test(normalized)) return 'Prenotata';
  return String(value || '').trim();
}

function operationalStatus(record) {
  const value = normalizeStoredDsvStatus(record.dsvStatus).toLocaleLowerCase('it-IT');
  if (/consegnat|delivered/.test(value)) return 'Consegnata';
  if (/in consegna|out for delivery/.test(value)) return 'In consegna';
  if (/centro di distribuzione/.test(value)) return 'Centro di distribuzione';
  if (/in transito|transit/.test(value)) return 'In transito';
  if (/prenotat|booked/.test(value)) return 'Prenotata';
  if (/errore beta|verificare manualmente/.test(value)) return 'Verifica incompleta';
  if (/non trovata|intervento manuale|eccezione dsv/.test(value)) return 'Da gestire';
  if (record.prestaStatus === 'Tracking già presente') return 'Tracking già presente';
  if (/errore|non trovato|ambiguo/.test(String(record.prestaStatus || '').toLocaleLowerCase('it-IT'))) return 'Da gestire';
  return 'In attesa di verifica DSV';
}

export function matchesOperationalStatus(recordStatus, requestedStatus) {
  if (!requestedStatus) return true;
  if (requestedStatus === 'Da verificare') return ['In attesa di verifica DSV', 'Verifica incompleta'].includes(recordStatus);
  return recordStatus === requestedStatus;
}

export function buildDsvStatusCounts(records) {
  return records.reduce((output, record) => {
    const status = normalizeStoredDsvStatus(record.dsvStatus) || 'Non verificato';
    output[status] = (output[status] || 0) + 1;
    return output;
  }, {});
}

export async function getExistingShipmentsIndex() {
  const db = await load();
  const byTracking = new Map();
  const byReference = new Map();
  for (const record of Object.values(db.shipments || {})) {
    if (record.trackingNumber) byTracking.set(record.trackingNumber, record);
    if (record.orderReference) byReference.set(record.orderReference, record);
  }
  return { byTracking, byReference };
}

async function persist() {
  const next = writeChain.then(async () => {
    await mkdir(dirname(storePath), { recursive: true });
    const temporaryPath = `${storePath}.${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(database), 'utf8');
    await rename(temporaryPath, storePath);
  });
  writeChain = next.catch(() => {});
  return next;
}

export async function syncVerifiedShipments(rows) {
  const db = await load();
  for (const row of rows) {
    if (!row.trackingNumber || row.alreadyImported) continue;
    const previous = db.shipments[row.trackingNumber] || { trackingNumber: row.trackingNumber, events: [] };
    const record = db.shipments[row.trackingNumber] = {
      ...previous,
      trackingNumber: row.trackingNumber,
      orderReference: row.orderReference || previous.orderReference || '',
      orderId: row.orderId || previous.orderId || '',
      orderDate: row.orderDate || previous.orderDate || '',
      prestaStateId: row.prestaStateId || previous.prestaStateId || '',
      currentState: row.currentState || previous.currentState || '—',
      prestaStatus: row.verification || row.validation || previous.prestaStatus || '',
      existingTracking: row.existingTracking || previous.existingTracking || '',
      lastSeenAt: now(),
      events: previous.events || [],
    };
    addEvent(record, 'prestashop', record.prestaStatus, record.currentState);
  }
  await persist();
}

export async function syncDsvShipments(results) {
  const db = await load();
  for (const result of results) {
    const record = db.shipments[result.trackingNumber] ||= { trackingNumber: result.trackingNumber, events: [] };
    const nextDsvStatus = normalizeStoredDsvStatus(result.status);
    const sameDsvStatus = normalizeStoredDsvStatus(record.dsvStatus) === nextDsvStatus;
    record.dsvStatus = nextDsvStatus;
    record.dsvDetail = result.detail || '';
    record.dsvRawStatus = result.rawStatus || '';
    record.dsvEvidence = result.evidence || '';
    record.dsvConfidence = Number(result.confidence) || 0;
    record.dsvReasonCode = result.reasonCode || '';
    record.dsvParserVersion = Number(result.parserVersion) || 1;
    record.dsvTrackingUrl = result.trackingUrl || record.dsvTrackingUrl || '';
    record.dsvTimeline = Array.isArray(result.timeline) ? result.timeline.slice(0, 60) : (record.dsvTimeline || []);
    record.dsvStatusAt = result.statusAt || (sameDsvStatus ? record.dsvStatusAt || '' : '');
    record.dsvStatusDateRaw = result.statusDateRaw || (sameDsvStatus ? record.dsvStatusDateRaw || '' : '');
    record.dsvStatusDatePrecision = result.statusDatePrecision || (sameDsvStatus ? record.dsvStatusDatePrecision || '' : '');
    record.dsvCheckedAt = now();
    record.lastSeenAt = now();
    addEvent(record, 'dsv', result.status, result.detail || '');
  }
  await persist();
}

export async function syncAppliedShipments(results) {
  const db = await load();
  for (const result of results) {
    if (!result.trackingNumber) continue;
    const record = db.shipments[result.trackingNumber] ||= { trackingNumber: result.trackingNumber, events: [] };
    record.lastImportResult = result.result;
    record.lastImportDetail = result.detail || '';
    record.lastImportedAt = now();
    record.lastSeenAt = now();
    if (result.result === 'Aggiornata' && result.currentState) record.currentState = result.currentState;
    addEvent(record, 'importazione', result.result, result.detail || '');
  }
  await persist();
}

export async function syncManualPrestaShopState(trackingNumber, { stateId, stateName }) {
  const db = await load();
  const record = db.shipments[trackingNumber];
  if (!record) throw new Error('Spedizione non presente nel centro di controllo.');
  record.currentState = String(stateName || '').trim() || record.currentState || '—';
  record.prestaStateId = String(stateId || '');
  record.prestaStatus = 'Stato aggiornato dal tracking center';
  record.prestaCheckedAt = now();
  record.lastSeenAt = now();
  addEvent(record, 'prestashop', 'Stato PrestaShop aggiornato', record.currentState);
  await persist();
  return { ...record, dsvStatus: normalizeStoredDsvStatus(record.dsvStatus), operationalStatus: operationalStatus(record) };
}

export async function syncShipmentPrestaShopShipping(trackingNumber, { orderId, orderReference, carrierId, carrierName, overwritten }) {
  const db = await load();
  const record = db.shipments[trackingNumber];
  if (!record) throw new Error('Spedizione non presente nel centro di controllo.');
  if (orderId && !record.orderId) record.orderId = orderId;
  if (orderReference && !record.orderReference) record.orderReference = orderReference;
  record.prestaCarrierId = carrierId ? String(carrierId) : record.prestaCarrierId;
  record.prestaCarrierName = carrierName ? String(carrierName) : record.prestaCarrierName;
  record.prestaTrackingSynced = true;
  record.prestaTrackingSyncedAt = now();
  record.lastSeenAt = now();
  const actionLabel = overwritten ? 'Tracking PrestaShop sovrascritto' : 'Tracking e corriere sincronizzati';
  const detail = [carrierName ? `Corriere: ${carrierName}` : '', carrierId ? `(ID ${carrierId})` : ''].filter(Boolean).join(' ');
  addEvent(record, 'prestashop', actionLabel, detail || 'Tracking aggiornato su PrestaShop');
  await persist();
  return { ...record, dsvStatus: normalizeStoredDsvStatus(record.dsvStatus), operationalStatus: operationalStatus(record) };
}

export async function getControlCenter({ query = '', status = '', dsvStatus = '', checkedAfter = '', exceptionOnly = false, archived = false } = {}) {
  const db = await load();
  const needle = String(query).trim().toLocaleLowerCase('it-IT');
  const isArchivedView = archived === true || archived === '1' || archived === 'true' || dsvStatus === 'Archiviate';
  const allRecords = Object.values(db.shipments).map((record) => ({
    ...record,
    archived: Boolean(record.archived),
    dsvStatus: normalizeStoredDsvStatus(record.dsvStatus),
    operationalStatus: operationalStatus(record),
  }));

  const activeRecords = allRecords.filter((record) => !record.archived);
  const archivedRecords = allRecords.filter((record) => record.archived);
  const archivedCount = archivedRecords.length;

  const targetRecords = isArchivedView ? archivedRecords : activeRecords;

  const filtered = targetRecords.filter((record) => {
    const matchesQuery = !needle || [record.trackingNumber, record.orderReference, record.orderId, record.dsvStatus].some((value) => String(value || '').toLocaleLowerCase('it-IT').includes(needle));
    const matchesStatus = matchesOperationalStatus(record.operationalStatus, status);
    const matchesDsvStatus = (!dsvStatus || dsvStatus === 'Archiviate') ? true : (record.dsvStatus || 'Non verificato') === dsvStatus;
    const matchesCheckedAfter = !checkedAfter || String(record.dsvCheckedAt || record.lastSeenAt || '') >= `${checkedAfter}T00:00:00.000Z`;
    const isException = record.operationalStatus === 'Da gestire';
    return matchesQuery && matchesStatus && matchesDsvStatus && matchesCheckedAfter && (!exceptionOnly || isException);
  }).sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)));

  const counts = activeRecords.reduce((output, record) => {
    output[record.operationalStatus] = (output[record.operationalStatus] || 0) + 1;
    return output;
  }, {});

  const dsvCounts = buildDsvStatusCounts(activeRecords);

  return {
    counts,
    dsvCounts,
    archivedCount,
    total: activeRecords.length,
    viewTotal: targetRecords.length,
    records: filtered.slice(0, 500),
  };
}

export async function getShipment(trackingNumber) {
  const db = await load();
  const record = db.shipments[trackingNumber];
  return record ? { ...record, archived: Boolean(record.archived), dsvStatus: normalizeStoredDsvStatus(record.dsvStatus), operationalStatus: operationalStatus(record) } : null;
}

export async function archiveShipment(trackingNumber, archived = true) {
  const db = await load();
  const record = db.shipments[trackingNumber];
  if (!record) throw new Error('Spedizione non presente nel centro di controllo.');
  const isArchived = Boolean(archived);
  record.archived = isArchived;
  record.archivedAt = isArchived ? now() : null;
  record.lastSeenAt = now();
  addEvent(record, 'gestione', isArchived ? 'Spedizione archiviata' : 'Spedizione ripristinata', isArchived ? 'Archiviata manualmente' : 'Ripristinata tra le spedizioni attive');
  await persist();
  return { ...record, archived: isArchived, dsvStatus: normalizeStoredDsvStatus(record.dsvStatus), operationalStatus: operationalStatus(record) };
}

export async function updateShipmentCase(trackingNumber, { note, assignee, caseStatus } = {}) {
  const db = await load();
  const record = db.shipments[trackingNumber];
  if (!record) throw new Error('Spedizione non presente nel centro di controllo.');
  const allowedStatuses = new Set(['Aperta', 'In lavorazione', 'Risolta', 'Ignorata']);
  if (note !== undefined) record.note = String(note).trim().slice(0, 2_000);
  if (assignee !== undefined) record.assignee = String(assignee).trim().slice(0, 120);
  if (caseStatus !== undefined) {
    if (!allowedStatuses.has(caseStatus)) throw new Error('Stato gestione non valido.');
    record.caseStatus = caseStatus;
  }
  record.caseUpdatedAt = now();
  record.lastSeenAt = now();
  addEvent(record, 'gestione', record.caseStatus || 'Aperta', record.assignee ? `Assegnata a ${record.assignee}` : record.note || 'Caso aggiornato');
  await persist();
  return { ...record, archived: Boolean(record.archived), dsvStatus: normalizeStoredDsvStatus(record.dsvStatus), operationalStatus: operationalStatus(record) };
}

export async function deleteShipment(trackingNumber) {
  const db = await load();
  if (db.shipments[trackingNumber]) {
    delete db.shipments[trackingNumber];
    await persist();
  }
}

export async function exportShipmentsData() {
  const db = await load();
  return {
    count: Object.keys(db.shipments || {}).length,
    shipments: db.shipments || {},
  };
}

export async function restoreShipmentsData(importedShipments) {
  if (!importedShipments || typeof importedShipments !== 'object' || Array.isArray(importedShipments)) {
    throw new Error('Dati spedizioni non validi per il ripristino.');
  }
  await load();
  try {
    const existingContent = await readFile(storePath, 'utf8');
    await writeFile(`${storePath}.bak`, existingContent, 'utf8');
  } catch {
    // Nessun backup precedente da archiviare se il file non esisteva
  }
  database = { shipments: { ...importedShipments } };
  await persist();
  return {
    restoredCount: Object.keys(database.shipments).length,
  };
}

