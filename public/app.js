const $ = (selector) => document.querySelector(selector);
const tell = (selector, message, kind = '') => { const el = $(selector); el.textContent = message; el.className = `message ${kind}`; };
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
let previewRows = [];
let verificationId = '';
let dsvBetaSettings = null;
let importApplied = false;
let activeView = 'control';
let controlSelectedTrackingNumbers = new Set();
let lastControlSelectedTrackingNumber = '';
let controlRecords = [];
let controlPage = 1;
let controlMetricFilter = 'all';
let controlPrestaStateFilter = '';
const PRESTA_UNLINKED_FILTER = '__unlinked__';
const PRESTA_UNAVAILABLE_FILTER = '__unavailable__';
const CONTROL_PAGE_SIZE = 50;
let controlOverview = { records: [], total: 0, counts: {} };
let activeControlTrackingNumber = '';
let controlDetailTrigger = null;
let controlDetailRequestToken = 0;
let shipmentDetailDirty = false;
let prestaShopStateCatalog = null;
let prestaShopCarrierCatalog = null;
let prestaShopStateTracking = '';
let prestaShopLinkTracking = '';
let prestaShopLinkCandidate = null;
let dsvStateMappings = {};
let lastVerificationReport = null;
let activeReportFilter = 'all';
let reportSearchQuery = '';
let bulkTrackingRunning = false;
let bulkTrackingRetryRows = [];
let bulkTrackingPreviewFilter = 'all';
let bulkTrackingExcluded = new Set();
let activeControlDsvJobId = '';
const CONTROL_DSV_JOB_STORAGE_KEY = 'dsv-active-verification';
const DSV_SPEED_LABELS = { safe: 'Affidabile', fast: 'Rapida', ultra: 'Ultra' };
const DSV_SPEED_SETTINGS_LABELS = { safe: 'Affidabile', fast: 'Rapido controllato', ultra: 'Ultra' };
const dsvSpeedLabel = (profile, settings = false) => (settings ? DSV_SPEED_SETTINGS_LABELS : DSV_SPEED_LABELS)[profile] || 'Affidabile';

async function request(url, options) { const r = await fetch(url, options); const data = await r.json(); if (!r.ok) throw new Error(data.error); return data; }
async function initialConfig() { const config = await request('/api/config'); $('#base-url').value = config.baseUrl; }
function displayDate(value) { return value ? escapeHtml(value.replace(/^([0-9]{4})-([0-9]{2})-([0-9]{2})/, '$3/$2/$1')) : '—'; }
function parseFlexibleDate(value) {
  if (!value) return null;
  const text = String(value).trim();
  const italian = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[,\s]+(\d{1,2}):(\d{2}))?/);
  if (italian) {
    const parsed = new Date(Number(italian[3]), Number(italian[2]) - 1, Number(italian[1]), Number(italian[4] || 0), Number(italian[5] || 0));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
function displayDateTime(value) {
  if (!value) return '—';
  const parsed = parseFlexibleDate(value);
  return parsed ? escapeHtml(parsed.toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' })) : escapeHtml(value);
}
function dateTimeAttribute(value) {
  const parsed = parseFlexibleDate(value);
  return parsed ? ` datetime="${parsed.toISOString()}"` : '';
}
function relativeAge(value) {
  const parsed = parseFlexibleDate(value);
  if (!parsed) return '';
  const minutes = Math.max(0, Math.floor((Date.now() - parsed.getTime()) / 60000));
  if (minutes < 2) return 'ora';
  if (minutes < 60) return `${minutes} min fa`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'ora' : 'ore'} fa`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'giorno' : 'giorni'} fa`;
}
function elapsedLabel(newerValue, olderValue) {
  const newer = parseFlexibleDate(newerValue);
  const older = parseFlexibleDate(olderValue);
  if (!newer || !older || newer <= older) return '';
  const minutes = Math.floor((newer - older) / 60000);
  if (minutes < 60) return `${minutes} min dopo`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'ora' : 'ore'} dopo`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'giorno' : 'giorni'} dopo`;
}
function displayDsvEventDate(row) {
  const value = String(row?.dsvStatusAt || '');
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
  if (match) return escapeHtml(`${match[3]}/${match[2]}/${match[1]}${match[4] ? ` · ${match[4]}:${match[5]}` : ''}`);
  return escapeHtml(row?.dsvStatusDatePrecision === 'raw' ? 'Data evento non riconosciuta' : 'Data evento non disponibile');
}
function selectedRows() { return previewRows.filter((row) => row.canApply && row.selected); }
function stateBadge(value) {
  const label = escapeHtml(value || '—');
  const normalized = String(value || '').toLocaleLowerCase('it-IT');
  if (normalized.includes('preparazione in corso')) return `<span class="status-badge preparing">${label}</span>`;
  if (normalized.includes('spedito')) return `<span class="status-badge shipped">${label}</span>`;
  return `<span class="status-badge">${label}</span>`;
}

function copyableValue(value, label = 'Valore', extraClass = '') {
  if (!value || value === '—') return '—';
  const safeVal = escapeHtml(value);
  const safeLabel = escapeHtml(label);
  return `<button type="button" class="copyable-btn ${extraClass}" data-copy="${safeVal}" data-copy-label="${safeLabel}" title="Clicca per copiare ${safeLabel}: ${safeVal}" aria-label="Copia ${safeLabel}: ${safeVal}"><span class="copyable-text">${safeVal}</span><span class="copyable-icon-wrap" aria-hidden="true"><svg class="copy-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="8.5" height="8.5" rx="1.5"/><path d="M11 5V2.5A1.5 1.5 0 0 0 9.5 1h-7A1.5 1.5 0 0 0 1 2.5v7A1.5 1.5 0 0 0 2.5 11H5"/></svg><svg class="check-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3.5 3.5 6-7"/></svg></span></button>`;
}

let copyConfirmTimeout = null;

function showCopyConfirmPopup(anchorEl, text, label) {
  let popup = document.getElementById('copy-confirm-popup');
  if (!popup) {
    popup = document.createElement('div');
    popup.id = 'copy-confirm-popup';
    popup.className = 'copy-confirm-popup';
    popup.setAttribute('role', 'status');
    popup.setAttribute('aria-live', 'polite');
  }

  const activeDialog = anchorEl.closest('dialog[open]');
  const targetParent = activeDialog || document.body;
  if (popup.parentElement !== targetParent) {
    targetParent.appendChild(popup);
  }

  const shortText = text.length > 28 ? text.slice(0, 26) + '…' : text;

  popup.innerHTML = `
    <div class="copy-confirm-inner">
      <span class="copy-confirm-icon-wrap" aria-hidden="true">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3.5 8.5l3.5 3.5 6-7"/>
        </svg>
      </span>
      <div class="copy-confirm-content">
        <strong class="copy-confirm-title">Copiato negli appunti!</strong>
        <span class="copy-confirm-val">${escapeHtml(shortText)}</span>
      </div>
    </div>
    <span class="copy-confirm-notch" aria-hidden="true"></span>
  `;

  popup.classList.remove('visible', 'notch-top', 'notch-bottom');
  popup.style.left = '-9999px';
  popup.style.top = '-9999px';
  popup.style.display = 'block';

  const popupRect = popup.getBoundingClientRect();
  const popupWidth = popupRect.width || 180;
  const popupHeight = popupRect.height || 44;

  const anchorRect = anchorEl.getBoundingClientRect();
  let left = anchorRect.left + (anchorRect.width / 2) - (popupWidth / 2);
  left = Math.max(10, Math.min(left, window.innerWidth - popupWidth - 10));

  const notchX = Math.max(14, Math.min(anchorRect.left + (anchorRect.width / 2) - left, popupWidth - 14));
  popup.style.setProperty('--notch-x', `${notchX}px`);

  let top = anchorRect.top - popupHeight - 7;
  let isAbove = true;

  if (activeDialog) {
    const dialogRect = activeDialog.getBoundingClientRect();
    if (top < dialogRect.top + 50) {
      top = anchorRect.bottom + 7;
      isAbove = false;
    }
  } else if (top < 10) {
    top = anchorRect.bottom + 7;
    isAbove = false;
  }

  popup.classList.add(isAbove ? 'notch-bottom' : 'notch-top');
  popup.style.left = `${Math.round(left)}px`;
  popup.style.top = `${Math.round(top)}px`;

  void popup.offsetWidth;
  popup.classList.add('visible');

  clearTimeout(copyConfirmTimeout);
  copyConfirmTimeout = setTimeout(() => {
    popup.classList.remove('visible');
  }, 1800);
}

async function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Prosegui al fallback
    }
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand('copy');
    textarea.remove();
    return ok;
  } catch {
    return false;
  }
}

let currentPreviewTab = 'ready';
let currentVerificationJobId = null;

function getFilteredPreviewRows(sourceList = previewRows) {
  if (!sourceList || !sourceList.length) return [];
  if (currentPreviewTab === 'ready') {
    return sourceList.filter((r) => r.canApply || r.verification === 'Pronta per aggiornamento' || r.verification === 'In verifica…');
  }
  if (currentPreviewTab === 'skipped') {
    return sourceList.filter((r) => r.alreadyImported || (r.verification && (r.verification.includes('già presente') || r.verification.includes('saltata') || r.verification.includes('Già importata'))));
  }
  if (currentPreviewTab === 'invalid') {
    return sourceList.filter((r) => !r.canApply && !r.alreadyImported && r.verification !== 'In verifica…' && (!r.verification || (!r.verification.includes('già presente') && !r.verification.includes('saltata') && !r.verification.includes('Già importata'))));
  }
  return sourceList;
}

function updatePreviewTabCounts() {
  const ready = previewRows.filter((r) => r.canApply || r.verification === 'Pronta per aggiornamento' || r.verification === 'In verifica…').length;
  const skipped = previewRows.filter((r) => r.alreadyImported || (r.verification && (r.verification.includes('già presente') || r.verification.includes('saltata') || r.verification.includes('Già importata')))).length;
  const invalid = previewRows.filter((r) => !r.canApply && !r.alreadyImported && r.verification !== 'In verifica…' && (!r.verification || (!r.verification.includes('già presente') && !r.verification.includes('saltata') && !r.verification.includes('Già importata')))).length;
  const total = previewRows.length;

  if ($('#tab-count-ready')) $('#tab-count-ready').textContent = ready;
  if ($('#tab-count-all')) $('#tab-count-all').textContent = total;
  if ($('#tab-count-skipped')) $('#tab-count-skipped').textContent = skipped;
  if ($('#tab-count-invalid')) $('#tab-count-invalid').textContent = invalid;

  document.querySelectorAll('.import-tab-pill').forEach((pill) => {
    pill.classList.toggle('active', pill.dataset.previewFilter === currentPreviewTab);
  });
}

function renderRows(rows, state = 'verification') {
  updatePreviewTabCounts();
  const displayRows = getFilteredPreviewRows(rows || previewRows);
  const tbody = $('#preview tbody');
  if (!tbody) return;
  if (!displayRows.length) {
    const tabLabels = { ready: 'pronte per aggiornamento', skipped: 'già presenti o saltate', invalid: 'da controllare o con errori', all: 'disponibili' };
    tbody.innerHTML = `<tr><td colspan="8" class="control-empty" style="text-align:center;padding:24px;">Nessuna riga nella scheda "${tabLabels[currentPreviewTab] || currentPreviewTab}".</td></tr>`;
    return;
  }
  tbody.innerHTML = displayRows.map((row) => {
    const originalValue = state === 'verification' ? (row.verification || row.validation) : row.validation;
    const value = row.applyResult || originalValue;
    const detail = row.applyResult ? ` — ${escapeHtml(row.applyDetail || '')}` : row.existingTracking ? ` — già presente: ${escapeHtml(row.existingTracking)}` : '';
    const isVerifying = !row.applyResult && originalValue === 'In verifica…';
    const level = row.applyResult === 'Aggiornata' ? 'applied-ok' : row.applyResult === 'Errore' ? 'applied-error' : (row.canApply || originalValue === 'Pronta per la verifica' || originalValue === 'Pronta per aggiornamento') ? 'ok' : (originalValue.includes('già presente') || originalValue.includes('saltata') || originalValue.includes('Già importata')) ? 'notice' : isVerifying ? 'verifying' : 'warning';
    const checkbox = row.canApply && !importApplied ? `<input class="row-select" data-row="${row.sourceRow}" type="checkbox" ${row.selected ? 'checked' : ''} aria-label="Includi riga ${row.sourceRow}">` : '—';
    const dsvStatus = row.dsvBetaStatus ? `<span class="dsv-status">${escapeHtml(row.dsvBetaStatus)}</span>` : '—';
    const resultCell = isVerifying
      ? '<span class="row-verifying-badge"><span class="row-verifying-spinner"></span> In verifica…</span>'
      : `${escapeHtml(value)}${detail}`;
    return `<tr><td>${checkbox}</td><td>${row.sourceRow}</td><td>${copyableValue(row.orderReference, 'Riferimento ordine', 'order-val')}</td><td>${displayDate(row.orderDate)}</td><td>${stateBadge(row.currentState)}</td><td>${copyableValue(row.trackingNumber, 'Numero spedizione', 'tracking-val')}</td><td>${dsvStatus}</td><td class="${level}">${resultCell}</td></tr>`;
  }).join('');
}

function updateSelectionUi() {
  const readyRows = previewRows.filter((row) => row.canApply);
  const total = readyRows.length;
  const selected = selectedRows().length;

  if ($('#selected-count')) {
    $('#selected-count').textContent = `${selected} di ${total} selezionate`;
    $('#selected-count').hidden = !verificationId || importApplied;
  }
  if ($('#select-all')) $('#select-all').hidden = !verificationId || importApplied;
  if ($('#clear-selection')) $('#clear-selection').hidden = !verificationId || importApplied;
  if ($('#toggle-all')) {
    $('#toggle-all').hidden = !verificationId || importApplied;
    $('#toggle-all').checked = total > 0 && selected === total;
    $('#toggle-all').indeterminate = selected > 0 && selected < total;
  }
  if ($('#apply-import')) {
    $('#apply-import').disabled = selected === 0 || importApplied;
  }
  if (dsvBetaSettings?.enabled && verificationId && $('#verify-dsv-beta')) {
    $('#verify-dsv-beta').hidden = selected === 0;
  }
}

function showApplyFeedback(summary) {
  const updated = Number(summary.Aggiornata || 0);
  const failed = Number(summary.Errore || 0);
  const skipped = Number(summary.Saltata || 0);
  const card = $('#apply-feedback');
  card.hidden = false;
  card.innerHTML = `<div class="apply-feedback-heading"><div><h3>${failed ? 'Aggiornamento completato con avvisi' : 'Aggiornamento completato'}</h3><p>Gli esiti sono riportati anche riga per riga nella colonna “Esito”.</p></div><span class="apply-check">${failed ? '!' : '✓'}</span></div><div class="apply-metrics"><div class="apply-metric success"><strong>${updated}</strong><span>Aggiornate</span></div><div class="apply-metric error"><strong>${failed}</strong><span>Con errori</span></div><div class="apply-metric skipped"><strong>${skipped}</strong><span>Saltate</span></div></div>`;
}

function updateProgress(progress) {
  const percentage = progress.total ? Math.round((progress.completed / progress.total) * 100) : 100;
  $('#verify-progress').hidden = false;
  $('#verify-progress-bar').style.width = `${percentage}%`;
  $('#verify-progress-text').textContent = `${percentage}% · ${progress.completed}/${progress.total} ordini`;
}

function ensureApplyProgress() {
  if ($('#apply-progress')) return;
  $('#apply-feedback').insertAdjacentHTML('beforebegin', '<div id="apply-progress" class="progress apply-progress" hidden><div class="progress-heading"><strong>Aggiornamento PrestaShop</strong><span id="apply-progress-text">0%</span></div><div class="progress-track"><div id="apply-progress-bar" class="progress-bar"></div></div><p id="apply-progress-status" class="progress-status">Preparazione…</p></div>');
}

function updateApplyProgress(progress) {
  ensureApplyProgress();
  const percentage = progress.total ? Math.round((progress.completed / progress.total) * 100) : 100;
  $('#apply-progress').hidden = false;
  $('#apply-progress-bar').style.width = `${percentage}%`;
  $('#apply-progress-text').textContent = `${percentage}% · ${progress.completed}/${progress.total} ordini`;
  $('#apply-progress-status').textContent = progress.completed === progress.total ? 'Aggiornamento completato. Elaborazione del riscontro finale…' : `Aggiornamento in corso: ${progress.completed} di ${progress.total} ordini elaborati.`;
}

async function waitForApply(jobId) {
  const snapshot = await request(`/api/import/apply-jobs/${jobId}`);
  updateApplyProgress(snapshot.progress);
  if (snapshot.status === 'running') { await new Promise((resolve) => setTimeout(resolve, 650)); return waitForApply(jobId); }
  if (snapshot.status === 'failed') throw new Error(snapshot.error || 'L’aggiornamento non è riuscito.');
  return snapshot.result;
}

async function waitForVerification(jobId) {
  const snapshot = await request(`/api/import/verification-jobs/${jobId}`);
  updateProgress(snapshot.progress);
  if (snapshot.status === 'running') { await new Promise((resolve) => setTimeout(resolve, 700)); return waitForVerification(jobId); }
  if (snapshot.status === 'failed') throw new Error(snapshot.error || 'La verifica non è riuscita.');
  return snapshot.result;
}

function updateDsvProgress(progress) {
  const percentage = progress.total ? Math.round((progress.completed / progress.total) * 100) : 100;
  $('#dsv-progress').hidden = false;
  $('#dsv-progress-bar').style.width = `${percentage}%`;
  $('#dsv-progress-text').textContent = `${percentage}% · ${progress.completed}/${progress.total} spedizioni`;
}

async function waitForDsvBeta(jobId) {
  const snapshot = await request(`/api/dsv-beta/jobs/${jobId}`);
  updateDsvProgress(snapshot.progress);
  if (snapshot.status === 'queued' || snapshot.status === 'running') { await new Promise((resolve) => setTimeout(resolve, 750)); return waitForDsvBeta(jobId); }
  if (snapshot.status === 'failed') throw new Error(snapshot.error || 'La verifica DSV beta non è riuscita.');
  return snapshot.result;
}

async function loadDsvBeta() {
  dsvBetaSettings = await request('/api/dsv-beta/config');
  $('#dsv-beta-enabled').checked = dsvBetaSettings.enabled;
  $('#dsv-camofox-url').value = dsvBetaSettings.camofoxUrl;
  $('#dsv-tracking-url').value = dsvBetaSettings.trackingUrl;
  const speedProfile = ['safe', 'fast', 'ultra'].includes(dsvBetaSettings.speedProfile) ? dsvBetaSettings.speedProfile : 'safe';
  const speedInput = document.querySelector(`input[name="dsv-speed-profile"][value="${speedProfile}"]`);
  if (speedInput) speedInput.checked = true;
  updateControlServiceStatus();
  updateControlSelectionUi([...document.querySelectorAll('.control-row-select')].map((input) => ({ trackingNumber: input.dataset.tracking })));
}

function updateControlServiceStatus() {
  const status = $('#control-service-status');
  if (!status) return;
  const enabled = Boolean(dsvBetaSettings?.enabled);
  status.dataset.state = enabled ? 'ready' : 'off';
  const speedLabel = `modalità ${dsvSpeedLabel(dsvBetaSettings?.speedProfile).toLocaleLowerCase('it-IT')}`;
  status.textContent = enabled ? `DSV tracking attivo · ${speedLabel}` : 'DSV tracking non attivo';
}

function controlBadge(status) {
  const kind = status === 'Da gestire' ? 'attention' : status === 'Verifica incompleta' ? 'incomplete' : status === 'Consegnata' ? 'delivered' : ['Centro di distribuzione', 'In transito', 'In consegna'].includes(status) ? 'transit' : status === 'Prenotata' ? 'booked' : 'neutral';
  return `<span class="control-status ${kind}"><span class="status-dot" aria-hidden="true"></span>${escapeHtml(status || 'Non classificato')}</span>`;
}

function dsvBadge(status) {
  const label = status || 'Non verificato';
  const normalized = label.toLocaleLowerCase('it-IT');
  const kind = /consegna riprogrammata|consegna rifiutata|tentativo non riuscito|in attesa del destinatario|ritardo operativo|reso al mittente|intervento|eccezione/.test(normalized) ? 'attention' : normalized.includes('errore') || normalized.includes('verificare manualmente') ? 'incomplete' : normalized.includes('non trovato') ? 'warning' : normalized === 'non verificato' ? 'pending' : normalized.includes('consegnat') ? 'delivered' : /in transito|in consegna|centro di distribuzione/.test(normalized) ? 'transit' : normalized.includes('prenotat') ? 'booked' : 'unmapped';
  return `<span class="dsv-result ${kind}">${escapeHtml(label)}</span>`;
}

function prestaShopBadge(status) {
  const label = status || 'Non disponibile';
  const normalized = label.toLocaleLowerCase('it-IT');
  const kind = /consegnat|delivered/.test(normalized) ? 'delivered' : /spedit|transit|consegna/.test(normalized) ? 'transit' : /prepar|pagament|prenot/.test(normalized) ? 'booked' : 'neutral';
  return `<span class="prestashop-status ${kind}">${escapeHtml(label)}</span>`;
}

function suggestedPrestaShopStateId(dsvStatus, states) {
  const patterns = {
    Consegnata: /consegnat|delivered/i,
    'In consegna': /in consegna|out for delivery/i,
    'In transito': /spedit|in transito|shipped/i,
    'Centro di distribuzione': /spedit|in transito|shipped/i,
    Prenotata: /prepar|pagamento accettato|processing/i,
  };
  const pattern = patterns[dsvStatus];
  return pattern ? states.find((state) => pattern.test(state.name || ''))?.id || '' : '';
}

function normalizedStateLabel(value) {
  return String(value || '').trim().toLocaleLowerCase('it-IT').replace(/\s+/g, ' ');
}

function mappedPrestaShopState(row) {
  return dsvStateMappings[row.dsvStatus] || null;
}

function isPrestaShopStateAligned(row) {
  const mapped = mappedPrestaShopState(row);
  if (!mapped) return false;
  if (row.prestaStateId && String(row.prestaStateId) === String(mapped.stateId)) return true;
  return normalizedStateLabel(row.currentState) === normalizedStateLabel(mapped.stateName);
}

function prestaShopStateAction(row) {
  if (row.archived) return '<span class="state-unavailable">Archiviata</span>';
  if (isPrestaShopStateAligned(row)) return '<span class="state-aligned">Allineato</span>';
  if (!row.orderId) return `<button class="link-prestashop-order update-prestashop-state" data-tracking="${escapeHtml(row.trackingNumber)}" type="button" aria-label="Collega un ordine PrestaShop alla spedizione ${escapeHtml(row.trackingNumber)}">Collega ordine</button>`;
  const mapped = mappedPrestaShopState(row);
  if (!mapped) return '<span class="state-unavailable mapping-missing">Non mappato</span>';
  return `<button class="update-prestashop-state" data-tracking="${escapeHtml(row.trackingNumber)}" type="button" aria-label="Aggiorna PrestaShop per ${escapeHtml(row.trackingNumber)}">Aggiorna</button>`;
}

function normalizedDsvJourneyStage(value) {
  const status = normalizedStateLabel(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (/non consegnat|undeliver/.test(status)) return 'tentativo di consegna';
  if (/terminal.*mittente|mittente.*terminal/.test(status)) return 'presa in carico';
  if (/consegnat|delivered/.test(status)) return 'consegnata';
  if (/fuori per la consegna|in consegna|out for delivery/.test(status)) return 'in consegna';
  if (/centro di distribuzione|terminal|distribution cent/.test(status)) return 'centro di distribuzione';
  if (/in transito|partito|arrivato|transit|departed|arrived/.test(status)) return 'in transito';
  if (/prenotat|booked/.test(status)) return 'prenotata';
  return '';
}

function shipmentDetailTimeline(shipment) {
  const timeline = Array.isArray(shipment.dsvTimeline) ? shipment.dsvTimeline.map((event) => ({ ...event })) : [];
  const currentStage = normalizedDsvJourneyStage(shipment.dsvStatus);
  if (!currentStage || timeline.some((event) => normalizedDsvJourneyStage(event.event) === currentStage)) return timeline;

  timeline.push({
    event: shipment.dsvStatus,
    date: shipment.dsvStatusAt ? displayDsvEventDate(shipment) : 'Data evento non disponibile',
    country: '',
    location: '',
    reason: shipment.dsvStatusAt
      ? 'Stato corrente rilevato dal riepilogo DSV.'
      : `Stato corrente rilevato dal riepilogo DSV il ${displayDateTime(shipment.dsvCheckedAt || shipment.lastSeenAt)}. La data dell’evento non è esposta da DSV.`,
    currentSummary: true,
  });
  return timeline;
}

function renderShipmentDsvTimeline(timeline, trackingUrl) {
  if (!timeline.length) {
    return `<section class="dsv-history dsv-history-empty"><div><strong>Storico DSV non ancora acquisito</strong><span>Ripeti la verifica per importare gli eventi disponibili.</span></div><a href="${escapeHtml(trackingUrl)}" target="_blank" rel="noopener noreferrer">Consulta su DSV</a></section>`;
  }

  const summaryCount = timeline.filter((event) => event.currentSummary).length;
  const countLabel = `${timeline.length} ${timeline.length === 1 ? 'evento' : 'eventi'}${summaryCount ? ' · stato corrente incluso' : ''}`;
  const ordered = timeline.slice().reverse();
  const rows = ordered.map((event, index) => {
    const eventText = `${event.event || ''} ${event.reason || ''}`.toLocaleLowerCase('it-IT');
    const isException = /non consegn|non caricat|eccezione|ritard|rifiut|mancanza|errore|capacità/.test(eventText);
    const classes = [event.currentSummary ? 'current-summary' : '', isException ? 'exception-event' : ''].filter(Boolean).join(' ');
    const elapsed = elapsedLabel(event.date, ordered[index + 1]?.date);
    return `<li${classes ? ` class="${classes}"` : ''}><span class="event-marker" aria-hidden="true"></span><div><div class="dsv-event-heading"><strong>${escapeHtml(event.event || 'Evento DSV')}${event.currentSummary ? '<span class="dsv-current-event-tag">Stato corrente</span>' : ''}</strong><time${dateTimeAttribute(event.date)}>${escapeHtml(event.date || '—')}</time></div><span>${escapeHtml([event.country, event.location].filter(Boolean).join(' · ') || (event.currentSummary ? 'Riepilogo DSV' : 'Località non disponibile'))}${elapsed ? `<span class="dsv-event-elapsed">${escapeHtml(elapsed)}</span>` : ''}</span>${event.reason ? `<small>${escapeHtml(event.reason)}</small>` : ''}</div></li>`;
  }).join('');
  return `<section class="dsv-history"><div class="detail-section-heading"><h4>Storico DSV</h4><span>${countLabel}</span></div><ol class="dsv-timeline">${rows}</ol></section>`;
}

const DSV_DELIVERY_EVENT_STATUSES = ['Consegna riprogrammata', 'Tentativo non riuscito', 'Consegna rifiutata', 'In attesa del destinatario', 'Ritardo operativo', 'Reso al mittente'];
const DSV_STATUS_ORDER = ['Prenotata', 'In transito', 'Centro di distribuzione', 'In consegna', ...DSV_DELIVERY_EVENT_STATUSES, 'Consegnata', 'Non verificato', 'Da verificare manualmente', 'Spedizione non trovata', 'Intervento manuale richiesto', 'Eccezione DSV', 'Errore beta'];
const DSV_INTERNAL_ONLY_STATUSES = new Set(['Intervento manuale richiesto', 'Eccezione DSV']);

function dsvFilterKind(status) {
  const normalized = status.toLocaleLowerCase('it-IT');
  if (DSV_DELIVERY_EVENT_STATUSES.some((value) => value.toLocaleLowerCase('it-IT') === normalized)) return 'attention';
  if (normalized.includes('consegnat')) return 'delivered';
  if (/in transito|in consegna|centro di distribuzione/.test(normalized)) return 'transit';
  if (normalized.includes('prenotat')) return 'booked';
  if (/intervento|eccezione|non trovata/.test(normalized)) return 'attention';
  if (/errore|verificare manualmente/.test(normalized)) return 'incomplete';
  if (normalized === 'non verificato') return 'pending';
  return 'unmapped';
}

function renderDsvStatusFilters(counts = {}, archivedCount = 0, attentionTotal = null) {
  const bar = $('#control-quick-filters');
  if (!bar) return;
  const activeStatus = $('#control-dsv-filter')?.value || '';
  const exceptionActive = Boolean($('#control-exceptions')?.checked);
  const total = Object.values(counts).reduce((sum, count) => sum + Number(count || 0), 0);
  const statuses = [...new Set([...DSV_STATUS_ORDER, ...Object.keys(counts)])]
    .filter((status) => !DSV_INTERNAL_ONLY_STATUSES.has(status) && (!DSV_DELIVERY_EVENT_STATUSES.includes(status) || Number(counts[status] || 0) > 0))
    .sort((left, right) => {
    const leftIndex = DSV_STATUS_ORDER.indexOf(left);
    const rightIndex = DSV_STATUS_ORDER.indexOf(right);
    return (leftIndex < 0 ? 999 : leftIndex) - (rightIndex < 0 ? 999 : rightIndex) || left.localeCompare(right, 'it');
    });
  const select = $('#control-dsv-filter');
  statuses.forEach((status) => { if (![...select.options].some((option) => option.value === status)) select.add(new Option(status, status)); });
  if (![...select.options].some((option) => option.value === 'Archiviate')) select.add(new Option('Archiviate', 'Archiviate'));
  const statusButtons = statuses.map((status) => {
    const count = Number(counts[status] || 0);
    const active = activeStatus === status && !exceptionActive;
    return `<button type="button" class="control-quick-filter ${dsvFilterKind(status)}${active ? ' active' : ''}${count === 0 ? ' zero' : ''}" data-dsv-status="${escapeHtml(status)}" aria-pressed="${active}" title="${escapeHtml(status)}: ${count} spedizioni"><span>${escapeHtml(status)}</span><strong>${count}</strong></button>`;
  }).join('');
  const allActive = !activeStatus && !exceptionActive && controlMetricFilter === 'all';
  const archivedActive = activeStatus === 'Archiviate';
  const archivedButton = `<button type="button" class="control-quick-filter archived${archivedActive ? ' active' : ''}${archivedCount === 0 ? ' zero' : ''}" data-dsv-status="Archiviate" aria-pressed="${archivedActive}" title="Spedizioni archiviate: ${archivedCount}"><span>Archiviate</span><strong>${archivedCount}</strong></button>`;
  bar.innerHTML = `<span class="filter-bar-label">Stati ed esiti DSV</span><button type="button" class="control-quick-filter${allActive ? ' active' : ''}" data-control-filter="all" aria-pressed="${allActive}"><span>Tutte</span><strong>${total}</strong></button>${statusButtons}${archivedButton}`;
}

function caseBadge(status) {
  if (!status) return '<span class="case-status none">Non aperta</span>';
  const kind = status === 'Risolta' ? 'resolved' : status === 'Ignorata' ? 'ignored' : status === 'In lavorazione' ? 'working' : 'open';
  return `<span class="case-status ${kind}">${escapeHtml(status)}</span>`;
}

function renderControlMappingAlert(counts = {}) {
  const alert = $('#control-mapping-alert');
  if (!alert) return;
  const mappableStatuses = ['Prenotata', 'In transito', 'Centro di distribuzione', 'In consegna', 'Consegnata', ...DSV_DELIVERY_EVENT_STATUSES];
  const missing = mappableStatuses
    .filter((status) => Number(counts[status] || 0) > 0 && !dsvStateMappings[status])
    .map((status) => ({ status, count: Number(counts[status]) }));
  if (!missing.length) {
    alert.hidden = true;
    alert.innerHTML = '';
    return;
  }
  const affected = missing.reduce((sum, item) => sum + item.count, 0);
  const summary = missing.length === 1
    ? `Mappatura mancante per “${missing[0].status}”: ${affected} spedizion${affected === 1 ? 'e' : 'i'} interessat${affected === 1 ? 'a' : 'e'}.`
    : `${missing.length} stati o esiti DSV senza mappatura (${missing.map((item) => item.status).join(', ')}) interessano ${affected} spedizioni.`;
  alert.innerHTML = `<span><strong>Mappatura stati incompleta.</strong> ${escapeHtml(summary)}</span><button id="configure-control-mappings" type="button" class="secondary">Configura mappature</button>`;
  alert.hidden = false;
}

function updateControlFilterUi() {
  const hasFilters = Boolean(
    ($('#global-tracking-query')?.value || '').trim()
    || $('#control-dsv-filter')?.value
    || controlPrestaStateFilter
    || $('#control-date-filter')?.value
    || $('#control-exceptions')?.checked
    || controlMetricFilter !== 'all'
  );
  const clearButton = $('#control-clear-filters');
  if (clearButton) clearButton.hidden = !hasFilters;
}

function prestaStateFilterLabel(value) {
  if (value === PRESTA_UNLINKED_FILTER) return 'Ordine non collegato';
  if (value === PRESTA_UNAVAILABLE_FILTER) return 'Stato non disponibile';
  return value || 'Stato PrestaShop';
}

function closeControlPrestaFilter() {
  const menu = $('#control-presta-filter-menu');
  const trigger = $('#control-presta-filter-trigger');
  if (menu) menu.hidden = true;
  if (trigger) trigger.setAttribute('aria-expanded', 'false');
}

function positionControlPrestaFilter() {
  const menu = $('#control-presta-filter-menu');
  const trigger = $('#control-presta-filter-trigger');
  if (!menu || !trigger || menu.hidden) return;
  const rect = trigger.getBoundingClientRect();
  const width = Math.min(292, window.innerWidth - 24);
  menu.style.width = `${width}px`;
  menu.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`;
  menu.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - menu.offsetHeight - 12)}px`;
}

function renderControlPrestaFilter(data) {
  const menu = $('#control-presta-filter-menu');
  const trigger = $('#control-presta-filter-trigger');
  const label = $('#control-presta-filter-label');
  if (!menu || !trigger || !label) return;
  const counts = data.prestaStateCounts || {};
  const total = Number(data.prestaStateFacetTotal ?? Object.values(counts).reduce((sum, count) => sum + Number(count || 0), 0));
  const entries = Object.entries(counts)
    .filter(([, count]) => Number(count) > 0)
    .map(([state, count]) => ({
      state,
      value: state === 'Ordine non collegato' ? PRESTA_UNLINKED_FILTER : state === 'Stato non disponibile' ? PRESTA_UNAVAILABLE_FILTER : state,
      count: Number(count),
    }))
    .sort((left, right) => {
      const leftSpecial = left.value.startsWith('__') ? 1 : 0;
      const rightSpecial = right.value.startsWith('__') ? 1 : 0;
      return leftSpecial - rightSpecial || right.count - left.count || left.state.localeCompare(right.state, 'it');
    });
  const activeLabel = prestaStateFilterLabel(controlPrestaStateFilter);
  label.textContent = controlPrestaStateFilter ? activeLabel : 'Stato PrestaShop';
  trigger.classList.toggle('active', Boolean(controlPrestaStateFilter));
  trigger.title = controlPrestaStateFilter ? `Filtro attivo: ${activeLabel}` : 'Filtra per stato PrestaShop';
  menu.innerHTML = `<div class="control-column-filter-heading"><strong>Stato PrestaShop</strong><span>${total} spedizioni</span></div><div class="control-column-filter-options"><button type="button" class="control-column-filter-option${controlPrestaStateFilter ? '' : ' active'}" data-presta-state-filter="" aria-pressed="${!controlPrestaStateFilter}"><span>Tutti gli stati</span><strong>${total}</strong></button>${entries.map(({ state, value, count }) => `<button type="button" class="control-column-filter-option${controlPrestaStateFilter === value ? ' active' : ''}" data-presta-state-filter="${escapeHtml(value)}" aria-pressed="${controlPrestaStateFilter === value}"><span>${escapeHtml(state)}</span><strong>${count}</strong></button>`).join('')}</div>`;
  positionControlPrestaFilter();
}

function renderControlCenter(data) {
  controlOverview = data;
  dsvStateMappings = data.stateMappings || dsvStateMappings;
  controlRecords = data.records || [];
  const batchMode = Boolean(activeBatchFilter?.trackings);
  let batchBanner = $('#control-batch-banner');
  if (batchMode) {
    controlRecords = controlRecords.filter((row) => activeBatchFilter.trackings.has(row.trackingNumber));
    if (!batchBanner) {
      batchBanner = document.createElement('div');
      batchBanner.id = 'control-batch-banner';
      batchBanner.className = 'control-batch-filter-banner';
      const tableWrap = $('#control-table')?.closest('.table-wrap');
      if (tableWrap) tableWrap.parentNode.insertBefore(batchBanner, tableWrap);
    }
    if (batchBanner) {
      batchBanner.hidden = false;
      batchBanner.innerHTML = `<span>Visualizzazione filtrata per il lotto: <strong>${escapeHtml(activeBatchFilter.filename || 'Lotto')}</strong> (${controlRecords.length} spedizioni nel centro)</span><button type="button" class="control-batch-filter-reset">✕ Rimuovi filtro lotto</button>`;
      batchBanner.querySelector('.control-batch-filter-reset')?.addEventListener('click', () => {
        activeBatchFilter = null;
        batchBanner.remove();
        void refreshControlCenter();
      });
    }
  } else if (batchBanner) {
    batchBanner.remove();
  }
  const filteredTotal = batchMode ? controlRecords.length : Number(data.filteredTotal ?? controlRecords.length);
  const totalPages = batchMode ? Math.max(1, Math.ceil(filteredTotal / CONTROL_PAGE_SIZE)) : Number(data.totalPages || 1);
  controlPage = batchMode ? Math.min(controlPage, totalPages) : Number(data.page || controlPage);
  const pageRecords = batchMode ? controlRecords.slice((controlPage - 1) * CONTROL_PAGE_SIZE, controlPage * CONTROL_PAGE_SIZE) : controlRecords;
  const counts = data.counts || {};
  const moving = (counts['Centro di distribuzione'] || 0) + (counts['In transito'] || 0) + (counts['In consegna'] || 0);
  const attention = (counts['Da gestire'] || 0) + (counts['Verifica incompleta'] || 0);
  const activeDsvFilter = $('#control-dsv-filter')?.value || '';
  $('#control-metrics').innerHTML = [
    ['Monitorate', data.total || 0, 'neutral', 'all'], ['In movimento', moving, 'transit', 'moving'],
    ['Consegnate', counts.Consegnata || 0, 'delivered', 'delivered'], ['Richiedono attenzione', attention, 'attention', 'attention'],
  ].map(([label, value, kind, filter]) => {
    const active = controlMetricFilter === filter && (filter !== 'all' || (!activeDsvFilter && !$('#control-exceptions')?.checked));
    return `<button type="button" class="control-metric ${kind}${active ? ' active' : ''}" data-metric-filter="${filter}" aria-pressed="${active}"><strong>${value}</strong><span>${label}</span></button>`;
  }).join('');
  renderDsvStatusFilters(data.dsvCounts || {}, data.archivedCount || 0, attention);
  renderControlMappingAlert(data.dsvCounts || {});
  renderControlPrestaFilter(data);
  const backupBadge = $('#backup-shipments-badge');
  if (backupBadge && data.total !== undefined) {
    backupBadge.textContent = `${data.total} spedizioni pronte`;
  }
  const isArchivedActive = $('#control-dsv-filter')?.value === 'Archiviate';
  const emptyMessage = isArchivedActive ? 'Nessuna spedizione archiviata.' : data.total ? 'Nessuna spedizione corrisponde ai filtri.' : 'Nessuna spedizione ancora archiviata. Verifica un file per popolare il centro.';
  const visibleTrackings = new Set(pageRecords.map((row) => row.trackingNumber));
  controlSelectedTrackingNumbers = new Set([...controlSelectedTrackingNumbers].filter((trackingNumber) => visibleTrackings.has(trackingNumber)));
  $('#control-table tbody').innerHTML = pageRecords.length ? pageRecords.map((row) => {
    const archivedTag = row.archived ? '<span class="control-status archived"><span class="status-dot" aria-hidden="true"></span>Archiviata</span>' : '';
    const checkedAt = row.dsvCheckedAt || row.lastSeenAt;
    const checkedAge = relativeAge(checkedAt);
    const prestaState = String(row.currentState || '').trim();
    const prestaCell = prestaState
      ? `<button type="button" class="control-presta-state-shortcut" data-presta-state-filter="${escapeHtml(prestaState)}" title="Mostra solo gli ordini in stato ${escapeHtml(prestaState)}" aria-label="Filtra per stato PrestaShop: ${escapeHtml(prestaState)}">${prestaShopBadge(prestaState)}</button>`
      : prestaShopBadge(row.currentState);
    const isSelected = controlSelectedTrackingNumbers.has(row.trackingNumber);
    const rowClasses = [row.trackingNumber === activeControlTrackingNumber ? 'active' : '', isSelected ? 'is-selected' : ''].filter(Boolean).join(' ');
    return `<tr data-tracking="${escapeHtml(row.trackingNumber)}" class="${rowClasses}"><td class="control-select-cell"><label class="control-select-target" title="Seleziona ${escapeHtml(row.trackingNumber)}"><input class="control-row-select row-select" data-tracking="${escapeHtml(row.trackingNumber)}" type="checkbox" ${isSelected ? 'checked' : ''} aria-label="Seleziona spedizione ${escapeHtml(row.trackingNumber)}"><span class="sr-only">Seleziona spedizione ${escapeHtml(row.trackingNumber)}</span></label></td><td>${copyableValue(row.trackingNumber, 'Numero spedizione', 'tracking-val')}</td><td>${copyableValue(row.orderReference, 'Riferimento ordine', 'order-val')}</td><td><div class="dsv-state-cell">${dsvBadge(row.dsvStatus)}${archivedTag}${row.dsvPhaseStatus ? `<small>Fase: ${escapeHtml(row.dsvPhaseStatus)}</small>` : ''}<small title="Data e ora dichiarate da DSV">${displayDsvEventDate(row)}</small>${row.dsvEventReason ? `<small class="dsv-event-reason" title="${escapeHtml(row.dsvEventReason)}">${escapeHtml(row.dsvEventReason)}</small>` : ''}</div></td><td>${prestaCell}</td><td><div class="control-alignment-cell">${prestaShopStateAction(row)}</div></td><td><div class="control-check-cell"><span>${displayDateTime(checkedAt)}</span>${checkedAge ? `<small>${escapeHtml(checkedAge)}</small>` : ''}</div></td><td><button class="open-shipment secondary" data-tracking="${escapeHtml(row.trackingNumber)}" aria-label="Apri dettaglio della spedizione ${escapeHtml(row.trackingNumber)}"><span class="sr-only">Dettaglio</span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5"/></svg></button></td></tr>`;
  }).join('') : `<tr><td colspan="8" class="control-empty">${emptyMessage}</td></tr>`;
  updateControlSelectionUi(pageRecords);
  renderControlPager(filteredTotal, totalPages);
  updateControlFilterUi();
}

function renderControlPager(total, totalPages) {
  const pager = $('#control-pager');
  if (!pager) return;
  const first = total ? (controlPage - 1) * CONTROL_PAGE_SIZE + 1 : 0;
  const last = Math.min(controlPage * CONTROL_PAGE_SIZE, total);
  pager.hidden = total <= CONTROL_PAGE_SIZE;
  pager.innerHTML = `<span>${first}–${last} di ${total} spedizioni</span><div><button class="secondary control-page" data-page="${controlPage - 1}" ${controlPage === 1 ? 'disabled' : ''} aria-label="Pagina precedente">Precedente</button><span class="control-page-status">Pagina ${controlPage} di ${totalPages}</span><button class="secondary control-page" data-page="${controlPage + 1}" ${controlPage === totalPages ? 'disabled' : ''} aria-label="Pagina successiva">Successiva</button></div>`;
}

function updateControlSelectionUi(records = []) {
  const selected = controlSelectedTrackingNumbers.size;
  const maxRows = dsvBetaSettings?.maxRows || 100;
  const batchSize = dsvBetaSettings?.batchSize || 10;
  const button = $('#verify-control-selected');
  button.disabled = !dsvBetaSettings?.enabled || selected === 0 || selected > maxRows || Boolean(activeControlDsvJobId);
  button.textContent = selected ? `Verifica DSV (${selected})` : 'Verifica DSV';
  const bulkBar = $('#control-bulk-bar');
  if (bulkBar) {
    bulkBar.hidden = selected === 0;
    $('#control-bulk-count').textContent = `${selected} selezionat${selected === 1 ? 'a' : 'e'} su ${records.length} visibili`;
    $('#control-bulk-verify').disabled = button.disabled;
    $('#control-bulk-manage').disabled = selected === 0;
    const bulkSyncBtn = $('#control-bulk-sync-prestashop');
    if (bulkSyncBtn) bulkSyncBtn.disabled = selected === 0;
    const bulkTrackingBtn = $('#control-bulk-sync-tracking');
    if (bulkTrackingBtn) bulkTrackingBtn.disabled = selected === 0;
  }
  const batchCount = Math.ceil(selected / batchSize);
  const summary = !dsvBetaSettings?.enabled
    ? 'Verifica DSV non disponibile: attivala nella Configurazione.'
    : activeControlDsvJobId
      ? 'Verifica già in corso: puoi continuare a usare il tracking center.'
      : selected > maxRows
        ? `${selected} selezionate: il limite è ${maxRows} spedizioni per operazione.`
        : selected
          ? `${selected} selezionate · un’unica operazione${batchCount > 1 ? ` in ${batchCount} blocchi operativi` : ''}.`
          : 'Seleziona una o più spedizioni per verificare lo stato DSV.';
  const selectionSummary = $('#control-selection-summary');
  selectionSummary.textContent = summary;
  selectionSummary.hidden = !activeControlDsvJobId && Boolean(dsvBetaSettings?.enabled) && selected === 0;
  const toggle = $('#control-toggle-all');
  const pageSelected = records.filter((record) => controlSelectedTrackingNumbers.has(record.trackingNumber)).length;
  toggle.checked = records.length > 0 && pageSelected === records.length;
  toggle.indeterminate = pageSelected > 0 && pageSelected < records.length;
  toggle.setAttribute('aria-label', `Seleziona tutte le ${records.length} spedizioni visibili`);
  toggle.closest('label')?.setAttribute('title', `Seleziona tutte le ${records.length} righe della pagina`);
}

function formatControlProgressDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.round(Number(milliseconds || 0) / 1000));
  if (totalSeconds < 60) return `${totalSeconds} s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes} min ${seconds} s` : `${minutes} min`;
}

function ensureControlDsvProgressUi() {
  const container = $('#control-dsv-progress');
  if (!container || container.dataset.enhanced === 'true') return container;
  container.dataset.enhanced = 'true';
  container.classList.add('control-operation-progress');
  container.removeAttribute('aria-live');
  container.setAttribute('aria-label', 'Avanzamento verifica DSV');
  const title = container.querySelector('.progress-heading strong');
  const track = container.querySelector('.progress-track');
  title.id = 'control-dsv-progress-title';
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-labelledby', title.id);
  track.setAttribute('aria-valuemin', '0');
  track.insertAdjacentHTML('beforebegin', '<div class="control-progress-current"><span id="control-dsv-progress-phase">Preparazione Camoufox</span><span id="control-dsv-progress-tracking" hidden></span></div>');
  track.insertAdjacentHTML('afterend', '<div class="control-progress-footer"><div class="control-progress-meta"><span id="control-dsv-progress-mode"></span><span id="control-dsv-progress-batch" hidden></span><span id="control-dsv-progress-elapsed"></span><span id="control-dsv-progress-eta" hidden></span><span id="control-dsv-progress-counts" hidden></span><span id="control-dsv-progress-outcome" hidden></span></div><button id="control-dsv-cancel" type="button" class="secondary" hidden>Interrompi dopo questa spedizione</button></div><span id="control-dsv-progress-live" class="sr-only" role="status" aria-live="polite"></span>');
  $('#control-dsv-cancel')?.addEventListener('click', cancelControlDsvVerification);
  return container;
}

function updateControlDsvProgress(progress, context = {}) {
  const container = ensureControlDsvProgressUi();
  const total = Number(context.total || progress.total || 0);
  const completed = Math.min(total, Number(progress.completed || 0));
  const percentage = total ? Math.round((completed / total) * 100) : 0;
  const jobState = context.jobStatus || progress.phase || 'running';
  const fallbackActive = Boolean(progress.fallbackReason) || Boolean(progress.requestedSpeedProfile && progress.effectiveSpeedProfile && progress.requestedSpeedProfile !== progress.effectiveSpeedProfile);
  const phaseLabels = {
    queued: 'In coda: attesa disponibilità Camoufox',
    preparing: 'Preparazione sessione Camoufox',
    checking: 'Lettura stato dalla pagina DSV',
    waiting: 'Pausa di sicurezza prima della prossima spedizione',
    syncing: 'Salvataggio dei risultati nel tracking center',
    cancelling: 'Interruzione richiesta: completamento della spedizione corrente',
    cancelled: 'Verifica DSV interrotta',
    complete: 'Verifica DSV completata',
    failed: 'Verifica DSV interrotta',
  };
  const operationStartedAt = Date.parse(context.operationStartedAt || progress.startedAt || '');
  const elapsedMs = Number.isFinite(operationStartedAt) ? Date.now() - operationStartedAt : 0;
  const liveSamples = Number(progress.liveSampleCount || 0);
  const remainingMs = liveSamples >= 2 && completed < total ? Number(progress.averageDurationMs || 0) * (total - completed) : 0;
  const cachedCount = Number(progress.cachedCount || 0);
  const errorCount = Number(progress.errorCount || 0);
  const requestedMode = progress.requestedSpeedProfile || dsvBetaSettings?.speedProfile || 'safe';
  const effectiveMode = progress.effectiveSpeedProfile || requestedMode;

  container.hidden = false;
  container.dataset.state = fallbackActive ? 'fallback' : jobState;
  container.setAttribute('aria-busy', ['queued', 'preparing', 'checking', 'waiting', 'syncing', 'running', 'cancelling'].includes(jobState) ? 'true' : 'false');
  $('#control-dsv-progress-bar').style.width = `${percentage}%`;
  $('#control-dsv-progress-text').textContent = `${completed} di ${total} · ${percentage}%`;
  const track = container.querySelector('.progress-track');
  track.setAttribute('aria-valuemax', String(total));
  track.setAttribute('aria-valuenow', String(completed));
  track.setAttribute('aria-valuetext', `${completed} spedizioni verificate su ${total}`);
  $('#control-dsv-progress-phase').textContent = phaseLabels[progress.phase] || 'Verifica DSV in corso';

  const tracking = $('#control-dsv-progress-tracking');
  tracking.textContent = progress.currentTracking || '';
  tracking.hidden = !progress.currentTracking;

  const mode = $('#control-dsv-progress-mode');
  mode.textContent = `Modalità ${dsvSpeedLabel(effectiveMode).toLocaleLowerCase('it-IT')}${fallbackActive ? ' · fallback' : ''}`;
  mode.title = progress.fallbackReason || '';
  mode.classList.toggle('fallback', fallbackActive);

  const batch = $('#control-dsv-progress-batch');
  const batchCount = Number(progress.batchCount || 1);
  batch.textContent = `Blocco ${Number(progress.batchIndex || 1)} di ${batchCount}`;
  batch.hidden = batchCount <= 1;
  $('#control-dsv-progress-elapsed').textContent = `Trascorsi ${formatControlProgressDuration(elapsedMs)}`;

  const eta = $('#control-dsv-progress-eta');
  eta.textContent = remainingMs ? `Circa ${formatControlProgressDuration(remainingMs)} rimanenti` : 'Calcolo della stima…';
  eta.hidden = jobState === 'queued' || completed >= total || ['cancelled', 'failed'].includes(jobState);

  const counts = $('#control-dsv-progress-counts');
  counts.textContent = `${cachedCount} da cache · ${errorCount} errori`;
  counts.hidden = cachedCount === 0 && errorCount === 0;

  const outcome = $('#control-dsv-progress-outcome');
  outcome.textContent = progress.lastStatus ? `Ultimo esito: ${progress.lastStatus}` : '';
  outcome.hidden = !progress.lastStatus;

  const cancelButton = $('#control-dsv-cancel');
  const cancellable = ['queued', 'running', 'preparing', 'checking', 'waiting'].includes(jobState);
  cancelButton.hidden = !cancellable && jobState !== 'cancelling';
  cancelButton.disabled = jobState === 'cancelling';
  cancelButton.textContent = jobState === 'cancelling' ? 'Interruzione richiesta…' : 'Interrompi dopo questa spedizione';

  const queuePosition = Number(progress.queuePosition || 0);
  if (jobState === 'queued' && queuePosition > 0) $('#control-dsv-progress-phase').textContent = `In coda · ${queuePosition} ${queuePosition === 1 ? 'operazione prima' : 'operazioni prima'}`;
  const announcementKey = `${progress.phase}:${completed === total ? completed : Math.floor(completed / 10)}`;
  if (container.dataset.announcement !== announcementKey) {
    container.dataset.announcement = announcementKey;
    $('#control-dsv-progress-live').textContent = `${phaseLabels[progress.phase] || 'Verifica DSV in corso'}. ${completed} di ${total}.`;
  }
}

async function waitForControlDsvBeta(jobId, context = {}) {
  const snapshot = await request(`/api/dsv-beta/jobs/${jobId}`);
  updateControlDsvProgress(snapshot.progress, { ...context, jobStatus: snapshot.status });
  const partialCount = snapshot.partialResults?.length || 0;
  if (partialCount > Number(context.renderedResults || 0)) {
    context.renderedResults = partialCount;
    await refreshControlCenter();
  }
  if (['queued', 'running', 'cancelling'].includes(snapshot.status)) {
    tell('#control-dsv-message', '');
    await new Promise((resolve) => setTimeout(resolve, 750));
    return waitForControlDsvBeta(jobId, context);
  }
  if (snapshot.status === 'failed') {
    const error = new Error(snapshot.error || 'La verifica DSV non è riuscita.');
    error.result = snapshot.result;
    throw error;
  }
  return snapshot.result;
}

async function cancelControlDsvVerification() {
  if (!activeControlDsvJobId) return;
  const button = $('#control-dsv-cancel');
  if (button) { button.disabled = true; button.textContent = 'Interruzione richiesta…'; }
  try {
    await request(`/api/dsv-beta/jobs/${encodeURIComponent(activeControlDsvJobId)}/cancel`, { method: 'POST' });
  } catch (error) {
    tell('#control-dsv-message', error.message, 'error');
    if (button) { button.disabled = false; button.textContent = 'Interrompi dopo questa spedizione'; }
  }
}

function controlDsvPreviousMap(trackingNumbers) {
  return new Map(trackingNumbers.map((trackingNumber) => {
    const existing = controlRecords.find((row) => row.trackingNumber === trackingNumber);
    return [trackingNumber, {
      dsvStatus: existing?.dsvStatus || 'Non verificato',
      orderReference: existing?.orderReference || '—',
      currentState: existing?.currentState || '—',
      dsvStatusAt: existing?.dsvStatusAt || existing?.dsvStatusDateRaw || '',
    }];
  }));
}

async function finalizeControlDsvVerification(result, uniqueTrackingNumbers, previousMap) {
  const results = result?.results || [];
  const safeguards = result?.safeguards || null;
  const cancelled = Boolean(result?.cancelled);
  const batchCount = safeguards?.batchCount || Math.ceil(uniqueTrackingNumbers.length / (dsvBetaSettings?.batchSize || 10));
  const cached = results.filter((row) => row.cached).length;
  const failed = results.filter((row) => row.status === 'Errore beta').length;
  const completed = results.length - failed;

  const reportRows = results.map((item) => {
    const prev = previousMap.get(item.trackingNumber) || { dsvStatus: 'Non verificato', orderReference: '—', currentState: '—', dsvStatusAt: '' };
    return {
      trackingNumber: item.trackingNumber,
      orderReference: prev.orderReference,
      currentState: prev.currentState,
      prevStatus: prev.dsvStatus,
      newStatus: item.status,
      isChanged: prev.dsvStatus !== item.status,
      detail: item.detail || '',
      cached: Boolean(item.cached),
      statusAt: item.statusAt || item.statusDateRaw || prev.dsvStatusAt || '',
      timeline: item.timeline || [],
    };
  });

  lastVerificationReport = {
    timestamp: new Date(),
    total: uniqueTrackingNumbers.length,
    batches: batchCount,
    completed,
    failed,
    cached,
    cancelled,
    rows: reportRows,
    safeguards,
  };

  const batchSummary = batchCount > 1 ? ` in ${batchCount} blocchi operativi` : '';
  const messageText = cancelled
    ? `Verifica interrotta: conservati ${results.length} risultati su ${uniqueTrackingNumbers.length}.`
    : failed
      ? `${completed} spedizioni verificate${batchSummary}, ${failed} con errore.`
      : `${completed} spedizioni verificate${batchSummary}${cached ? `, ${cached} da cache` : ''}.`;

  renderControlDsvSuccessNotification(messageText, cancelled || failed ? 'warning' : 'success');
  controlSelectedTrackingNumbers.clear();
  await refreshControlCenter();
  return { results, safeguards, cancelled };
}

async function startControlDsvVerification(trackingNumbers) {
  if (!dsvBetaSettings?.enabled) throw new Error('Attiva prima la beta DSV/Schenker nella configurazione e salva.');
  const maxRows = dsvBetaSettings.maxRows || 100;
  if (!trackingNumbers.length) throw new Error('Seleziona almeno una spedizione.');
  const uniqueTrackingNumbers = [...new Set(trackingNumbers)];
  if (uniqueTrackingNumbers.length > maxRows) throw new Error(`Seleziona al massimo ${maxRows} spedizioni per operazione.`);
  if (activeControlDsvJobId) throw new Error('È già in corso una verifica DSV.');
  const previousMap = controlDsvPreviousMap(uniqueTrackingNumbers);
  const operationStartedAt = new Date().toISOString();
  $('#control-dsv-progress strong').textContent = 'Verifica DSV in corso';
  updateControlDsvProgress({ completed: 0, total: uniqueTrackingNumbers.length, phase: 'preparing', requestedSpeedProfile: dsvBetaSettings?.speedProfile }, { total: uniqueTrackingNumbers.length, operationStartedAt });
  tell('#control-dsv-message', '');
  try {
    const { jobId } = await request('/api/dsv-beta/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trackingNumbers: uniqueTrackingNumbers }) });
    activeControlDsvJobId = jobId;
    sessionStorage.setItem(CONTROL_DSV_JOB_STORAGE_KEY, JSON.stringify({ jobId, trackingNumbers: uniqueTrackingNumbers, previous: [...previousMap], operationStartedAt }));
    updateControlSelectionUi([...document.querySelectorAll('.control-row-select')].map((input) => ({ trackingNumber: input.dataset.tracking })));
    const result = await waitForControlDsvBeta(jobId, { total: uniqueTrackingNumbers.length, operationStartedAt, renderedResults: 0 });
    sessionStorage.removeItem(CONTROL_DSV_JOB_STORAGE_KEY);
    activeControlDsvJobId = '';
    return await finalizeControlDsvVerification(result, uniqueTrackingNumbers, previousMap);
  } catch (error) {
    sessionStorage.removeItem(CONTROL_DSV_JOB_STORAGE_KEY);
    activeControlDsvJobId = '';
    await refreshControlCenter();
    const partialCount = error.result?.results?.length || 0;
    throw new Error(`Verifica interrotta dopo ${partialCount} di ${uniqueTrackingNumbers.length} spedizioni: ${error.message}`);
  }
}

async function resumeControlDsvVerification() {
  const raw = sessionStorage.getItem(CONTROL_DSV_JOB_STORAGE_KEY);
  if (!raw) return;
  try {
    const saved = JSON.parse(raw);
    activeControlDsvJobId = saved.jobId;
    const previousMap = new Map(saved.previous || []);
    updateControlSelectionUi([...document.querySelectorAll('.control-row-select')].map((input) => ({ trackingNumber: input.dataset.tracking })));
    const result = await waitForControlDsvBeta(saved.jobId, { total: saved.trackingNumbers.length, operationStartedAt: saved.operationStartedAt, renderedResults: 0 });
    sessionStorage.removeItem(CONTROL_DSV_JOB_STORAGE_KEY);
    activeControlDsvJobId = '';
    await finalizeControlDsvVerification(result, saved.trackingNumbers, previousMap);
  } catch (error) {
    sessionStorage.removeItem(CONTROL_DSV_JOB_STORAGE_KEY);
    activeControlDsvJobId = '';
    tell('#control-dsv-message', `Impossibile riprendere la verifica: ${error.message}`, 'error');
  }
}

function renderControlDsvSuccessNotification(messageText, kind = 'success') {
  const container = $('#control-dsv-message');
  if (!container) return;
  container.className = `message ${kind} has-report-action`.trim();

  container.innerHTML = `
    <div class="report-msg-left">
      <span class="report-msg-dot" aria-hidden="true"></span>
      <span class="report-msg-text">${escapeHtml(messageText)}</span>
    </div>
    <div class="report-msg-actions">
      <button id="open-verification-report-btn" type="button" class="report-trigger-btn" aria-haspopup="dialog" title="Apri il riepilogo dettagliato delle variazioni">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M9.5 2H4a1.5 1.5 0 0 0-1.5 1.5v9A1.5 1.5 0 0 0 4 14h8a1.5 1.5 0 0 0 1.5-1.5V6.5L9.5 2z"/>
          <path d="M9.5 2v4.5H14"/>
          <path d="M6 9h4"/>
          <path d="M6 11.5h2.5"/>
        </svg>
        <span>Vedi report</span>
      </button>
      <button id="dismiss-control-report-msg" type="button" class="report-msg-close" title="Chiudi avviso" aria-label="Chiudi avviso">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 4L4 12M4 4l8 8"/>
        </svg>
      </button>
    </div>
  `;
  $('#open-verification-report-btn')?.addEventListener('click', () => openVerificationReportDialog());
  $('#dismiss-control-report-msg')?.addEventListener('click', () => {
    container.innerHTML = '';
    container.className = 'message';
  });
  const toolbarBtn = $('#open-last-report-btn');
  if (toolbarBtn) toolbarBtn.hidden = false;
}

function openVerificationReportDialog(filterType) {
  if (!lastVerificationReport) return;
  if (filterType !== undefined) activeReportFilter = filterType;
  const dialog = $('#verification-report-dialog');
  if (!dialog) return;

  const timeStr = lastVerificationReport.timestamp.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  const dateStr = lastVerificationReport.timestamp.toLocaleDateString('it-IT');
  const batchStr = lastVerificationReport.batches > 1 ? ` in ${lastVerificationReport.batches} blocchi` : '';
  $('#verification-report-subtitle').textContent = `Verifica del ${dateStr} ore ${timeStr} · ${lastVerificationReport.total} spedizioni elaborate${batchStr}`;

  const rows = lastVerificationReport.rows;
  const total = rows.length;
  const updatedCount = rows.filter((r) => r.isChanged && r.newStatus !== 'Errore beta').length;
  const unchangedCount = rows.filter((r) => !r.isChanged && r.newStatus !== 'Errore beta').length;
  const cachedCount = rows.filter((r) => r.cached).length;
  const attentionCount = rows.filter((r) => r.newStatus === 'Errore beta' || /intervento|eccezione|non trovat/i.test(r.newStatus)).length;

  $('#report-kpi-grid').innerHTML = `
    <div class="report-kpi-card ${updatedCount ? 'updated' : 'neutral'}">
      <strong>${updatedCount}</strong>
      <span>Stati aggiornati</span>
    </div>
    <div class="report-kpi-card unchanged">
      <strong>${unchangedCount}</strong>
      <span>Invariate / Confermate</span>
    </div>
    <div class="report-kpi-card ${cachedCount ? 'cached' : 'neutral'}">
      <strong>${cachedCount}</strong>
      <span>Da cache / Salto</span>
    </div>
    <div class="report-kpi-card ${attentionCount ? 'attention' : 'neutral'}">
      <strong>${attentionCount}</strong>
      <span>Errori / Eccezioni</span>
    </div>
  `;

  renderReportFilters({ total, updatedCount, unchangedCount, cachedCount, attentionCount });
  renderReportTableRows();

  if (!dialog.open) dialog.showModal();
}

function renderReportFilters(counts) {
  const filters = [
    { id: 'all', label: 'Tutte', count: counts.total },
    { id: 'updated', label: 'Aggiornate', count: counts.updatedCount },
    { id: 'unchanged', label: 'Invariate', count: counts.unchangedCount },
    { id: 'cached', label: 'Da cache', count: counts.cachedCount },
  ];
  if (counts.attentionCount > 0) {
    filters.push({ id: 'attention', label: 'Errori / Eccezioni', count: counts.attentionCount });
  }

  $('#report-filters').innerHTML = filters.map((f) => `
    <button type="button" class="report-filter-btn ${activeReportFilter === f.id ? 'active' : ''}" data-report-filter="${f.id}">
      <span>${escapeHtml(f.label)}</span>
      <strong>${f.count}</strong>
    </button>
  `).join('');
}

function renderReportTableRows() {
  if (!lastVerificationReport) return;
  const query = (reportSearchQuery || '').trim().toLocaleLowerCase('it-IT');
  const filtered = lastVerificationReport.rows.filter((row) => {
    if (activeReportFilter === 'updated' && (!row.isChanged || row.newStatus === 'Errore beta')) return false;
    if (activeReportFilter === 'unchanged' && (row.isChanged || row.newStatus === 'Errore beta')) return false;
    if (activeReportFilter === 'cached' && !row.cached) return false;
    if (activeReportFilter === 'attention' && !(row.newStatus === 'Errore beta' || /intervento|eccezione|non trovat/i.test(row.newStatus))) return false;

    if (query) {
      const match = [row.trackingNumber, row.orderReference, row.prevStatus, row.newStatus, row.detail]
        .some((val) => String(val || '').toLocaleLowerCase('it-IT').includes(query));
      if (!match) return false;
    }
    return true;
  });

  const tbody = $('#report-table tbody');
  if (!tbody) return;
  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="control-empty">Nessuna spedizione corrisponde ai filtri selezionati.</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map((row) => {
    let changeBadge = '';
    if (row.newStatus === 'Errore beta') {
      changeBadge = '<span class="report-change error">! Errore</span>';
    } else if (/intervento|eccezione/i.test(row.newStatus)) {
      changeBadge = '<span class="report-change error">! Eccezione</span>';
    } else if (row.isChanged) {
      changeBadge = '<span class="report-change updated">↑ Aggiornato</span>';
    } else {
      changeBadge = '<span class="report-change same">= Invariato</span>';
    }

    const sourceBadge = row.cached
      ? '<span class="report-source-cache" title="Spedizione già conclusa o letta da cache">Cache</span>'
      : '<span class="report-source-live" title="Letto in tempo reale da Camofox">DSV live</span>';

    return `
      <tr>
        <td>${copyableValue(row.trackingNumber, 'Numero spedizione', 'tracking-val')}</td>
        <td>${copyableValue(row.orderReference, 'Riferimento ordine', 'order-val')}</td>
        <td>${dsvBadge(row.prevStatus)}</td>
        <td>${dsvBadge(row.newStatus)}</td>
        <td>${changeBadge}</td>
        <td>${displayDateTime(row.statusAt)}</td>
        <td>${sourceBadge}</td>
        <td><button type="button" class="open-shipment-from-report secondary" data-tracking="${escapeHtml(row.trackingNumber)}">Dettaglio ›</button></td>
      </tr>
    `;
  }).join('');
}

function exportVerificationReportCsv() {
  if (!lastVerificationReport?.rows?.length) return;
  const rows = lastVerificationReport.rows;
  const csvRows = [
    ['Tracking', 'Riferimento ordine', 'Stato precedente', 'Stato DSV rilevato', 'Variazione', 'Data evento DSV', 'Fonte', 'Dettaglio'],
    ...rows.map((r) => [
      r.trackingNumber,
      r.orderReference || '',
      r.prevStatus || '',
      r.newStatus || '',
      r.isChanged ? 'Aggiornato' : 'Invariato',
      r.statusAt || '',
      r.cached ? 'Cache' : 'DSV live',
      r.detail || '',
    ]),
  ];
  const csv = csvRows.map((row) => row.map((v) => `"${String(v).replaceAll('"', '""')}"`).join(';')).join('\r\n');
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  const dateStr = lastVerificationReport.timestamp.toISOString().slice(0, 10);
  link.download = `report-verifica-dsv-${dateStr}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

async function refreshControlCenter() {
  const params = new URLSearchParams();
  const query = ($('#control-search-query')?.value || $('#global-tracking-query')?.value || '').trim();
  if (query) params.set('query', query);
  if ($('#control-dsv-filter')?.value) params.set('dsvStatus', $('#control-dsv-filter').value);
  if (controlPrestaStateFilter) params.set('prestaState', controlPrestaStateFilter);
  if ($('#control-date-filter')?.value) params.set('checkedAfter', $('#control-date-filter').value);
  if ($('#control-exceptions').checked) params.set('exceptions', '1');
  if (controlMetricFilter === 'moving') params.set('status', 'In movimento');
  if (controlMetricFilter === 'delivered') params.set('status', 'Consegnata');
  params.set('page', activeBatchFilter ? '1' : String(controlPage));
  params.set('pageSize', activeBatchFilter ? '500' : String(CONTROL_PAGE_SIZE));
  try {
    renderControlCenter(await request(`/api/control-center?${params}`));
    $('#control-last-sync').textContent = `Elenco aggiornato alle ${new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}`;
  }
  catch (e) { $('#control-table tbody').innerHTML = `<tr><td colspan="8" class="control-empty">${escapeHtml(e.message)}</td></tr>`; }
}

function setupBackupRestore() {
  const downloadBtn = $('#download-backup-btn');
  const restoreForm = $('#restore-backup-form');
  const fileInput = $('#restore-file-input');
  const fileDropZone = $('#restore-drop-zone');
  const filenameText = $('#restore-filename-text');
  const submitBtn = $('#submit-restore-btn');
  const restoreMsg = $('#restore-message');
  const countBadge = $('#backup-shipments-badge');

  async function updateBackupCount() {
    try {
      const data = await request('/api/control-center');
      const count = data.total ?? data.records?.length ?? 0;
      if (countBadge) countBadge.textContent = `${count} spedizioni registrate`;
    } catch {
      if (countBadge) countBadge.textContent = 'Spedizioni pronte';
    }
  }

  downloadBtn?.addEventListener('click', async () => {
    downloadBtn.disabled = true;
    const originalContent = downloadBtn.innerHTML;
    downloadBtn.innerHTML = '<span>Generazione backup in corso…</span>';
    try {
      const a = document.createElement('a');
      a.href = '/api/backup/export';
      const dateStr = new Date().toISOString().slice(0, 10);
      a.download = `dsv-backup-${dateStr}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      showFloatingToast('Backup scaricato con successo!', 'success');
    } catch (err) {
      alert(`Errore durante il download del backup: ${err.message}`);
    } finally {
      downloadBtn.disabled = false;
      downloadBtn.innerHTML = originalContent;
    }
  });

  fileInput?.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) {
      filenameText.textContent = `${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
      fileDropZone.classList.add('has-file');
      submitBtn.disabled = false;
      if (restoreMsg) {
        restoreMsg.className = 'message';
        restoreMsg.textContent = 'File selezionato. Clicca su "Conferma e Ripristina" per procedere.';
      }
    } else {
      filenameText.textContent = 'Clicca per selezionare il file di backup (.json)';
      fileDropZone.classList.remove('has-file');
      submitBtn.disabled = true;
      if (restoreMsg) restoreMsg.textContent = '';
    }
  });

  ['dragenter', 'dragover'].forEach((eventName) => {
    fileDropZone?.addEventListener(eventName, (e) => {
      e.preventDefault();
      fileDropZone.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach((eventName) => {
    fileDropZone?.addEventListener(eventName, (e) => {
      e.preventDefault();
      fileDropZone.classList.remove('dragover');
    });
  });
  fileDropZone?.addEventListener('drop', (e) => {
    const files = e.dataTransfer?.files;
    if (files?.length && fileInput) {
      fileInput.files = files;
      fileInput.dispatchEvent(new Event('change'));
    }
  });

  restoreForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const file = fileInput.files?.[0];
    if (!file) return;

    const confirmMsg = `ATTENZIONE: Stai per ripristinare i dati dal file "${file.name}".\n\n` +
      `Questa operazione importerà le spedizioni e le configurazioni contenute nel backup (verrà creata una copia di sicurezza automatica .bak sul server).\n\n` +
      `Vuoi procedere con il ripristino?`;
    if (!window.confirm(confirmMsg)) return;

    submitBtn.disabled = true;
    const originalBtnText = submitBtn.innerHTML;
    submitBtn.innerHTML = '<span>Ripristino in corso…</span>';
    if (restoreMsg) {
      restoreMsg.className = 'message';
      restoreMsg.textContent = 'Caricamento, verifica e ripristino in corso…';
    }

    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await request('/api/backup/restore', {
        method: 'POST',
        body: formData,
      });

      if (restoreMsg) {
        restoreMsg.className = 'message success';
        restoreMsg.textContent = `✓ ${res.message || 'Ripristino completato con successo!'}`;
      }

      showFloatingToast(`Ripristino completato: ${res.restoredCount} spedizioni caricate!`, 'success');

      restoreForm.reset();
      filenameText.textContent = 'Clicca per selezionare il file di backup (.json)';
      fileDropZone.classList.remove('has-file');

      await Promise.all([
        refreshControlCenter(),
        initialConfig(),
        loadStateMappings(),
        updateBackupCount(),
      ]);
    } catch (err) {
      if (restoreMsg) {
        restoreMsg.className = 'message error';
        restoreMsg.textContent = `Errore ripristino: ${err.message}`;
      }
    } finally {
      submitBtn.disabled = true;
      submitBtn.innerHTML = originalBtnText;
    }
  });

  updateBackupCount();
}

let cronPollingTimer = null;
let cronLastIsRunning = false;

async function loadCronStatus() {
  try {
    const status = await request('/api/cron/status');
    renderCronStatus(status);
  } catch (err) {
    console.error('[CRON] Errore caricamento stato cron:', err);
  }
}

function renderCronStatus(status) {
  if (!status) return;

  const enabledInput = $('#cron-enabled');
  const intervalSelect = $('#cron-interval');
  const batchSizeInput = $('#cron-batch-size');
  const minCheckIntervalSelect = $('#cron-min-check-interval');
  const nightPauseCheckbox = $('#cron-night-pause');
  const startHourInput = $('#cron-start-hour');
  const endHourInput = $('#cron-end-hour');
  const hoursRow = $('#cron-hours-row');

  const activeEl = document.activeElement;
  const isEditingForm = [enabledInput, intervalSelect, batchSizeInput, minCheckIntervalSelect, nightPauseCheckbox, startHourInput, endHourInput].includes(activeEl);

  if (!isEditingForm) {
    if (enabledInput) enabledInput.checked = Boolean(status.enabled);
    if (intervalSelect) intervalSelect.value = String(status.intervalMinutes || 60);
    if (batchSizeInput) batchSizeInput.value = String(status.batchSize || 25);
    if (minCheckIntervalSelect) minCheckIntervalSelect.value = String(status.minCheckIntervalHours || 2);
    if (nightPauseCheckbox) nightPauseCheckbox.checked = Boolean(status.nightPause);
    if (startHourInput) startHourInput.value = String(status.startHour ?? 8);
    if (endHourInput) endHourInput.value = String(status.endHour ?? 20);
    if (hoursRow) hoursRow.style.opacity = status.nightPause ? '1' : '0.4';
  }

  const headerBadge = $('#cron-badge-status');
  if (headerBadge) {
    if (status.isRunning) {
      headerBadge.className = 'badge';
      headerBadge.style.background = '#eff6ff';
      headerBadge.style.color = '#1d4ed8';
      headerBadge.style.borderColor = '#93c5fd';
      headerBadge.textContent = 'Controllo in corso';
    } else if (status.isNightPaused) {
      headerBadge.className = 'badge';
      headerBadge.style.background = '#fef3c7';
      headerBadge.style.color = '#b45309';
      headerBadge.style.borderColor = '#fde68a';
      headerBadge.textContent = `In pausa · ${status.startHour}:00–${status.endHour}:00`;
    } else if (status.enabled) {
      headerBadge.className = 'badge info';
      headerBadge.style.background = '';
      headerBadge.style.color = '';
      headerBadge.style.borderColor = '';
      headerBadge.textContent = `Pianificato · ogni ${status.intervalMinutes} min`;
    } else {
      headerBadge.className = 'badge';
      headerBadge.style.background = '';
      headerBadge.style.color = '';
      headerBadge.style.borderColor = '';
      headerBadge.textContent = 'Servizio disattivato';
    }
  }

  const indicator = $('#cron-running-indicator');
  if (indicator) {
    if (status.isRunning) {
      indicator.className = 'status-indicator running';
      indicator.textContent = `In esecuzione · ${dsvSpeedLabel(status.activeProgress?.speedProfile)}`;
    } else if (status.isNightPaused) {
      indicator.className = 'status-indicator paused';
      indicator.textContent = 'Pausa notturna';
    } else if (status.enabled) {
      indicator.className = 'status-indicator idle';
      indicator.textContent = 'In attesa';
    } else {
      indicator.className = 'status-indicator idle';
      indicator.textContent = 'Inattivo';
    }
  }

  const lastRunEl = $('#cron-last-run-time');
  if (lastRunEl) {
    lastRunEl.textContent = status.lastRunAt ? displayDateTime(status.lastRunAt) : 'Mai eseguito';
  }

  const nextRunEl = $('#cron-next-run-time');
  if (nextRunEl) {
    if (status.isRunning) {
      nextRunEl.textContent = 'In corso';
    } else if (status.enabled && status.nextRunAt) {
      nextRunEl.textContent = displayDateTime(status.nextRunAt);
    } else {
      nextRunEl.textContent = status.enabled ? 'A breve' : 'Nessuno (disattivato)';
    }
  }

  const activeBox = $('#cron-active-box');
  const triggerBtn = $('#cron-trigger-now-btn');
  if (triggerBtn) {
    triggerBtn.disabled = Boolean(status.isRunning);
  }

  if (status.isRunning && status.activeProgress) {
    if (activeBox) activeBox.hidden = false;
    const progress = status.activeProgress;
    const total = progress.total || 1;
    const completed = progress.completed || 0;
    const pct = Math.round((completed / total) * 100);

    const pctEl = $('#cron-progress-pct');
    const barEl = $('#cron-progress-bar');
    const detailEl = $('#cron-progress-detail');

    if (pctEl) pctEl.textContent = `${pct}% (${completed}/${total})`;
    if (barEl) barEl.style.width = `${pct}%`;
    if (detailEl) detailEl.textContent = `Controllo spedizione: ${escapeHtml(progress.currentTracking || '—')} (${completed + 1} di ${total})…`;

    if (!cronPollingTimer) {
      cronPollingTimer = setInterval(loadCronStatus, 2000);
    }
  } else {
    if (activeBox) activeBox.hidden = true;
    if (cronPollingTimer) {
      clearInterval(cronPollingTimer);
      cronPollingTimer = null;
    }

    if (cronLastIsRunning && !status.isRunning) {
      showFloatingToast('Controllo periodico completato con successo!', 'success');
      void refreshControlCenter();
    }
  }

  cronLastIsRunning = Boolean(status.isRunning);
  updateSettingsHealth();
  updateCronImpactPreview();

  const summaryList = $('#cron-summary-list');
  if (summaryList) {
    const s = status.lastRunSummary;
    if (!s) {
      summaryList.innerHTML = '<li>Nessuna scansione recente registrata.</li>';
    } else if (s.type === 'skipped') {
      summaryList.innerHTML = `<li><em>${escapeHtml(s.reason)}</em></li><li style="color:var(--muted)">Registrato alle: ${displayDateTime(s.at)}</li>`;
    } else {
      const deliveredText = s.deliveredFound > 0
        ? `<strong style="color:var(--success)">${s.deliveredFound} spedizioni consegnate trovate!</strong>`
        : 'Nessuna nuova consegna rilevata';
      const errorsText = s.errors > 0
        ? `<span style="color:var(--danger)"> · ${s.errors} con errore</span>`
        : '';
      const cancelledText = s.type === 'cancelled' ? ' <span style="color:var(--warning)">(Interrotta dall’operatore)</span>' : '';
      const profileText = dsvSpeedLabel(s.effectiveSpeedProfile, true);
      const fallbackText = s.fallbackReason ? `<li class="cron-profile-fallback">${escapeHtml(s.fallbackReason)}</li>` : '';

      summaryList.innerHTML = `
        <li>Spedizioni verificate: <strong>${s.checked || 0}</strong> di ${s.totalCandidates || 0}${cancelledText}</li>
        <li>Esito: ${deliveredText}${errorsText}</li>
        <li>Profilo utilizzato: <strong>${profileText}</strong></li>
        ${fallbackText}
        <li>Durata: <strong>${s.durationSeconds || 0}s</strong> · Eseguito: ${displayDateTime(s.at)}</li>
      `;
    }
  }
}

function setupCronSection() {
  const form = $('#cron-config-form');
  const nightPauseCheckbox = $('#cron-night-pause');
  const hoursRow = $('#cron-hours-row');
  const triggerBtn = $('#cron-trigger-now-btn');
  const stopBtn = $('#cron-stop-btn');
  const msg = $('#cron-save-message');

  nightPauseCheckbox?.addEventListener('change', () => {
    if (hoursRow) hoursRow.style.opacity = nightPauseCheckbox.checked ? '1' : '0.4';
  });

  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const saveBtn = $('#save-cron-btn');
    if (saveBtn) saveBtn.disabled = true;

    try {
      const payload = {
        enabled: $('#cron-enabled')?.checked,
        intervalMinutes: Number($('#cron-interval')?.value) || 60,
        batchSize: Number($('#cron-batch-size')?.value) || 25,
        minCheckIntervalHours: Number($('#cron-min-check-interval')?.value) || 2,
        nightPause: $('#cron-night-pause')?.checked,
        startHour: Number($('#cron-start-hour')?.value) || 8,
        endHour: Number($('#cron-end-hour')?.value) || 20,
      };

      const res = await request('/api/cron/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (msg) {
        msg.className = 'message success';
        msg.textContent = 'Impostazioni cron salvate con successo!';
      }
      showFloatingToast('Configurazione cron salvata!', 'success');
      markSettingsClean('automation');
      updateSettingsHealth();
      updateCronImpactPreview();
      renderCronStatus(res.status);
    } catch (err) {
      if (msg) {
        msg.className = 'message error';
        msg.textContent = `Errore salvataggio: ${err.message}`;
      }
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  });

  triggerBtn?.addEventListener('click', async () => {
    triggerBtn.disabled = true;
    try {
      const res = await request('/api/cron/trigger', { method: 'POST' });
      showFloatingToast('Controllo manuale avviato in background!', 'success');
      renderCronStatus(res.status);
      if (!cronPollingTimer) {
        cronPollingTimer = setInterval(loadCronStatus, 2000);
      }
    } catch (err) {
      alert(`Impossibile avviare il controllo: ${err.message}`);
      triggerBtn.disabled = false;
    }
  });

  stopBtn?.addEventListener('click', async () => {
    stopBtn.disabled = true;
    try {
      const res = await request('/api/cron/stop', { method: 'POST' });
      showFloatingToast(res.message || 'Richiesta di arresto inviata.', 'warning');
      renderCronStatus(res.status);
    } catch (err) {
      alert(`Errore: ${err.message}`);
    } finally {
      stopBtn.disabled = false;
    }
  });
}


const settingsSectionLabels = {
  connections: 'Connessioni',
  automation: 'Automazione',
  mappings: 'Mappature',
  notifications: 'Notifiche',
  data: 'Dati e backup',
};
let activeSettingsSection = 'connections';
const dirtySettingsSections = new Set();
const settingsTestState = {
  prestashop: null,
  camofox: null,
  notifications: null,
};

function settingsTimestamp() {
  return new Date().toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' });
}

function setSettingsTestResult(kind, successful, detail) {
  settingsTestState[kind] = { successful, detail, at: settingsTimestamp() };
  const element = $(`[data-settings-test-result="${kind}"]`);
  if (element) {
    element.className = `settings-test-result ${successful ? 'success' : 'error'}`;
    const icon = successful
      ? '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3.5 8.5 6.5 11.5 12.5 4.5"/></svg>'
      : '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6"/><line x1="8" y1="5" x2="8" y2="8"/><line x1="8" y1="11" x2="8.01" y2="11"/></svg>';
    element.innerHTML = `<strong style="display:inline-flex;align-items:center;gap:6px;">${icon} ${successful ? 'Verifica riuscita' : 'Verifica non riuscita'}</strong><span>${escapeHtml(detail)}</span><time>${escapeHtml(settingsTestState[kind].at)}</time>`;
    element.hidden = false;
  }
  updateSettingsHealth();
}

function markSettingsDirty(section) {
  if (!section) return;
  dirtySettingsSections.add(section);
  document.querySelectorAll(`[data-settings-section="${section}"]`).forEach((element) => element.classList.add('has-unsaved-changes'));
  updateSettingsDirtyBar();
}

function markSettingsClean(section) {
  dirtySettingsSections.delete(section);
  document.querySelectorAll(`[data-settings-section="${section}"]`).forEach((element) => element.classList.remove('has-unsaved-changes'));
  updateSettingsDirtyBar();
}

function updateSettingsDirtyBar() {
  const bar = $('#settings-dirty-bar');
  if (!bar) return;
  const sections = [...dirtySettingsSections];
  bar.hidden = sections.length === 0;
  const label = $('#settings-dirty-label');
  if (label) label.textContent = sections.length === 1
    ? `Modifiche non salvate in ${settingsSectionLabels[sections[0]]}`
    : `Modifiche non salvate in ${sections.length} sezioni`;
  const action = $('#settings-dirty-action');
  if (action) action.dataset.settingsTarget = sections[0] || '';
  document.querySelectorAll('[data-settings-nav]').forEach((button) => {
    const marker = button.querySelector('.settings-nav-dirty');
    if (marker) marker.hidden = !dirtySettingsSections.has(button.dataset.settingsNav);
  });
}

function settingsStatus(kind, state, label, detail, action) {
  const item = $(`[data-health-item="${kind}"]`);
  if (!item) return;
  item.dataset.state = state;
  item.querySelector('.settings-health-state').textContent = label;
  item.querySelector('.settings-health-detail').textContent = detail;
  const button = item.querySelector('button');
  if (button) {
    button.textContent = action.label;
    button.dataset.settingsTarget = action.target;
  }
}

function updateSettingsHealth() {
  const prestaConfigured = $('#config-form')?.dataset.configured === 'true';
  const prestaTest = settingsTestState.prestashop;
  settingsStatus('prestashop', prestaTest?.successful ? 'ready' : prestaConfigured ? 'check' : 'off', prestaTest?.successful ? 'Operativo' : prestaConfigured ? 'Da verificare' : 'Non configurato', prestaTest?.successful ? `Permessi verificati · ${prestaTest.at}` : prestaConfigured ? 'Credenziali salvate, test permessi richiesto' : 'Inserisci URL e chiave Webservice', { label: prestaConfigured ? 'Verifica' : 'Configura', target: 'connections' });

  const camofoxEnabled = Boolean($('#dsv-beta-enabled')?.checked);
  const camofoxTest = settingsTestState.camofox;
  settingsStatus('camofox', camofoxTest?.successful && camofoxEnabled ? 'ready' : camofoxEnabled ? 'check' : 'off', camofoxTest?.successful && camofoxEnabled ? 'Operativo' : camofoxEnabled ? 'Da verificare' : 'Non attivo', camofoxTest?.successful && camofoxEnabled ? `Servizio raggiungibile · ${camofoxTest.at}` : camofoxEnabled ? 'Configurazione salvata, test locale richiesto' : 'Le verifiche DSV sono disabilitate', { label: camofoxEnabled ? 'Verifica' : 'Configura', target: 'connections' });

  const cronEnabled = Boolean($('#cron-enabled')?.checked);
  const cronBadge = $('#cron-badge-status')?.textContent?.trim();
  settingsStatus('automation', cronEnabled ? 'ready' : 'off', cronEnabled ? 'Operativo' : 'Non attivo', cronEnabled ? (cronBadge || 'Controllo periodico pianificato') : 'Nessun controllo automatico pianificato', { label: cronEnabled ? 'Controlla' : 'Attiva', target: 'automation' });

  const mappingSelects = [...document.querySelectorAll('.dsv-mapping-select')];
  const mapped = mappingSelects.filter((select) => select.value).length;
  const mappingReady = mappingSelects.length > 0 && mapped === mappingSelects.length;
  settingsStatus('mappings', mappingReady ? 'ready' : mapped ? 'check' : 'off', mappingReady ? 'Operativo' : mapped ? 'Incompleto' : 'Non configurato', mappingSelects.length ? `${mapped} di ${mappingSelects.length} stati associati` : 'Carica il catalogo PrestaShop', { label: mappingReady ? 'Rivedi' : 'Completa', target: 'mappings' });

  const tgReady = Boolean($('#notify-tg-enabled')?.checked && $('#notify-tg-token')?.value?.trim() && $('#notify-tg-chatid')?.value?.trim());
  const emailReady = Boolean($('#notify-email-enabled')?.checked && $('#notify-email-host')?.value?.trim() && $('#notify-email-to')?.value?.trim());
  const notificationReady = tgReady || emailReady;
  const notificationTest = settingsTestState.notifications;
  settingsStatus('notifications', notificationTest?.successful && notificationReady ? 'ready' : notificationReady ? 'check' : 'off', notificationTest?.successful && notificationReady ? 'Operativo' : notificationReady ? 'Da verificare' : 'Non configurato', notificationTest?.successful && notificationReady ? `Canale verificato · ${notificationTest.at}` : notificationReady ? 'Almeno un canale attivo, invia un test' : 'Attiva Telegram o Email', { label: notificationReady ? 'Verifica' : 'Configura', target: 'notifications' });

  const readyCount = document.querySelectorAll('.settings-health-item[data-state="ready"]').length;
  const summary = $('#settings-readiness-summary');
  if (summary) summary.textContent = readyCount === 5 ? 'Sistema pronto per lavorare in autonomia' : `${readyCount} di 5 aree operative`;
  const badge = $('#settings-readiness-badge');
  if (badge) {
    badge.dataset.state = readyCount === 5 ? 'ready' : readyCount >= 3 ? 'check' : 'off';
    badge.textContent = readyCount === 5 ? 'Pronto' : readyCount >= 3 ? 'Da completare' : 'Configurazione richiesta';
  }
}

function activateSettingsSection(section, { scroll = true, behavior = 'smooth' } = {}) {
  if (!settingsSectionLabels[section]) return;
  activeSettingsSection = section;
  document.querySelectorAll('[data-settings-nav]').forEach((button) => {
    const active = button.dataset.settingsNav === section;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
    if (active) button.setAttribute('aria-current', 'true'); else button.removeAttribute('aria-current');
  });
  document.querySelectorAll('[data-settings-section]').forEach((element) => element.classList.toggle('settings-section-active', element.dataset.settingsSection === section));
  if (scroll) {
    const nav = document.querySelector('.settings-section-nav');
    if (nav) {
      const navTop = nav.getBoundingClientRect().top + window.scrollY - 60;
      if (window.scrollY > navTop + 80) {
        window.scrollTo({ top: navTop, behavior });
      }
    }
  }
}

function updateCronImpactPreview() {
  const preview = $('#cron-impact-preview');
  if (!preview) return;
  const enabled = Boolean($('#cron-enabled')?.checked);
  const interval = $('#cron-interval')?.selectedOptions?.[0]?.textContent || 'intervallo selezionato';
  const batch = Number($('#cron-batch-size')?.value) || 25;
  const minInterval = $('#cron-min-check-interval')?.selectedOptions?.[0]?.textContent || '';
  const nightPause = Boolean($('#cron-night-pause')?.checked);
  preview.innerHTML = enabled
    ? `<strong>Impatto previsto</strong><span>${escapeHtml(interval)} · massimo ${batch} spedizioni per ciclo · ${escapeHtml(minInterval.toLocaleLowerCase('it-IT'))}${nightPause ? ' · pausa notturna attiva' : ''}.</span>`
    : '<strong>Automazione disattivata</strong><span>Le verifiche partiranno solo manualmente finché non salvi il servizio come attivo.</span>';
}

function updateMappingFilter() {
  const query = ($('#mapping-search')?.value || '').trim().toLocaleLowerCase('it-IT');
  const incompleteOnly = Boolean($('#mapping-incomplete-only')?.checked);
  const rows = [...document.querySelectorAll('.state-mapping-row')];
  let visible = 0;
  let incomplete = 0;
  rows.forEach((row) => {
    const select = row.querySelector('.dsv-mapping-select');
    const missing = !select?.value;
    if (missing) incomplete += 1;
    const matches = (!query || row.textContent.toLocaleLowerCase('it-IT').includes(query)) && (!incompleteOnly || missing);
    row.hidden = !matches;
    if (matches) visible += 1;
  });
  const summary = $('#mapping-filter-summary');
  if (summary) summary.textContent = `${visible} visibili · ${incomplete} non mappati`;
  const applyButton = $('#apply-mapping-bulk');
  if (applyButton) applyButton.disabled = !$('#mapping-bulk-state')?.value || visible === 0;
}

function setupMappingTools() {
  $('#mapping-search')?.addEventListener('input', updateMappingFilter);
  $('#mapping-incomplete-only')?.addEventListener('change', updateMappingFilter);
  $('#mapping-bulk-state')?.addEventListener('change', updateMappingFilter);
  $('#apply-mapping-bulk')?.addEventListener('click', () => {
    const stateId = $('#mapping-bulk-state')?.value;
    if (!stateId) return;
    let changed = 0;
    document.querySelectorAll('.state-mapping-row:not([hidden]) .dsv-mapping-select').forEach((select) => {
      if (select.value !== stateId) {
        select.value = stateId;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        changed += 1;
      }
    });
    if (changed) {
      markSettingsDirty('mappings');
      tell('#state-mapping-message', `${changed} righe aggiornate. Salva la mappatura per confermare.`, 'warning');
    }
  });
}

function setupWorkspace() {
  const main = $('main');
  const cards = [...main.querySelectorAll(':scope > section.card')];
  cards.forEach((card) => {
    if (card.classList.contains('import-card')) card.dataset.view = 'import';
    else if (card.classList.contains('control-center-card')) card.dataset.view = 'control';
    else if (card.classList.contains('history-card')) card.dataset.view = 'history';
    else card.dataset.view = 'settings';
    card.classList.add('workspace-view');
  });
  const stateMapping = document.createElement('section');
  stateMapping.className = 'card workspace-view state-mapping-card'; stateMapping.dataset.view = 'settings'; stateMapping.id = 'state-mapping-view';
  stateMapping.innerHTML = '<div class="control-heading"><div><p class="eyebrow">ALLINEAMENTO</p><h2>Mappatura stati DSV → PrestaShop</h2><p>Associa stati di spedizione ed esiti ricavati dagli eventi DSV agli stati ordine. Le nuove categorie non aggiornano PrestaShop finché non le configuri; l’auto-allineamento resta disattivato per impostazione predefinita.</p></div></div><form id="state-mapping-form"><div class="state-mapping-header"><span>Stato o esito DSV</span><span>Stato PrestaShop corrispondente</span><span>Auto-allinea via Cron</span></div><div id="state-mapping-rows" class="state-mapping-rows"><p class="control-empty">Apri la configurazione per caricare gli stati.</p></div><div class="state-mapping-actions"><p id="state-mapping-message" class="message" aria-live="polite"></p><button id="save-state-mappings" type="submit">Salva mappatura</button></div></form>';
  main.append(stateMapping);

  const notificationCard = document.createElement('section');
  notificationCard.className = 'card settings-card notification-settings-card';
  notificationCard.id = 'notification-settings-view';
  notificationCard.innerHTML = `
    <div class="control-heading">
      <div>
        <p class="eyebrow">ALERTING &amp; MONITORAGGIO</p>
        <h2>Canali di Notifica &amp; Alerting</h2>
        <p>Configura Bot Telegram ed Email SMTP per ricevere avvisi istantanei su blocchi, SLA e riepiloghi giornalieri.</p>
      </div>
    </div>
    <form id="notification-config-form" class="notification-config-form">
      <div class="notify-channel-card">
        <div class="notify-channel-header">
          <div class="notify-channel-title">
            <svg class="notify-icon telegram" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69.01-.03.01-.14-.07-.19-.08-.05-.19-.02-.27 0-.12.03-1.99 1.27-5.63 3.73-.53.36-1.02.54-1.45.53-.48-.01-1.4-.27-2.09-.49-.84-.27-1.51-.42-1.45-.89.03-.25.38-.51 1.05-.78 4.12-1.79 6.87-2.97 8.24-3.55 3.93-1.65 4.74-1.94 5.27-1.95.12 0 .37.03.54.17.14.12.18.28.2.45-.02.07-.02.19-.04.34z"/></svg>
            <div>
              <strong>Bot Telegram</strong>
              <small>Notifiche push istantanee su smartphone o gruppo</small>
            </div>
          </div>
          <label class="mapping-autosync-toggle">
            <input id="notify-tg-enabled" type="checkbox">
            <span class="autosync-label-text">Attivo</span>
          </label>
        </div>
        <div class="notify-channel-fields">
          <div class="grid-2col">
            <label>Bot Token
              <input id="notify-tg-token" type="password" placeholder="es. 123456789:ABCdefGhIJKlmNoPQRstuVWXyz" autocomplete="off">
            </label>
            <label>Chat ID o Canale
              <input id="notify-tg-chatid" type="text" placeholder="es. 987654321 o @tuocanale" autocomplete="off">
            </label>
          </div>
          <div class="notify-channel-actions">
            <button id="test-tg-btn" type="button" class="secondary">Invia test Telegram</button>
          </div>
        </div>
      </div>

      <div class="notify-channel-card">
        <div class="notify-channel-header">
          <div class="notify-channel-title">
            <svg class="notify-icon email" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
            <div>
              <strong>Email SMTP</strong>
              <small>Avvisi verso caselle operative o di ticketing</small>
            </div>
          </div>
          <label class="mapping-autosync-toggle">
            <input id="notify-email-enabled" type="checkbox">
            <span class="autosync-label-text">Attivo</span>
          </label>
        </div>
        <div class="notify-channel-fields">
          <div class="grid-2col">
            <label>Host SMTP
              <input id="notify-email-host" type="text" placeholder="es. mail.tuodominio.it">
            </label>
            <div class="grid-port-ssl">
              <label>Porta
                <input id="notify-email-port" type="number" value="587" placeholder="587">
              </label>
              <label class="inline-checkbox">
                <input id="notify-email-secure" type="checkbox"> SSL/TLS (465)
              </label>
            </div>
          </div>
          <div class="grid-2col">
            <label>Username / Account
              <input id="notify-email-user" type="text" placeholder="utente@tuodominio.it" autocomplete="off">
            </label>
            <label>Password SMTP
              <input id="notify-email-pass" type="password" placeholder="••••••••" autocomplete="off">
            </label>
          </div>
          <div class="grid-2col">
            <label>Mittente (From)
              <input id="notify-email-from" type="email" placeholder="logistica@tuodominio.it">
            </label>
            <label>Destinatari (To)
              <input id="notify-email-to" type="text" placeholder="operativo@tuodominio.it, ticket@tuodominio.it">
            </label>
          </div>
          <div class="notify-channel-actions">
            <button id="test-email-btn" type="button" class="secondary">Invia test Email</button>
          </div>
        </div>
      </div>

      <div class="notify-channel-card triggers-card">
        <div class="notify-channel-header">
          <div class="notify-channel-title">
            <svg class="notify-icon triggers" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
            <div>
              <strong>Regole di Invio &amp; Trigger</strong>
              <small>Decidi quali eventi devono generare notifiche</small>
            </div>
          </div>
        </div>
        <div class="notify-triggers-list">
          <label class="trigger-checkbox-row">
            <input id="trigger-exceptions" type="checkbox" checked>
            <div>
              <strong>Alert Eccezioni &amp; Giacenze immediate</strong>
              <span>Invia subito un messaggio quando DSV segnala un blocco, destinatario assente o anomalia.</span>
            </div>
          </label>
          <label class="trigger-checkbox-row">
            <input id="trigger-sla" type="checkbox" checked>
            <div>
              <strong>Allarme SLA (Spedizioni ferme da &gt; 48h)</strong>
              <span>Segnala le spedizioni in viaggio o in transito che non registrano avanzamenti da oltre 48 ore.</span>
            </div>
          </label>
          <label class="trigger-checkbox-row">
            <input id="trigger-autosync" type="checkbox">
            <div>
              <strong>Auto-allineamenti riusciti su PrestaShop</strong>
              <span>Conferma ogni cambio di stato applicato automaticamente dal Cron in background.</span>
            </div>
          </label>
          <label class="trigger-checkbox-row">
            <input id="trigger-digest" type="checkbox" checked>
            <div>
              <strong>Digest riepilogativo mattutino</strong>
              <span>Report sintetico programmato ogni mattina con totale spedizioni attive, consegnate ed eccezioni.</span>
            </div>
          </label>
          <div class="digest-time-row" id="digest-time-row">
            <label>Orario invio digest:
              <input id="trigger-digest-hour" type="number" min="0" max="23" value="8" style="width:55px;"> :
              <input id="trigger-digest-minute" type="number" min="0" max="59" value="30" style="width:55px;">
            </label>
            <button id="trigger-digest-test-btn" type="button" class="secondary" title="Invia subito il digest di prova">Invia digest adesso</button>
          </div>
        </div>
      </div>

      <div class="notification-form-actions">
        <p id="notification-config-message" class="message" aria-live="polite"></p>
        <button id="save-notifications-btn" type="submit">Salva impostazioni notifiche</button>
      </div>
    </form>
  `;

  const settingsDashboard = document.createElement('div');
  settingsDashboard.className = 'workspace-view settings-dashboard';
  settingsDashboard.dataset.view = 'settings';
  settingsDashboard.hidden = true;

  const connectionCard = $('#config-form')?.closest('.card');
  const catalogCard = $('#load-catalog')?.closest('.card');
  const backupCard = $('.backup-card');
  const cronCard = $('.cron-card');
  const importCard = $('.import-card');
  const dsvBetaCard = $('#dsv-beta');
  const settingsCards = [connectionCard, catalogCard, dsvBetaCard, backupCard, cronCard, stateMapping, notificationCard].filter(Boolean);

  settingsCards.forEach((card) => {
    card.classList.remove('workspace-view');
    delete card.dataset.view;
    card.hidden = false;
  });
  connectionCard?.classList.add('settings-card', 'settings-connection-card');
  catalogCard?.classList.add('settings-card', 'settings-catalog-card');
  dsvBetaCard?.classList.add('card', 'settings-card', 'settings-camofox-card');
  backupCard?.classList.add('settings-card');
  cronCard?.classList.add('settings-card');
  stateMapping.classList.add('settings-card');

  if (connectionCard) {
    connectionCard.querySelector('h2').textContent = 'Connessione PrestaShop';
    const form = $('#config-form');
    const saveButton = form?.querySelector('button[type="submit"], button:not([type])');
    const testButton = $('#test-connection');
    const actionGroup = document.createElement('div');
    actionGroup.className = 'settings-form-actions';
    if (testButton) actionGroup.append(testButton);
    if (saveButton) {
      saveButton.textContent = 'Salva connessione';
      actionGroup.append(saveButton);
    }
    form?.append(actionGroup);
    actionGroup.insertAdjacentHTML('afterend', '<div class="settings-test-result" data-settings-test-result="prestashop" role="status" aria-live="polite" hidden></div>');
    const emptyActions = [...connectionCard.querySelectorAll(':scope > .actions')].find((item) => !item.children.length);
    emptyActions?.remove();
  }
  if (catalogCard) {
    catalogCard.querySelector('h2').textContent = 'Stati e corriere';
    const catalogButton = $('#load-catalog');
    if (catalogButton) catalogCard.querySelector('.inline')?.append(catalogButton);
  }
  if (backupCard) backupCard.querySelector('h2').textContent = 'Backup e ripristino';
  if (cronCard) {
    cronCard.querySelector('h2').textContent = 'Controllo automatico';
    const cronHeading = cronCard.querySelector(':scope > .control-heading');
    const cronSwitch = cronCard.querySelector('.cron-switch-row');
    const cronStatus = cronCard.querySelector('.cron-header-status');
    const cronHeaderControls = document.createElement('div');
    cronHeaderControls.className = 'cron-header-controls';
    if (cronSwitch) cronHeaderControls.append(cronSwitch);
    if (cronStatus) cronHeaderControls.append(cronStatus);
    cronHeading?.append(cronHeaderControls);

    const cronForm = $('#cron-config-form');
    const scheduleTitle = document.createElement('div');
    scheduleTitle.className = 'cron-panel-heading';
    scheduleTitle.innerHTML = '<h3>Pianificazione</h3><p>Definisci frequenza, volume e fascia oraria dei controlli.</p>';
    cronForm?.prepend(scheduleTitle);
    const impactPreview = document.createElement('div');
    impactPreview.id = 'cron-impact-preview';
    impactPreview.className = 'cron-impact-preview';
    cronForm?.querySelector('.cron-fields')?.insertAdjacentElement('afterend', impactPreview);
  }

  if (dsvBetaCard && importCard) {
    const betaTitle = dsvBetaCard.querySelector('h3');
    if (betaTitle) betaTitle.textContent = 'Verifica pubblica DSV via Camoufox';
    const betaDescription = dsvBetaCard.querySelector('.beta-heading p');
    if (betaDescription) betaDescription.textContent = 'Configura il browser locale usato per leggere lo stato delle spedizioni sul portale pubblico DSV.';
    const betaPill = dsvBetaCard.querySelector('.beta-pill');
    if (betaPill) betaPill.textContent = 'PORTALE PUBBLICO';
    const betaConfig = dsvBetaCard.querySelector('.beta-config');
    const betaSwitch = dsvBetaCard.querySelector('.beta-switch');
    const betaHeading = dsvBetaCard.querySelector('.beta-heading');
    const betaHeadingControls = document.createElement('div');
    betaHeadingControls.className = 'camofox-heading-controls';
    if (betaSwitch) betaHeadingControls.append(betaSwitch);
    if (betaPill) betaHeadingControls.append(betaPill);
    betaHeading?.append(betaHeadingControls);
    const trackingUrlInput = $('#dsv-tracking-url');
    trackingUrlInput?.insertAdjacentHTML('afterend', '<div class="tracking-url-anatomy" aria-label="Struttura URL tracking"><span>dsv.com</span><code>refNumber={tracking}</code><code>language_region=it-IT_IT</code></div>');
    const trackingHint = trackingUrlInput?.parentElement?.querySelector('.field-hint');
    if (trackingHint) trackingHint.innerHTML = 'Il valore <code>TRACKINGDAINSERIRE</code> viene sostituito automaticamente per ogni spedizione.';
    const speedPicker = document.createElement('fieldset');
    speedPicker.className = 'camofox-speed-picker';
    speedPicker.innerHTML = '<legend>Velocità delle verifiche</legend><div class="camofox-speed-options"><label class="camofox-speed-option"><input id="dsv-speed-safe" name="dsv-speed-profile" type="radio" value="safe" checked><span><strong>Affidabile <small>Consigliato</small></strong><span>Una nuova scheda per ogni spedizione e pause più ampie.</span></span></label><label class="camofox-speed-option"><input id="dsv-speed-fast" name="dsv-speed-profile" type="radio" value="fast"><span><strong>Rapido controllato</strong><span>Riutilizza la scheda e riduce le attese. Passa ad Affidabile se DSV diventa instabile.</span></span></label><label class="camofox-speed-option"><input id="dsv-speed-ultra" name="dsv-speed-profile" type="radio" value="ultra"><span><strong>Ultra <small>Sperimentale</small></strong><span>Riutilizza la scheda e attende lo storico completo con pause più brevi. Se DSV diventa instabile passa a Rapido, poi ad Affidabile.</span></span></label></div><p class="camofox-speed-note">Tutti i profili verificano una spedizione alla volta e leggono lo storico DSV. La modifica si applica dal ciclo successivo; Ultra non garantisce un tempo fisso per spedizione.</p>';
    betaConfig?.insertAdjacentElement('afterend', speedPicker);
    const importActions = importCard.querySelector(':scope > .actions');
    const verifyDsvButton = $('#verify-dsv-beta');
    const dsvProgress = $('#dsv-progress');
    const dsvRunMessage = $('#dsv-beta-message');
    if (verifyDsvButton && importActions) importActions.append(verifyDsvButton);
    if (dsvProgress) importCard.append(dsvProgress);
    if (dsvRunMessage) importCard.append(dsvRunMessage);
    const configMessage = document.createElement('p');
    configMessage.id = 'dsv-config-message';
    configMessage.className = 'message';
    configMessage.setAttribute('aria-live', 'polite');
    dsvBetaCard.append(configMessage);
    dsvBetaCard.insertAdjacentHTML('beforeend', '<div class="settings-test-result" data-settings-test-result="camofox" role="status" aria-live="polite" hidden></div>');
  }

  connectionCard?.setAttribute('data-settings-section', 'connections');
  catalogCard?.setAttribute('data-settings-section', 'connections');
  dsvBetaCard?.setAttribute('data-settings-section', 'connections');
  cronCard?.setAttribute('data-settings-section', 'automation');
  stateMapping.setAttribute('data-settings-section', 'mappings');
  notificationCard.setAttribute('data-settings-section', 'notifications');
  backupCard?.setAttribute('data-settings-section', 'data');

  const overview = document.createElement('section');
  overview.className = 'settings-overview';
  overview.innerHTML = `
    <div class="settings-overview-heading">
      <div><h2>Stato del sistema</h2><p id="settings-readiness-summary">Verifica della configurazione in corso…</p></div>
      <span id="settings-readiness-badge" class="settings-readiness-badge" data-state="off">Configurazione richiesta</span>
    </div>
    <div class="settings-health-grid">
      ${[
        ['prestashop', 'PrestaShop', 'connections'],
        ['camofox', 'DSV / Camoufox', 'connections'],
        ['automation', 'Automazione', 'automation'],
        ['mappings', 'Mappature', 'mappings'],
        ['notifications', 'Notifiche', 'notifications'],
      ].map(([kind, label, target]) => `<article class="settings-health-item" data-health-item="${kind}" data-settings-target="${target}" data-state="off" tabindex="0" role="button" aria-label="Vai a sezione ${label}"><span class="settings-health-dot" aria-hidden="true"></span><div><strong>${label}</strong><span class="settings-health-state">Non configurato</span><small class="settings-health-detail">Verifica richiesta</small></div><button type="button" class="settings-health-action" data-settings-target="${target}">Configura</button></article>`).join('')}
    </div>
  `;

  const sectionNav = document.createElement('nav');
  sectionNav.className = 'settings-section-nav';
  sectionNav.setAttribute('aria-label', 'Sezioni configurazione');
  sectionNav.innerHTML = Object.entries(settingsSectionLabels).map(([key, label], index) => `<button type="button" data-settings-nav="${key}" aria-pressed="${index === 0 ? 'true' : 'false'}" class="${index === 0 ? 'active' : ''}"><span>${label}</span><span class="settings-nav-dirty" aria-label="Modifiche non salvate" hidden></span></button>`).join('');

  const dirtyBar = document.createElement('div');
  dirtyBar.id = 'settings-dirty-bar';
  dirtyBar.className = 'settings-dirty-bar';
  dirtyBar.hidden = true;
  dirtyBar.innerHTML = '<span><strong id="settings-dirty-label">Modifiche non salvate</strong><small>Salva la sezione prima di uscire dalla configurazione.</small></span><button id="settings-dirty-action" type="button" class="secondary">Vai alla sezione</button>';

  const makeSectionHeading = (section, title, description) => {
    const heading = document.createElement('div');
    heading.className = 'settings-section-heading';
    heading.dataset.settingsSection = section;
    heading.innerHTML = `<div><h2>${title}</h2><p>${description}</p></div>`;
    return heading;
  };
  const connectionsHeading = makeSectionHeading('connections', 'Connessioni', 'Collega il negozio e il servizio locale che consulta il portale DSV.');
  const automationHeading = makeSectionHeading('automation', 'Automazione', 'Definisci quando e con quale carico eseguire i controlli periodici.');
  const mappingsHeading = makeSectionHeading('mappings', 'Mappature', 'Decidi come tradurre gli stati DSV negli stati ordine di PrestaShop.');
  const notificationsHeading = makeSectionHeading('notifications', 'Notifiche', 'Scegli i canali e gli eventi che richiedono attenzione operativa.');
  const dataHeading = makeSectionHeading('data', 'Dati e backup', 'Esporta l’archivio o ripristina una copia verificata.');

  const mappingToolbar = document.createElement('div');
  mappingToolbar.className = 'mapping-toolbar';
  mappingToolbar.innerHTML = '<label class="mapping-search"><span class="sr-only">Cerca stato DSV</span><input id="mapping-search" type="search" placeholder="Cerca stato DSV…" autocomplete="off"></label><label class="mapping-incomplete-filter"><input id="mapping-incomplete-only" type="checkbox"> Solo non mappati</label><div class="mapping-bulk"><label><span>Assegna ai visibili</span><select id="mapping-bulk-state" aria-label="Stato PrestaShop da assegnare alle righe visibili"><option value="">Scegli stato…</option></select></label><button id="apply-mapping-bulk" type="button" class="secondary" disabled>Applica</button></div><span id="mapping-filter-summary" class="mapping-filter-summary" aria-live="polite"></span>';
  stateMapping.querySelector('.control-heading')?.insertAdjacentElement('afterend', mappingToolbar);

  notificationCard.querySelector('.notification-form-actions')?.insertAdjacentHTML('beforebegin', '<div class="settings-test-result" data-settings-test-result="notifications" role="status" aria-live="polite" hidden></div>');

  settingsDashboard.append(
    overview,
    sectionNav,
    connectionsHeading, connectionCard, catalogCard, dsvBetaCard,
    automationHeading, cronCard,
    mappingsHeading, stateMapping,
    notificationsHeading, notificationCard,
    dataHeading, backupCard,
    dirtyBar,
  );
  main.append(settingsDashboard);

  sectionNav.addEventListener('click', (event) => {
    const button = event.target.closest('[data-settings-nav]');
    if (button) {
      event.preventDefault();
      window.history.replaceState(null, '', `#settings/${button.dataset.settingsNav}`);
      activateSettingsSection(button.dataset.settingsNav);
    }
  });
  settingsDashboard.addEventListener('click', (event) => {
    const copyBtn = event.target.closest('#copy-dsv-tracking-url');
    if (copyBtn) {
      event.preventDefault();
      const input = document.querySelector('#dsv-tracking-url');
      if (input && navigator.clipboard) {
        navigator.clipboard.writeText(input.value).then(() => {
          copyBtn.classList.add('copied');
          const originalText = copyBtn.textContent;
          copyBtn.textContent = 'Copiato!';
          setTimeout(() => {
            copyBtn.classList.remove('copied');
            copyBtn.textContent = originalText;
          }, 2000);
        }).catch(() => {});
      }
      return;
    }
    const target = event.target.closest('[data-settings-target]');
    if (target) {
      window.history.replaceState(null, '', `#settings/${target.dataset.settingsTarget}`);
      activateSettingsSection(target.dataset.settingsTarget);
    }
  });
  settingsDashboard.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      const target = event.target.closest('[data-settings-target]');
      if (target && !event.target.matches('input, select, textarea, button')) {
        event.preventDefault();
        window.history.replaceState(null, '', `#settings/${target.dataset.settingsTarget}`);
        activateSettingsSection(target.dataset.settingsTarget);
      }
    }
  });
  settingsDashboard.addEventListener('input', (event) => {
    const section = event.target.closest('[data-settings-section]')?.dataset.settingsSection;
    const persistsImmediately = event.target.closest('.settings-catalog-card') || event.target.matches('#mapping-search') || section === 'data';
    if (section && !persistsImmediately) markSettingsDirty(section);
    updateSettingsHealth();
    updateCronImpactPreview();
  });
  settingsDashboard.addEventListener('change', (event) => {
    const section = event.target.closest('[data-settings-section]')?.dataset.settingsSection;
    const persistsImmediately = event.target.closest('.settings-catalog-card') || event.target.matches('#mapping-incomplete-only, #mapping-bulk-state') || section === 'data';
    if (section && !persistsImmediately) markSettingsDirty(section);
    updateSettingsHealth();
    updateCronImpactPreview();
  });
  activateSettingsSection('connections', { scroll: false });
  updateCronImpactPreview();
  updateSettingsHealth();
  const history = document.createElement('section');
  history.className = 'card workspace-view'; history.dataset.view = 'history'; history.id = 'history-view'; history.hidden = true;
  history.innerHTML = `
    <div class="control-heading history-heading">
      <div>
        <p class="eyebrow">TRACCIABILITÀ & AUDIT</p>
        <h2>Storico & Registro Operazioni</h2>
        <p>Monitora i lotti di importazione e consulta l'audit log completo di tutti gli eventi di sistema.</p>
      </div>
      <div class="history-heading-actions">
        <button id="refresh-history" type="button" class="secondary">
          <svg viewBox="0 0 20 20" width="15" height="15" fill="currentColor"><path fill-rule="evenodd" d="M4 2a1 1 0 0 1 1 1v2.101a7.002 7.002 0 0 1 11.601 2.566 1 1 0 1 1-1.885.666A5.002 5.002 0 0 0 5.999 7H9a1 1 0 0 1 0 2H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zm.008 9.047a1 1 0 0 1 1.885-.666A5.002 5.002 0 0 0 14.001 13H11a1 1 0 1 1 0-2h5a1 1 0 0 1 1 1v5a1 1 0 1 1-2 0v-2.101a7.002 7.002 0 0 1-11.601-2.566 1 1 0 0 1-.392-.286z" clip-rule="evenodd"/></svg>
          Aggiorna
        </button>
      </div>
    </div>
    <div class="history-subnav" role="tablist">
      <button type="button" class="history-subnav-btn active" data-subtab="batches" role="tab" aria-selected="true">
        <svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor"><path d="M2 6a2 2 0 0 1 2-2h5l2 2h5a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6z"/></svg>
        <span>Lotti di Importazione</span>
        <span class="history-badge-count" id="batches-count-badge">0</span>
      </button>
      <button type="button" class="history-subnav-btn" data-subtab="audit" role="tab" aria-selected="false">
        <svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor"><path fill-rule="evenodd" d="M4 4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4zm3 1.5a.5.5 0 0 0 0 1h6a.5.5 0 0 0 0-1H7zm0 3a.5.5 0 0 0 0 1h6a.5.5 0 0 0 0-1H7zm0 3a.5.5 0 0 0 0 1h4a.5.5 0 0 0 0-1H7z" clip-rule="evenodd"/></svg>
        <span>Audit Log Operativo</span>
        <span class="history-badge-count" id="audit-count-badge">0</span>
      </button>
    </div>
    <div id="history-batches-tab" class="history-tab-pane active">
      <div class="history-batch-toolbar">
        <label class="history-batch-search"><span class="sr-only">Cerca nello storico importazioni</span><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/></svg><input id="batch-search-input" type="search" placeholder="Cerca file, lotto o tracking…" autocomplete="off"></label>
        <label class="history-batch-origin"><span>Origine</span><select id="batch-origin-filter"><option value="">Tutte</option><option value="excel">File Excel</option><option value="manual">Inserimento manuale</option></select></label>
        <span id="batch-results-summary" class="batch-results-summary" aria-live="polite"></span>
      </div>
      <p id="history-batches-message" class="message history-batches-message" aria-live="polite"></p>
      <div class="batches-container" id="batches-list">
        <div class="control-empty">Caricamento storico lotti…</div>
      </div>
    </div>
    <div id="history-audit-tab" class="history-tab-pane" hidden>
      <div class="audit-toolbar">
        <div class="audit-type-pills" id="audit-type-filters">
          <button type="button" class="audit-pill-btn active" data-type="">Tutti gli eventi</button>
          <button type="button" class="audit-pill-btn" data-type="importazione">📥 Importazioni</button>
          <button type="button" class="audit-pill-btn" data-type="dsv">🚚 Scansioni DSV</button>
          <button type="button" class="audit-pill-btn" data-type="prestashop">🔄 PrestaShop</button>
          <button type="button" class="audit-pill-btn" data-type="gestione">📦 Gestione & Note</button>
        </div>
        <div class="audit-search-row">
          <input type="search" id="audit-search-input" placeholder="Cerca per tracking, ordine o dettaglio…">
          <select id="audit-date-filter" aria-label="Periodo temporale">
            <option value="">Tutto il periodo</option>
            <option value="today">Oggi</option>
            <option value="7d">Ultimi 7 giorni</option>
            <option value="30d">Ultimi 30 giorni</option>
          </select>
          <button id="export-audit-csv-btn" type="button" class="secondary">
            <svg viewBox="0 0 20 20" width="15" height="15" fill="currentColor"><path fill-rule="evenodd" d="M3 17a1 1 0 0 1 1-1h12a1 1 0 1 1 0 2H4a1 1 0 0 1-1-1zm3.293-7.707a1 1 0 0 1 1.414 0L9 10.586V3a1 1 0 1 1 2 0v7.586l1.293-1.293a1 1 0 1 1 1.414 1.414l-3 3a1 1 0 0 1-1.414 0l-3-3a1 1 0 0 1 0-1.414z" clip-rule="evenodd"/></svg>
            Esporta CSV
          </button>
        </div>
      </div>
      <div class="table-wrap">
        <table id="audit-log-table">
          <thead>
            <tr>
              <th>Data/Ora</th>
              <th>Tipo</th>
              <th>Tracking</th>
              <th>Riferimento Ordine</th>
              <th>Stato DSV</th>
              <th>Azione / Esito</th>
              <th>Dettaglio</th>
            </tr>
          </thead>
          <tbody>
            <tr><td colspan="7" class="control-empty">Caricamento eventi in corso…</td></tr>
          </tbody>
        </table>
      </div>
    </div>
    <dialog id="delete-batch-dialog" class="delete-batch-dialog" aria-labelledby="delete-batch-title">
      <form id="delete-batch-form" class="delete-batch-form">
        <div class="delete-batch-heading"><div><h3 id="delete-batch-title">Elimina lotto dallo storico?</h3><p>Questa operazione elimina soltanto la registrazione del lotto.</p></div><button id="close-delete-batch" type="button" class="detail-close" aria-label="Chiudi"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg></button></div>
        <div class="delete-batch-summary"><strong id="delete-batch-name">—</strong><span id="delete-batch-meta"></span></div>
        <p class="delete-batch-assurance">Le spedizioni nel Tracking Center, l’audit operativo e gli ordini PrestaShop non verranno modificati.</p>
        <p id="delete-batch-message" class="message" aria-live="polite"></p>
        <div class="delete-batch-actions"><button id="cancel-delete-batch" type="button" class="secondary">Annulla</button><button id="confirm-delete-batch" type="submit" class="danger">Elimina dallo storico</button></div>
      </form>
    </dialog>
  `;
  main.append(history);
  const icons = {
    control: '<svg viewBox="0 0 24 24"><path d="M4 5h16v14H4zM4 10h16M9 10v9"/></svg>',
    import: '<svg viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5M4 20h16"/></svg>',
    history: '<svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.6M4 4v4.6h4.6M12 8v5l3 2"/></svg>',
    settings: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19 13.5v-3l-2-.7-.7-1.7.9-1.9-2.1-2.1-1.9.9-1.7-.7-.7-2h-3l-.7 2-1.7.7-1.9-.9-2.1 2.1.9 1.9-.7 1.7-2 .7v3l2 .7.7 1.7-.9 1.9 2.1 2.1 1.9-.9 1.7.7.7 2h3l.7-2 1.7-.7 1.9.9 2.1-2.1-.9-1.9.7-1.7 2-.7Z"/></svg>',
  };
  document.body.insertAdjacentHTML('afterbegin', `<header class="app-topbar"><button id="mobile-navigation-toggle" class="topbar-icon" type="button" aria-label="Apri navigazione" aria-expanded="false"><svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button><a class="topbar-brand" href="#control" aria-label="DSV - Tracking Center"><svg class="dsv-brand-logo" viewBox="0 0 81 24" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M 70.537,22.559 C 70.272,23.074 69.493,24 68.14,24 h -5.557 c -1.344,0 -2.139,-0.937 -2.378,-1.428 L 52.68,7.242 C 51.942,5.798 50.392,5.334 49.097,5.334 H 35.434 c -1.26,0 -1.995,0.81 -1.995,2 0,1.266 0.82,2 2.014,2 h 9.4 c 4.003,0 7.316,2.427 7.316,7.333 0,4.936 -3.345,7.332 -7.316,7.332 H 32.772 c -1.096,0 -2.007,-0.637 -2.007,-2.023 v -2.641 c 0,-0.449 0.3,-0.668 0.67,-0.668 h 10.744 c 1.114,0 2.007,-0.671 2.007,-2 0,-1.314 -0.877,-2.002 -2.004,-2.002 l -10.106,0.002 c -1.694,0 -3.232,-0.464 -4.32,-1.18 -0.558,6.504 -5.196,10.512 -11.973,10.512 H 0.668 C 0.298,23.999 0,23.777 0,23.332 V 10.001 C 0,9.558 0.294,9.336 0.657,9.334 h 5.32 c 1.419,0 2.049,0.911 2.049,1.99 V 18 H 8.03 c 0,0.443 0.294,0.663 0.656,0.666 h 4.616 c 3.63,0 6.65,-2.204 6.65,-6.665 0,-4.469 -3.007,-6.666 -6.65,-6.666 H 0.652 C 0.292,5.328 0,5.11 0,4.666 V 2.02 C 0,0.524 1.055,0 2.026,0 h 13.825 c 3.892,0 7.412,1.445 9.484,4.109 C 26.46,1.399 28.977,0 32.137,0 h 19.8 c 2.433,0 5.186,0.837 6.618,3.652 l 6.407,13.474 c 0.066,0.138 0.196,0.203 0.359,0.203 0.149,0 0.288,-0.055 0.356,-0.196 0,0 7.923,-16.714 7.97,-16.81 C 73.687,0.233 73.851,0 74.237,0 H 80.33 C 80.701,0 81,0.22 81,0.666 a 0.78,0.78 0 0 1 -0.066,0.326 z"/></svg><span>Tracking Center</span></a><form id="global-tracking-form" class="global-tracking-search" role="search"><label class="sr-only" for="global-tracking-query">Cerca tracking o riferimento ordine</label><input id="global-tracking-query" type="search" placeholder="Cerca tracking, riferimento o ID ordine"><button type="submit">Cerca</button></form><div class="topbar-actions"><span class="topbar-live"><i aria-hidden="true"></i> Sistema locale</span><button id="topbar-help-btn" type="button" class="topbar-help" title="Guida e funzionamento dell'applicazione">? <span>Aiuto</span></button><span class="topbar-user"><span aria-hidden="true">OP</span><strong>Operazioni</strong></span></div></header>`);
  main.insertAdjacentHTML('afterbegin', `<aside class="workspace-nav"><div class="nav-heading"><span>OPERAZIONI</span><button id="desktop-navigation-toggle" type="button" title="Comprimi navigazione" aria-label="Comprimi navigazione" aria-expanded="true"><svg viewBox="0 0 24 24"><path d="m14 7-5 5 5 5"/></svg></button></div><nav aria-label="Navigazione principale"><button data-view-link="control" title="Centro di controllo">${icons.control}<span>Centro di controllo</span></button><button data-view-link="import" title="Importa spedizioni">${icons.import}<span>Importa spedizioni</span></button><button data-view-link="history" title="Storico importazioni">${icons.history}<span>Storico importazioni</span></button><span class="nav-section">SISTEMA</span><button data-view-link="settings" title="Configurazione">${icons.settings}<span>Configurazione</span></button></nav><p class="nav-note">Dati operativi e note conservati localmente.</p></aside><button id="navigation-backdrop" class="navigation-backdrop" type="button" aria-label="Chiudi navigazione"></button>`);
  main.querySelectorAll('[data-view-link]').forEach((button) => button.addEventListener('click', () => { location.hash = button.dataset.viewLink; document.body.classList.remove('navigation-open'); $('#mobile-navigation-toggle').setAttribute('aria-expanded', 'false'); }));
  $('#desktop-navigation-toggle').addEventListener('click', () => { const collapsed = document.body.classList.toggle('sidebar-collapsed'); $('#desktop-navigation-toggle').setAttribute('aria-expanded', String(!collapsed)); $('#desktop-navigation-toggle').setAttribute('aria-label', collapsed ? 'Espandi navigazione' : 'Comprimi navigazione'); });
  $('#mobile-navigation-toggle').addEventListener('click', () => { const open = document.body.classList.toggle('navigation-open'); $('#mobile-navigation-toggle').setAttribute('aria-expanded', String(open)); });
  $('#navigation-backdrop').addEventListener('click', () => { document.body.classList.remove('navigation-open'); $('#mobile-navigation-toggle').setAttribute('aria-expanded', 'false'); });
  $('#global-tracking-form').addEventListener('submit', (event) => { event.preventDefault(); controlPage = 1; location.hash = 'control'; refreshControlCenter(); });
  $('#global-tracking-query')?.addEventListener('input', () => {
    controlPage = 1;
    if ($('#control-search-query')) $('#control-search-query').value = $('#global-tracking-query').value;
    clearTimeout(window.controlSearchTimer);
    window.controlSearchTimer = setTimeout(refreshControlCenter, 300);
  });
  $('#refresh-history').addEventListener('click', renderImportHistory);
  $('#state-mapping-form').addEventListener('submit', saveStateMappings);
  setupBackupRestore();
  setupCronSection();
  setupNotificationSection();
  setupHistorySection();
  const helpDialog = $('#help-dialog');
  if (helpDialog) {
    $('#topbar-help-btn')?.addEventListener('click', () => {
      if (typeof helpDialog.showModal === 'function') {
        helpDialog.showModal();
      } else {
        helpDialog.setAttribute('open', '');
      }
    });
    $('#close-help-dialog')?.addEventListener('click', () => helpDialog.close?.());
    $('#dismiss-help-dialog')?.addEventListener('click', () => helpDialog.close?.());
    helpDialog.addEventListener('click', (event) => {
      if (event.target === helpDialog) helpDialog.close?.();
    });
  }
  setupMappingTools();
  window.addEventListener('beforeunload', (event) => {
    if (!dirtySettingsSections.size) return;
    event.preventDefault();
    event.returnValue = '';
  });
  setupControlWorkspace();
  window.addEventListener('hashchange', () => showView(location.hash.slice(1) || 'control'));
}

function setupControlWorkspace() {
  const card = $('.control-center-card');
  card.querySelector('.control-heading h2').textContent = 'Coda spedizioni';
  card.querySelector('.control-heading p').textContent = 'Consulta lo stato, individua le eccezioni e avvia verifiche DSV senza modificare gli ordini.';
  const headerCells = [...card.querySelectorAll('#control-table thead th')];
  headerCells.find((cell) => cell.textContent.trim() === 'Gestione')?.remove();
  headerCells.find((cell) => cell.textContent.trim() === 'Stato operativo')?.remove();
  const trackingHeader = headerCells.find((cell) => cell.textContent.trim() === 'Tracking');
  if (trackingHeader) trackingHeader.textContent = 'Tracking';
  const dsvHeader = [...card.querySelectorAll('#control-table thead th')].find((cell) => cell.textContent.trim() === 'Stato DSV');
  if (![...card.querySelectorAll('#control-table thead th')].some((cell) => cell.textContent.trim() === 'Stato PrestaShop')) dsvHeader?.insertAdjacentHTML('afterend', '<th>Stato PrestaShop</th>');
  const prestaHeader = [...card.querySelectorAll('#control-table thead th')].find((cell) => cell.textContent.trim() === 'Stato PrestaShop');
  if (![...card.querySelectorAll('#control-table thead th')].some((cell) => cell.textContent.trim() === 'Allineamento')) prestaHeader?.insertAdjacentHTML('afterend', '<th>Allineamento</th>');
  if (prestaHeader) {
    prestaHeader.classList.add('control-filterable-header');
    prestaHeader.innerHTML = '<button id="control-presta-filter-trigger" type="button" class="control-column-filter-trigger" aria-haspopup="menu" aria-expanded="false"><span id="control-presta-filter-label">Stato PrestaShop</span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></button>';
  }
  if (!$('#control-presta-filter-menu')) document.body.insertAdjacentHTML('beforeend', '<div id="control-presta-filter-menu" class="control-column-filter-menu" role="menu" aria-label="Filtra per stato PrestaShop" hidden></div>');
  const initialEmptyCell = card.querySelector('#control-table tbody .control-empty');
  if (initialEmptyCell) initialEmptyCell.colSpan = card.querySelectorAll('#control-table thead th').length;
  card.querySelector('.control-heading > div').insertAdjacentHTML('beforeend', '<div class="control-meta"><span id="control-service-status" class="control-service-status" data-state="off" role="status" aria-live="polite">DSV tracking non attivo</span><span id="control-last-sync" class="control-last-sync" aria-live="polite"></span></div>');
  card.querySelector('.control-filters').insertAdjacentHTML('beforebegin', '<nav id="control-quick-filters" class="control-quick-filters" aria-label="Filtra per stato DSV"><span class="filter-bar-label">Stati DSV</span><button type="button" class="control-quick-filter active" data-dsv-status=""><span>Tutte</span><strong>0</strong></button></nav>');
  card.querySelector('.control-filters').insertAdjacentHTML('beforeend', '<label class="control-dsv-filter-label" hidden>Stato DSV<select id="control-dsv-filter"><option value="">Tutti gli esiti DSV</option><option>Prenotata</option><option>In transito</option><option>Centro di distribuzione</option><option>In consegna</option><option>Consegnata</option><option>Non verificato</option><option>Da verificare manualmente</option><option>Errore beta</option><option>Spedizione non trovata</option><option>Intervento manuale richiesto</option><option>Eccezione DSV</option><option value="Archiviate">Archiviate</option></select></label><div class="control-filters-right"><label class="control-date-label"><span>Controllato dal</span><input id="control-date-filter" type="date"></label><button id="control-clear-filters" type="button" class="secondary control-clear-filters" hidden>Pulisci filtri</button></div>');
  card.querySelector('.control-filters').insertAdjacentHTML('afterend', '<div id="control-mapping-alert" class="control-mapping-alert" hidden></div>');
  card.querySelector('.control-filters').insertAdjacentHTML('afterend', '<div id="control-bulk-bar" class="control-bulk-bar" hidden><strong id="control-bulk-count">0 selezionate</strong><span>Shift + clic seleziona un intervallo</span><button id="control-bulk-verify" type="button">Verifica DSV</button><button id="control-bulk-sync-prestashop" type="button" class="secondary">Allinea stato PrestaShop</button><button id="control-bulk-sync-tracking" type="button" class="secondary"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 8.5v4a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-4M8 1.5v8M5 6.5l3 3 3-3"/></svg><span>Invia tracking a PrestaShop</span></button><button id="control-bulk-export" type="button" class="secondary">Esporta CSV</button><button id="control-bulk-manage" type="button" class="secondary">Segna in lavorazione</button><button id="control-bulk-clear" type="button" class="secondary">Deseleziona</button></div>');
  $('#control-dsv-filter').addEventListener('change', () => { controlPage = 1; refreshControlCenter(); });
  $('#control-date-filter').addEventListener('change', () => { controlPage = 1; refreshControlCenter(); });
  $('#control-clear-filters').addEventListener('click', () => { if ($('#global-tracking-query')) $('#global-tracking-query').value = ''; if ($('#control-search-query')) $('#control-search-query').value = ''; if ($('#control-dsv-filter')) $('#control-dsv-filter').value = ''; if ($('#control-date-filter')) $('#control-date-filter').value = ''; if ($('#control-exceptions')) $('#control-exceptions').checked = false; controlMetricFilter = 'all'; controlPrestaStateFilter = ''; closeControlPrestaFilter(); controlPage = 1; refreshControlCenter(); });
  $('#control-bulk-clear').addEventListener('click', () => { controlSelectedTrackingNumbers.clear(); lastControlSelectedTrackingNumber = ''; refreshControlCenter(); });
  $('#control-bulk-verify').addEventListener('click', () => $('#verify-control-selected').click());
  $('#control-bulk-sync-prestashop').addEventListener('click', openBulkPrestaShopDialog);
  $('#control-bulk-sync-tracking').addEventListener('click', openBulkTrackingDialog);
  $('#control-bulk-export').addEventListener('click', exportSelectedControlRows);
  $('#control-bulk-manage').addEventListener('click', markSelectedAsWorking);
  const tableWrap = card.querySelector('.table-wrap');
  const previousDetail = $('#shipment-detail');
  const detail = document.createElement('dialog');
  detail.id = 'shipment-detail';
  detail.className = 'shipment-detail';
  previousDetail.replaceWith(detail);
  detail.dataset.empty = 'true';
  detail.setAttribute('aria-label', 'Dettaglio spedizione');
  detail.setAttribute('tabindex', '-1');
  const workbench = document.createElement('div');
  workbench.className = 'control-workbench';
  const listPane = document.createElement('div');
  listPane.className = 'control-list-pane';
  tableWrap.parentNode.insertBefore(workbench, tableWrap);
  workbench.append(listPane);
  listPane.append(tableWrap);
  listPane.insertAdjacentHTML('beforeend', '<nav id="control-pager" class="control-pager" aria-label="Paginazione spedizioni" hidden></nav>');
  document.body.append(detail);
  detail.addEventListener('cancel', (event) => { event.preventDefault(); closeControlDetail(); });
  detail.addEventListener('click', (event) => {
    if (event.target !== detail) return;
    const bounds = detail.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeControlDetail();
  });
  detail.addEventListener('keydown', (event) => {
    const isEditing = event.target.matches('input, select, textarea, [contenteditable="true"]');
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && event.target.closest('#shipment-case-form')) {
      event.preventDefault();
      $('#shipment-case-form button:not(:disabled)')?.click();
      return;
    }
    if (isEditing || event.ctrlKey || event.metaKey || event.altKey) return;
    const key = event.key.toLocaleLowerCase('it-IT');
    if (key === 'j') {
      event.preventDefault();
      $('#shipment-detail-next:not(:disabled)')?.click();
    } else if (key === 'k') {
      event.preventDefault();
      $('#shipment-detail-previous:not(:disabled)')?.click();
    } else if (key === 'v') {
      event.preventDefault();
      $('#verify-single-dsv:not(:disabled)')?.click();
    } else if (key === 'u') {
      event.preventDefault();
      $('#update-detail-prestashop-state:not(:disabled)')?.click();
    }
  });
  document.body.insertAdjacentHTML('beforeend', '<dialog id="prestashop-state-dialog" class="prestashop-state-dialog" aria-labelledby="prestashop-state-title"><div id="prestashop-state-form-wrap"><form id="prestashop-state-form"><div class="prestashop-dialog-heading"><div><span>Aggiornamento ordine</span><h3 id="prestashop-state-title">Allinea stato PrestaShop</h3></div><button id="close-prestashop-state" type="button" class="detail-close" aria-label="Chiudi"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg></button></div><div id="prestashop-state-comparison" class="prestashop-state-comparison"></div><label>Nuovo stato PrestaShop<select id="prestashop-target-state" required><option value="">Caricamento stati…</option></select></label><p class="prestashop-dialog-note">Verrà creato un nuovo evento nello storico dell’ordine. L’email al cliente resterà disattivata.</p><p id="prestashop-state-message" class="message" aria-live="polite"></p><div class="prestashop-dialog-actions"><button id="cancel-prestashop-state" type="button" class="secondary">Annulla</button><button id="confirm-prestashop-state" type="submit">Aggiorna PrestaShop</button></div></form></div><div id="prestashop-state-success-wrap" class="prestashop-state-success-card" hidden><div class="prestashop-success-icon-ring"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg></div><div class="prestashop-success-content"><span class="prestashop-success-eyebrow">Operazione completata</span><h3 class="prestashop-success-title">Stato PrestaShop aggiornato!</h3><div id="prestashop-success-badge-slot" class="prestashop-success-badge-slot"></div><p id="prestashop-success-desc" class="prestashop-success-desc"></p></div><div class="prestashop-timer-bar-track"><div id="prestashop-timer-bar-fill" class="prestashop-timer-bar-fill"></div></div><div class="prestashop-dialog-actions prestashop-success-actions"><button id="prestashop-success-close-btn" type="button" class="secondary prestashop-quick-close">Chiudi subito</button></div></div></dialog><dialog id="prestashop-bulk-dialog" class="prestashop-state-dialog prestashop-bulk-dialog" aria-labelledby="prestashop-bulk-title"><div id="prestashop-bulk-form-wrap" class="prestashop-bulk-form-wrap"><div class="prestashop-dialog-heading"><div><span>Aggiornamento massivo ordini</span><h3 id="prestashop-bulk-title">Allinea stati PrestaShop</h3></div><button id="close-prestashop-bulk" type="button" class="detail-close" aria-label="Chiudi"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg></button></div><label class="prestashop-bulk-select-label">Modalità di allineamento stato PrestaShop<select id="prestashop-bulk-state-select" class="prestashop-bulk-state-select"><option value="auto">⚡ Mappatura automatica DSV (consigliata)</option><optgroup id="prestashop-bulk-forced-group" label="Oppure forza uno stato PrestaShop per tutte"></optgroup></select></label><div id="prestashop-bulk-forced-notice" class="prestashop-bulk-forced-notice" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x2="12.01" y1="17" y2="17"/></svg><span><strong>Modalità forzata:</strong> le regole basate sullo stato DSV vengono ignorate. Tutte le spedizioni con ordine verranno impostate sullo stato selezionato.</span></div><div id="prestashop-bulk-preview-content"></div><p class="prestashop-dialog-note">Come per l’aggiornamento singolo, verrà creato un nuovo evento nello storico di ciascun ordine. L’email al cliente resterà disattivata.</p><p id="prestashop-bulk-message" class="message" aria-live="polite"></p><div class="prestashop-dialog-actions"><button id="cancel-prestashop-bulk" type="button" class="secondary">Annulla</button><button id="confirm-prestashop-bulk" type="button">Conferma allineamento</button></div></div><div id="prestashop-bulk-progress-wrap" class="prestashop-bulk-progress-wrap" hidden><svg class="prestashop-bulk-progress-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"></circle><path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round"></path></svg><h3 class="prestashop-bulk-progress-title">Allineamento PrestaShop in corso…</h3><div class="prestashop-bulk-progress-bar-wrap"><div class="prestashop-bulk-progress-labels"><span id="prestashop-bulk-progress-text">0 di 0</span><span id="prestashop-bulk-progress-percent">0%</span></div><div class="prestashop-bulk-progress-track"><div id="prestashop-bulk-progress-bar" class="prestashop-bulk-progress-bar"></div></div></div><p id="prestashop-bulk-progress-info" class="prestashop-bulk-progress-info">Preparazione aggiornamenti…</p></div><div id="prestashop-bulk-success-wrap" class="prestashop-state-success-card" hidden><div class="prestashop-success-icon-ring"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg></div><div class="prestashop-success-content"><span class="prestashop-success-eyebrow">Operazione completata</span><h3 class="prestashop-success-title" id="prestashop-bulk-success-title">Allineamento completato!</h3><p id="prestashop-bulk-success-desc" class="prestashop-success-desc"></p><div id="prestashop-bulk-errors-box" class="prestashop-bulk-errors" hidden></div></div><div class="prestashop-timer-bar-track"><div id="prestashop-bulk-timer-bar-fill" class="prestashop-timer-bar-fill"></div></div><div class="prestashop-dialog-actions prestashop-success-actions"><button id="prestashop-bulk-success-close-btn" type="button" class="secondary prestashop-quick-close">Chiudi subito</button></div></div></dialog>');
  document.body.insertAdjacentHTML('beforeend', `
    <dialog id="control-bulk-tracking-dialog" class="prestashop-state-dialog control-bulk-tracking-dialog" aria-labelledby="control-bulk-tracking-title">
      <div id="control-bulk-tracking-form" class="control-bulk-tracking-form">
        <div class="prestashop-dialog-heading"><div><h3 id="control-bulk-tracking-title">Invia tracking a PrestaShop</h3><p>Controlla l’impatto prima di aggiornare gli ordini selezionati.</p></div><button id="close-control-bulk-tracking" type="button" class="detail-close" aria-label="Chiudi"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg></button></div>
        <div class="control-bulk-tracking-body">
          <section class="control-bulk-impact" aria-labelledby="control-bulk-impact-title"><h4 id="control-bulk-impact-title">Impatto dell’operazione</h4><div id="control-bulk-tracking-kpis" class="control-bulk-impact-grid"></div><p id="control-bulk-tracking-summary">Nessun ordine verrà modificato.</p></section>
          <label class="control-bulk-option"><input id="control-bulk-tracking-protect" type="checkbox" checked><span><strong>Non sovrascrivere tracking differenti <em>Consigliato</em></strong><small>Gli ordini che contengono già un altro tracking resteranno invariati.</small></span></label>
          <fieldset class="control-bulk-carrier-mode"><legend>Corriere</legend><label><input type="radio" name="control-bulk-carrier-mode" value="preserve" checked><span><strong>Mantieni il corriere attuale</strong><small>Modifica soltanto il tracking.</small></span></label><label><input type="radio" name="control-bulk-carrier-mode" value="change"><span><strong>Imposta lo stesso corriere sugli ordini aggiornati</strong><small>Usa anche corrieri presenti ma disattivati.</small></span></label></fieldset>
          <label id="control-bulk-tracking-carrier-wrap" class="control-bulk-carrier-wrap" hidden>Corriere PrestaShop<select id="control-bulk-tracking-carrier"><option value="">Caricamento corrieri…</option></select><small id="control-bulk-tracking-carrier-status"></small></label>
          <section class="control-bulk-review" aria-labelledby="control-bulk-review-title"><div class="control-bulk-review-heading"><h4 id="control-bulk-review-title">Revisione spedizioni</h4><div id="control-bulk-tracking-filters" class="control-bulk-tracking-filters" aria-label="Filtra spedizioni"></div></div><div id="control-bulk-tracking-preview" class="control-bulk-tracking-preview" role="list"></div></section>
          <p id="control-bulk-tracking-message" class="message" aria-live="polite"></p>
        </div>
        <div class="prestashop-dialog-actions control-bulk-tracking-actions"><p id="control-bulk-tracking-footer-note">Gli ordini già sincronizzati non verranno modificati.</p><button id="cancel-control-bulk-tracking" type="button" class="secondary">Annulla</button><button id="confirm-control-bulk-tracking" type="button">Nessun aggiornamento necessario</button></div>
      </div>
      <div id="control-bulk-tracking-progress" class="control-bulk-tracking-result" hidden aria-live="polite"><h3>Invio tracking in corso…</h3><div class="control-bulk-progress-head"><span id="control-bulk-tracking-progress-text">0 di 0</span><strong id="control-bulk-tracking-progress-percent">0%</strong></div><div id="control-bulk-tracking-progress-track" class="control-bulk-progress-track" role="progressbar" aria-label="Avanzamento invio tracking" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div id="control-bulk-tracking-progress-bar"></div></div><p id="control-bulk-tracking-current" role="status"></p><div id="control-bulk-tracking-log" class="control-bulk-tracking-log" aria-label="Esiti elaborazione"></div><div class="prestashop-dialog-actions"><button id="stop-control-bulk-tracking" type="button" class="secondary">Interrompi dopo questa riga</button></div></div>
      <div id="control-bulk-tracking-result" class="control-bulk-tracking-result" hidden role="status" aria-live="polite" tabindex="-1"><span class="prestashop-success-eyebrow">Operazione completata</span><h3 id="control-bulk-tracking-result-title">Tracking sincronizzati</h3><div id="control-bulk-tracking-result-kpis" class="control-bulk-tracking-result-kpis"></div><div id="control-bulk-tracking-errors" class="prestashop-bulk-errors" hidden></div><div class="prestashop-dialog-actions"><button id="retry-control-bulk-tracking" type="button" hidden>Riprova errori</button><button id="finish-control-bulk-tracking" type="button" class="secondary">Chiudi e aggiorna</button></div></div>
    </dialog>`);
  setupBulkTrackingDialog();
  document.body.insertAdjacentHTML('beforeend', `
    <dialog id="prestashop-link-dialog" class="prestashop-state-dialog prestashop-link-dialog" aria-labelledby="prestashop-link-title">
      <form id="prestashop-link-form">
        <div class="prestashop-dialog-heading">
          <div><span>Associazione locale</span><h3 id="prestashop-link-title">Collega ordine PrestaShop</h3></div>
          <button id="close-prestashop-link" type="button" class="detail-close" aria-label="Chiudi"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg></button>
        </div>
        <p class="prestashop-dialog-note">Cerca l’ordine tramite ID o riferimento. Il collegamento aggiorna solo il tracking center: nessun dato verrà scritto su PrestaShop.</p>
        <label for="prestashop-link-query">ID ordine o riferimento PrestaShop</label>
        <div class="prestashop-link-search"><input id="prestashop-link-query" maxlength="120" autocomplete="off" required placeholder="Es. 216503 oppure OSFYILXVG"><button id="preview-prestashop-link" type="submit">Cerca ordine</button></div>
        <p id="prestashop-link-message" class="message" role="status" aria-live="polite"></p>
        <div id="prestashop-link-candidate" class="prestashop-link-candidate" hidden></div>
        <label id="prestashop-link-mismatch-wrap" class="prestashop-link-mismatch" hidden><input id="prestashop-link-mismatch" type="checkbox"><span>Ho verificato che il tracking diverso appartiene comunque a questo ordine.</span></label>
        <div class="prestashop-dialog-actions"><button id="cancel-prestashop-link" type="button" class="secondary">Annulla</button><button id="confirm-prestashop-link" type="button" disabled>Collega ordine</button></div>
      </form>
    </dialog>
    <dialog id="delete-shipment-dialog" class="prestashop-state-dialog delete-shipment-dialog" aria-labelledby="delete-shipment-title">
      <form method="dialog">
        <div class="prestashop-dialog-heading"><div><span>Operazione irreversibile</span><h3 id="delete-shipment-title">Elimina spedizione archiviata</h3></div><button id="close-delete-shipment" type="button" class="detail-close" aria-label="Chiudi"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg></button></div>
        <p id="delete-shipment-description" class="delete-shipment-description"></p>
        <p class="delete-shipment-warning">Saranno rimossi dal database locale stato, storico DSV e attività interna. PrestaShop non verrà modificato.</p>
        <p id="delete-shipment-message" class="message" role="status" aria-live="polite"></p>
        <div class="prestashop-dialog-actions"><button id="cancel-delete-shipment" type="button" class="secondary">Annulla</button><button id="confirm-delete-shipment" type="button" class="danger-button">Elimina definitivamente</button></div>
      </form>
    </dialog>`);
  
  $('#prestashop-success-close-btn')?.insertAdjacentHTML('afterend', '<button id="prestashop-success-next-btn" type="button" hidden>Prossima da gestire</button>');
  const prestashopDialog = $('#prestashop-state-dialog');
  const closePrestaShopDialog = () => {
    if (prestashopSuccessTimeout) {
      clearTimeout(prestashopSuccessTimeout);
      prestashopSuccessTimeout = null;
    }
    prestashopDialog.close();
  };
  $('#close-prestashop-state').addEventListener('click', closePrestaShopDialog);
  $('#cancel-prestashop-state').addEventListener('click', closePrestaShopDialog);
  prestashopDialog.addEventListener('cancel', closePrestaShopDialog);
  prestashopDialog.addEventListener('click', (event) => {
    if (event.target !== prestashopDialog) return;
    const bounds = prestashopDialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
      closePrestaShopDialog();
    }
  });
  $('#prestashop-state-form').addEventListener('submit', updatePrestaShopState);

  const prestashopLinkDialog = $('#prestashop-link-dialog');
  const closePrestaShopLinkDialog = () => prestashopLinkDialog?.close();
  $('#close-prestashop-link')?.addEventListener('click', closePrestaShopLinkDialog);
  $('#cancel-prestashop-link')?.addEventListener('click', closePrestaShopLinkDialog);
  prestashopLinkDialog?.addEventListener('cancel', closePrestaShopLinkDialog);
  $('#prestashop-link-form')?.addEventListener('submit', previewPrestaShopOrderLink);
  $('#prestashop-link-query')?.addEventListener('input', resetPrestaShopLinkPreview);
  $('#prestashop-link-mismatch')?.addEventListener('change', updatePrestaShopLinkConfirmation);
  $('#confirm-prestashop-link')?.addEventListener('click', confirmPrestaShopOrderLink);

  const deleteShipmentDialog = $('#delete-shipment-dialog');
  const closeDeleteShipmentDialog = () => deleteShipmentDialog?.close();
  $('#close-delete-shipment')?.addEventListener('click', closeDeleteShipmentDialog);
  $('#cancel-delete-shipment')?.addEventListener('click', closeDeleteShipmentDialog);
  deleteShipmentDialog?.addEventListener('cancel', closeDeleteShipmentDialog);
  $('#confirm-delete-shipment')?.addEventListener('click', deleteArchivedShipmentFromControl);

  const prestashopBulkDialog = $('#prestashop-bulk-dialog');
  const closePrestaShopBulkDialog = () => {
    if (prestashopBulkRunning) return;
    if (prestashopBulkSuccessTimeout) {
      clearTimeout(prestashopBulkSuccessTimeout);
      prestashopBulkSuccessTimeout = null;
    }
    prestashopBulkDialog?.close();
  };
  $('#close-prestashop-bulk')?.addEventListener('click', closePrestaShopBulkDialog);
  $('#cancel-prestashop-bulk')?.addEventListener('click', closePrestaShopBulkDialog);
  prestashopBulkDialog?.addEventListener('cancel', (e) => {
    if (prestashopBulkRunning) { e.preventDefault(); return; }
    closePrestaShopBulkDialog();
  });
  prestashopBulkDialog?.addEventListener('click', (event) => {
    if (prestashopBulkRunning) return;
    if (event.target !== prestashopBulkDialog) return;
    const bounds = prestashopBulkDialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
      closePrestaShopBulkDialog();
    }
  });
  $('#prestashop-bulk-state-select')?.addEventListener('change', () => {
    renderBulkPreview();
  });

  const reportDialog = $('#verification-report-dialog');
  $('#close-verification-report')?.addEventListener('click', () => reportDialog?.close());
  $('#dismiss-verification-report')?.addEventListener('click', () => reportDialog?.close());
  $('#export-verification-report')?.addEventListener('click', exportVerificationReportCsv);
  $('#open-last-report-btn')?.addEventListener('click', () => openVerificationReportDialog());
  reportDialog?.addEventListener('cancel', () => reportDialog.close());
  reportDialog?.addEventListener('click', (event) => {
    if (event.target !== reportDialog) return;
    const bounds = reportDialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) reportDialog.close();
  });
  $('#report-filters')?.addEventListener('click', (event) => {
    const btn = event.target.closest('.report-filter-btn');
    if (!btn) return;
    activeReportFilter = btn.dataset.reportFilter;
    openVerificationReportDialog(activeReportFilter);
  });
  $('#report-search-input')?.addEventListener('input', (event) => {
    reportSearchQuery = event.target.value;
    renderReportTableRows();
  });
  $('#report-table tbody')?.addEventListener('click', (event) => {
    const btn = event.target.closest('.open-shipment-from-report');
    if (!btn) return;
    const tracking = btn.dataset.tracking;
    if (tracking) {
      reportDialog?.close();
      void openShipmentDetail(tracking);
    }
  });
}

let prestashopSuccessTimeout = null;
let prestashopBulkSuccessTimeout = null;
let prestashopBulkRunning = false;

function showFloatingToast(message, type = 'success') {
  let container = $('#toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    container.setAttribute('aria-live', 'polite');
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `toast-pill toast-${type}`;
  const iconSvg = type === 'success'
    ? '<svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16zm3.857-9.809a.75.75 0 0 0-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 1 0-1.06 1.061l2.5 2.5a.75.75 0 0 0 1.137-.089l4-5.5z" clip-rule="evenodd"/></svg>'
    : '<svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0zm-7-4a1 1 0 1 1-2 0 1 1 0 0 1 2 0zM9 9a.75.75 0 0 0 0 1.5h.253a.25.25 0 0 1 .244.304l-.459 2.066A1.75 1.75 0 0 0 10.747 15H11a.75.75 0 0 0 0-1.5h-.253a.25.25 0 0 1-.244-.304l.459-2.066A1.75 1.75 0 0 0 9.253 9H9z" clip-rule="evenodd"/></svg>';

  toast.innerHTML = `<span class="toast-pill-icon">${iconSvg}</span><span class="toast-pill-text">${escapeHtml(message)}</span>`;
  container.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.add('visible');
  });

  setTimeout(() => {
    toast.classList.remove('visible');
    toast.classList.add('hiding');
    setTimeout(() => toast.remove(), 250);
  }, 3200);
}

function highlightControlRow(trackingNumber) {
  if (!trackingNumber) return;
  const row = $(`#control-table tbody tr[data-tracking="${CSS.escape(trackingNumber)}"]`);
  if (row) {
    row.classList.remove('row-highlight-updated');
    void row.offsetWidth;
    row.classList.add('row-highlight-updated');
    row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    setTimeout(() => row.classList.remove('row-highlight-updated'), 2800);
  }
}

function shipmentDetailNavigation(trackingNumber) {
  const rows = controlRecords.filter((row) => row.trackingNumber);
  const index = rows.findIndex((row) => row.trackingNumber === trackingNumber);
  return {
    index,
    total: rows.length,
    previous: index > 0 ? rows[index - 1]?.trackingNumber : '',
    next: index >= 0 && index < rows.length - 1 ? rows[index + 1]?.trackingNumber : '',
  };
}

function nextAttentionTracking(trackingNumber) {
  const rows = controlRecords.filter((row) => row.trackingNumber && !row.archived);
  if (rows.length < 2) return '';
  const start = Math.max(0, rows.findIndex((row) => row.trackingNumber === trackingNumber));
  for (let offset = 1; offset < rows.length; offset += 1) {
    const row = rows[(start + offset) % rows.length];
    if (row.operationalStatus === 'Da gestire' || (row.orderId && !isPrestaShopStateAligned(row))) return row.trackingNumber;
  }
  return '';
}

function resetPrestaShopLinkPreview() {
  prestaShopLinkCandidate = null;
  const candidate = $('#prestashop-link-candidate');
  if (candidate) {
    candidate.hidden = true;
    candidate.innerHTML = '';
  }
  $('#prestashop-link-mismatch-wrap').hidden = true;
  $('#prestashop-link-mismatch').checked = false;
  $('#confirm-prestashop-link').disabled = true;
  $('#prestashop-link-message').textContent = '';
  $('#prestashop-link-message').className = 'message';
}

function updatePrestaShopLinkConfirmation() {
  const needsAcknowledgement = Boolean(prestaShopLinkCandidate?.trackingConflict);
  $('#confirm-prestashop-link').disabled = !prestaShopLinkCandidate || (needsAcknowledgement && !$('#prestashop-link-mismatch').checked);
}

function openPrestaShopLinkDialog(shipment, initialQuery = '') {
  prestaShopLinkTracking = shipment.trackingNumber;
  resetPrestaShopLinkPreview();
  const query = String(initialQuery || shipment.orderReference || '').trim();
  $('#prestashop-link-query').value = query;
  $('#prestashop-link-dialog').showModal();
  setTimeout(() => $('#prestashop-link-query').focus(), 0);
}

async function previewPrestaShopOrderLink(event) {
  event.preventDefault();
  if (!prestaShopLinkTracking) return;
  resetPrestaShopLinkPreview();
  const button = $('#preview-prestashop-link');
  const query = $('#prestashop-link-query').value.trim();
  if (!query) return;
  button.disabled = true;
  button.textContent = 'Ricerca…';
  $('#prestashop-link-message').textContent = 'Verifica dell’ordine su PrestaShop in corso…';
  try {
    const result = await request(`/api/control-center/${encodeURIComponent(prestaShopLinkTracking)}/prestashop-link/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    prestaShopLinkCandidate = result.candidate;
    const candidate = result.candidate;
    const trackingLabel = candidate.trackingNumber || 'Nessun tracking registrato';
    const trackingStatus = candidate.trackingConflict
      ? '<span class="link-check-status conflict">Tracking diverso</span>'
      : candidate.trackingMatches
        ? '<span class="link-check-status match">Tracking corrispondente</span>'
        : '<span class="link-check-status neutral">Tracking assente</span>';
    const candidatePanel = $('#prestashop-link-candidate');
    candidatePanel.innerHTML = `<div class="prestashop-link-candidate-heading"><strong>Ordine trovato</strong>${trackingStatus}</div><dl><div><dt>Riferimento</dt><dd>${escapeHtml(candidate.orderReference || '—')}</dd></div><div><dt>ID ordine</dt><dd>${escapeHtml(candidate.orderId)}</dd></div><div><dt>Stato PrestaShop</dt><dd>${escapeHtml(candidate.currentStateName || 'Non disponibile')}</dd></div><div><dt>Tracking associato</dt><dd>${escapeHtml(trackingLabel)}</dd></div><div><dt>Corriere</dt><dd>${escapeHtml(candidate.carrierName || 'Non assegnato')}</dd></div></dl>`;
    candidatePanel.hidden = false;
    $('#prestashop-link-mismatch-wrap').hidden = !candidate.trackingConflict;
    $('#prestashop-link-message').textContent = candidate.trackingConflict
      ? 'Il tracking dell’ordine è diverso: verifica l’associazione prima di confermare.'
      : 'Ordine verificato. Puoi registrare il collegamento locale.';
    $('#prestashop-link-message').className = `message ${candidate.trackingConflict ? 'error' : 'success'}`;
    updatePrestaShopLinkConfirmation();
  } catch (error) {
    $('#prestashop-link-message').textContent = `${error.message} Controlla ID o riferimento e riprova.`;
    $('#prestashop-link-message').className = 'message error';
  } finally {
    button.disabled = false;
    button.textContent = 'Cerca ordine';
  }
}

async function confirmPrestaShopOrderLink() {
  if (!prestaShopLinkCandidate || !prestaShopLinkTracking) return;
  const button = $('#confirm-prestashop-link');
  button.disabled = true;
  button.textContent = 'Collegamento…';
  try {
    const result = await request(`/api/control-center/${encodeURIComponent(prestaShopLinkTracking)}/prestashop-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: $('#prestashop-link-query').value.trim(),
        allowTrackingMismatch: $('#prestashop-link-mismatch').checked,
      }),
    });
    const tracking = prestaShopLinkTracking;
    $('#prestashop-link-dialog').close();
    showFloatingToast(result.message, 'success');
    await refreshControlCenter();
    await openShipmentDetail(tracking, { message: result.message, kind: 'success' });
  } catch (error) {
    $('#prestashop-link-message').textContent = error.message;
    $('#prestashop-link-message').className = 'message error';
    updatePrestaShopLinkConfirmation();
  } finally {
    button.textContent = 'Collega ordine';
  }
}

function openDeleteShipmentDialog(shipment) {
  if (!shipment.archived) return;
  const dialog = $('#delete-shipment-dialog');
  dialog.dataset.tracking = shipment.trackingNumber;
  $('#delete-shipment-description').innerHTML = `Stai per eliminare definitivamente la spedizione <strong>${escapeHtml(shipment.trackingNumber)}</strong>.`;
  $('#delete-shipment-message').textContent = '';
  $('#delete-shipment-message').className = 'message';
  $('#confirm-delete-shipment').disabled = false;
  dialog.showModal();
}

async function deleteArchivedShipmentFromControl() {
  const dialog = $('#delete-shipment-dialog');
  const tracking = dialog.dataset.tracking;
  if (!tracking) return;
  const button = $('#confirm-delete-shipment');
  button.disabled = true;
  button.textContent = 'Eliminazione…';
  try {
    const result = await request(`/api/control-center/${encodeURIComponent(tracking)}`, { method: 'DELETE' });
    dialog.close();
    closeControlDetail({ force: true });
    await refreshControlCenter();
    showFloatingToast(result.message, 'success');
  } catch (error) {
    $('#delete-shipment-message').textContent = error.message;
    $('#delete-shipment-message').className = 'message error';
  } finally {
    button.disabled = false;
    button.textContent = 'Elimina definitivamente';
  }
}

async function openPrestaShopStateDialog(trackingNumber) {
  const shipment = controlRecords.find((row) => row.trackingNumber === trackingNumber) || await request(`/api/control-center/${encodeURIComponent(trackingNumber)}`);
  const dialog = $('#prestashop-state-dialog');
  const select = $('#prestashop-target-state');
  prestaShopStateTracking = trackingNumber;

  if (prestashopSuccessTimeout) {
    clearTimeout(prestashopSuccessTimeout);
    prestashopSuccessTimeout = null;
  }
  $('#prestashop-state-form-wrap').hidden = false;
  $('#prestashop-state-success-wrap').hidden = true;
  $('#prestashop-success-next-btn').hidden = true;
  const confirmBtn = $('#confirm-prestashop-state');
  confirmBtn.disabled = false;
  confirmBtn.innerHTML = 'Aggiorna PrestaShop';
  $('#cancel-prestashop-state').disabled = false;

  $('#prestashop-state-comparison').innerHTML = `<div><span>Stato DSV</span>${dsvBadge(shipment.dsvStatus)}</div><div><span>Stato PrestaShop attuale</span>${prestaShopBadge(shipment.currentState)}</div>`;
  $('#prestashop-state-message').textContent = '';
  $('#prestashop-state-message').className = 'message';
  select.disabled = true;
  select.innerHTML = '<option value="">Caricamento stati…</option>';
  dialog.showModal();
  try {
    if (!prestaShopStateCatalog) prestaShopStateCatalog = (await request('/api/catalog')).statuses || [];
    select.innerHTML = '<option value="">Seleziona lo stato di destinazione</option>' + prestaShopStateCatalog.map((state) => `<option value="${escapeHtml(state.id)}">${escapeHtml(state.name)}</option>`).join('');
    const mapped = mappedPrestaShopState(shipment);
    const suggestion = mapped?.stateId || suggestedPrestaShopStateId(shipment.dsvStatus, prestaShopStateCatalog);
    if (suggestion) {
      select.value = suggestion;
      $('#prestashop-state-message').textContent = mapped ? `Mappatura configurata: ${mapped.stateName}. Verifica prima di confermare.` : 'È stato preselezionato lo stato più vicino alla fase DSV. Verificalo prima di confermare.';
    }
    select.disabled = false;
    select.focus();
  } catch (error) {
    $('#prestashop-state-message').textContent = error.message;
    $('#prestashop-state-message').className = 'message error';
  }
}

async function updatePrestaShopState(event) {
  event.preventDefault();
  const select = $('#prestashop-target-state');
  const stateId = select.value;
  if (!stateId || !prestaShopStateTracking) return;
  const tracking = prestaShopStateTracking;
  const selectedStateName = select.options[select.selectedIndex]?.text || '';
  const button = $('#confirm-prestashop-state');
  const cancelBtn = $('#cancel-prestashop-state');

  button.disabled = true;
  button.innerHTML = '<span class="button-spinner-inline"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"></circle><path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round"></path></svg> <span>Aggiornamento in corso…</span></span>';
  select.disabled = true;
  cancelBtn.disabled = true;
  $('#prestashop-state-message').className = 'message';
  $('#prestashop-state-message').textContent = '';

  try {
    const result = await request(`/api/control-center/${encodeURIComponent(tracking)}/prestashop-state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stateId })
    });

    // Mostra schermata di successo nel popup
    $('#prestashop-state-form-wrap').hidden = true;
    const successWrap = $('#prestashop-state-success-wrap');
    successWrap.hidden = false;

    $('#prestashop-success-badge-slot').innerHTML = prestaShopBadge(selectedStateName);
    $('#prestashop-success-desc').textContent = result.message || `Ordine aggiornato allo stato “${selectedStateName}”. Nessuna email inviata.`;

    const nextTracking = nextAttentionTracking(tracking);
    const timerFill = $('#prestashop-timer-bar-fill');
    timerFill.style.setProperty('--prestashop-success-duration', nextTracking ? '5s' : '1.5s');
    timerFill.classList.remove('active');
    void timerFill.offsetWidth;
    timerFill.classList.add('active');

    let finished = false;
    const nextButton = $('#prestashop-success-next-btn');
    nextButton.hidden = !nextTracking;

    const finishAndUpdate = async (destinationTracking = '') => {
      if (finished) return;
      finished = true;
      if (prestashopSuccessTimeout) {
        clearTimeout(prestashopSuccessTimeout);
        prestashopSuccessTimeout = null;
      }
      const dialog = $('#prestashop-state-dialog');
      if (dialog.open) dialog.close();

      // Mostra toast fluttuante
      showFloatingToast(result.message || `Stato PrestaShop aggiornato a “${selectedStateName}”`, 'success');

      // Aggiorna tabella centro di controllo
      await refreshControlCenter();

      // Evidenzia la riga aggiornata
      highlightControlRow(tracking);

      // Se il dettaglio della spedizione è aperto, ricarica i dati
      if (destinationTracking) {
        await openShipmentDetail(destinationTracking, { message: `Ordine precedente aggiornato a “${selectedStateName}”.`, kind: 'success' });
      } else if (activeControlTrackingNumber === tracking) {
        await openShipmentDetail(tracking, { message: `Stato PrestaShop aggiornato a “${selectedStateName}”.`, kind: 'success' });
      }
    };

    $('#prestashop-success-close-btn').onclick = () => finishAndUpdate();
    nextButton.onclick = () => finishAndUpdate(nextTracking);
    prestashopSuccessTimeout = setTimeout(finishAndUpdate, nextTracking ? 5000 : 1500);

  } catch (error) {
    button.disabled = false;
    button.innerHTML = 'Aggiorna PrestaShop';
    select.disabled = false;
    cancelBtn.disabled = false;
    $('#prestashop-state-message').className = 'message error';
    $('#prestashop-state-message').textContent = error.message;
  }
}

function categorizeSelectedShipments(forcedState = null) {
  const selectedRows = controlRecords.filter((row) => controlSelectedTrackingNumbers.has(row.trackingNumber));
  const actionable = [];
  const skippedAlreadyAligned = [];
  const skippedNoOrder = [];
  const skippedUnmapped = [];
  const skippedDuplicateOrders = [];
  const actionableOrderIds = new Set();

  for (const row of selectedRows) {
    if (!row.orderId) {
      skippedNoOrder.push(row);
      continue;
    }

    if (forcedState) {
      const sameStateId = row.prestaStateId && String(row.prestaStateId) === String(forcedState.id);
      const sameStateName = normalizedStateLabel(row.currentState) === normalizedStateLabel(forcedState.name);
      if (sameStateId || sameStateName) {
        skippedAlreadyAligned.push(row);
        continue;
      }
      if (actionableOrderIds.has(String(row.orderId))) {
        skippedDuplicateOrders.push(row);
        continue;
      }
      actionableOrderIds.add(String(row.orderId));
      actionable.push({
        shipment: row,
        targetStateId: String(forcedState.id),
        targetStateName: forcedState.name,
      });
    } else {
      const mapped = mappedPrestaShopState(row);
      if (!mapped || !mapped.stateId) {
        skippedUnmapped.push(row);
        continue;
      }
      if (isPrestaShopStateAligned(row)) {
        skippedAlreadyAligned.push(row);
        continue;
      }
      if (actionableOrderIds.has(String(row.orderId))) {
        skippedDuplicateOrders.push(row);
        continue;
      }
      actionableOrderIds.add(String(row.orderId));
      actionable.push({
        shipment: row,
        targetStateId: String(mapped.stateId),
        targetStateName: mapped.stateName,
      });
    }
  }

  return { selectedRows, actionable, skippedAlreadyAligned, skippedNoOrder, skippedUnmapped, skippedDuplicateOrders };
}

function renderBulkPreview() {
  const select = $('#prestashop-bulk-state-select');
  const mode = select?.value || 'auto';
  let forcedState = null;
  if (mode !== 'auto' && prestaShopStateCatalog) {
    forcedState = prestaShopStateCatalog.find((s) => String(s.id) === String(mode)) || null;
  }

  const { actionable, skippedAlreadyAligned, skippedNoOrder, skippedUnmapped, skippedDuplicateOrders } = categorizeSelectedShipments(forcedState);

  const isForced = Boolean(forcedState);
  const notice = $('#prestashop-bulk-forced-notice');
  if (notice) notice.hidden = !isForced;

  const targetGroups = {};
  for (const item of actionable) {
    targetGroups[item.targetStateName] = (targetGroups[item.targetStateName] || 0) + 1;
  }

  const skippedTotal = skippedAlreadyAligned.length + skippedNoOrder.length + skippedUnmapped.length + skippedDuplicateOrders.length;

  let previewHtml = `
    <div class="prestashop-bulk-cards">
      <div class="prestashop-bulk-card actionable">
        <div class="prestashop-bulk-card-header">
          <span class="prestashop-bulk-card-title">${isForced ? 'Pronte per la forzatura' : 'Pronte per l’aggiornamento'}</span>
          <span class="prestashop-bulk-card-count">${actionable.length}</span>
        </div>
        <div class="prestashop-bulk-list">
          ${actionable.length ? Object.entries(targetGroups).map(([stateName, count]) => `
            <div class="prestashop-bulk-item">
              <span>${count} spedizion${count === 1 ? 'e' : 'i'}</span>
              <strong>→ ${escapeHtml(stateName)}</strong>
            </div>
          `).join('') : '<span class="prestashop-bulk-empty-note">Nessuna spedizione idonea</span>'}
        </div>
      </div>
      <div class="prestashop-bulk-card skipped">
        <div class="prestashop-bulk-card-header">
          <span class="prestashop-bulk-card-title">Saranno saltate</span>
          <span class="prestashop-bulk-card-count">${skippedTotal}</span>
        </div>
        <div class="prestashop-bulk-list">
          ${skippedAlreadyAligned.length ? `<div class="prestashop-bulk-item"><span>${isForced ? 'Già in questo stato' : 'Già allineate'}</span><strong>${skippedAlreadyAligned.length}</strong></div>` : ''}
          ${skippedDuplicateOrders.length ? `<div class="prestashop-bulk-item"><span>Duplicati dello stesso ordine</span><strong>${skippedDuplicateOrders.length}</strong></div>` : ''}
          ${skippedNoOrder.length ? `<div class="prestashop-bulk-item"><span>Senza ordine PrestaShop</span><strong>${skippedNoOrder.length}</strong></div>` : ''}
          ${skippedUnmapped.length ? `<div class="prestashop-bulk-item"><span>Stato DSV non mappato</span><strong>${skippedUnmapped.length}</strong></div>` : ''}
          ${skippedTotal === 0 ? '<span class="prestashop-bulk-empty-note">Nessuna esclusa</span>' : ''}
        </div>
      </div>
    </div>
  `;

  $('#prestashop-bulk-preview-content').innerHTML = previewHtml;
  $('#prestashop-bulk-message').className = 'message';
  if (actionable.length === 0) {
    $('#prestashop-bulk-message').textContent = isForced 
      ? `Tutte le spedizioni selezionate sono già nello stato “${forcedState.name}” o non hanno un ordine PrestaShop.`
      : 'Nessuna delle spedizioni selezionate richiede un aggiornamento con le mappature attuali.';
  } else {
    $('#prestashop-bulk-message').textContent = isForced
      ? `Verrà forzato lo stato “${forcedState.name}” su ${actionable.length} ordin${actionable.length === 1 ? 'e' : 'i'} in sequenza.`
      : `Verranno aggiornati ${actionable.length} ordin${actionable.length === 1 ? 'e' : 'i'} PrestaShop in sequenza.`;
  }

  const confirmBtn = $('#confirm-prestashop-bulk');
  confirmBtn.disabled = actionable.length === 0;
  confirmBtn.textContent = actionable.length
    ? (isForced ? `Forza stato “${forcedState.name}” (${actionable.length})` : `Allinea ${actionable.length} ordin${actionable.length === 1 ? 'e' : 'i'}`)
    : 'Nessun ordine da aggiornare';

  confirmBtn.onclick = () => executeBulkPrestaShopSync(actionable);
}

async function openBulkPrestaShopDialog() {
  const selectedRows = controlRecords.filter((row) => controlSelectedTrackingNumbers.has(row.trackingNumber));
  if (!selectedRows.length) return;

  const dialog = $('#prestashop-bulk-dialog');
  if (!dialog) return;

  $('#prestashop-bulk-form-wrap').hidden = false;
  $('#prestashop-bulk-progress-wrap').hidden = true;
  $('#prestashop-bulk-success-wrap').hidden = true;

  if (!prestaShopStateCatalog) {
    try {
      prestaShopStateCatalog = (await request('/api/catalog')).statuses || [];
    } catch (e) {
      prestaShopStateCatalog = [];
    }
  }

  const forcedGroup = $('#prestashop-bulk-forced-group');
  if (forcedGroup && prestaShopStateCatalog?.length) {
    forcedGroup.innerHTML = prestaShopStateCatalog.map((state) => 
      `<option value="${escapeHtml(state.id)}">${escapeHtml(state.name)}</option>`
    ).join('');
  }

  const modeSelect = $('#prestashop-bulk-state-select');
  if (modeSelect) modeSelect.value = 'auto';

  renderBulkPreview();

  if (!dialog.open) dialog.showModal();
}

async function executeBulkPrestaShopSync(actionableList) {
  if (!actionableList.length || prestashopBulkRunning) return;

  prestashopBulkRunning = true;
  $('#prestashop-bulk-form-wrap').hidden = true;
  $('#prestashop-bulk-progress-wrap').hidden = false;
  $('#prestashop-bulk-success-wrap').hidden = true;

  const total = actionableList.length;
  let completed = 0;
  const successfulTrackings = [];
  const failedItems = [];

  const updateProgressBar = (current, infoText) => {
    const percent = Math.round((current / total) * 100);
    $('#prestashop-bulk-progress-text').textContent = `${current} di ${total}`;
    $('#prestashop-bulk-progress-percent').textContent = `${percent}%`;
    $('#prestashop-bulk-progress-bar').style.width = `${percent}%`;
    $('#prestashop-bulk-progress-info').textContent = infoText || '';
  };

  updateProgressBar(0, `Inizio allineamento di ${total} ordini…`);

  for (let i = 0; i < actionableList.length; i++) {
    const item = actionableList[i];
    const tracking = item.shipment.trackingNumber;
    const orderRef = item.shipment.orderReference || item.shipment.orderId || tracking;
    const stateId = item.targetStateId;
    const stateName = item.targetStateName;

    updateProgressBar(completed, `Aggiornamento ordine ${orderRef} (${i + 1}/${total}) → ${stateName}…`);

    try {
      await request(`/api/control-center/${encodeURIComponent(tracking)}/prestashop-state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stateId })
      });
      successfulTrackings.push(tracking);
      controlSelectedTrackingNumbers.delete(tracking);
    } catch (err) {
      failedItems.push({
        tracking,
        orderReference: orderRef,
        error: err.message || 'Errore durante l’aggiornamento',
      });
    }

    completed++;
    updateProgressBar(completed, `Completato ${orderRef}`);

    if (i < actionableList.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }

  prestashopBulkRunning = false;

  $('#prestashop-bulk-progress-wrap').hidden = true;
  $('#prestashop-bulk-success-wrap').hidden = false;

  const successCount = successfulTrackings.length;
  const failCount = failedItems.length;

  $('#prestashop-bulk-success-title').textContent = failCount === 0
    ? 'Allineamento completato!'
    : `${successCount} aggiornati, ${failCount} non riusciti`;

  let desc = `${successCount} ordin${successCount === 1 ? 'e' : 'i'} aggiornat${successCount === 1 ? 'o' : 'i'} con successo su PrestaShop.`;
  if (failCount > 0) {
    desc += ` Le ${failCount} spedizioni con errore restano selezionate per consentirti di verificare.`;
  }
  $('#prestashop-bulk-success-desc').textContent = desc;

  const errorsBox = $('#prestashop-bulk-errors-box');
  if (failCount > 0) {
    errorsBox.hidden = false;
    errorsBox.innerHTML = failedItems.map((f) => `<div><strong>${escapeHtml(f.orderReference)} (${escapeHtml(f.tracking)}):</strong> ${escapeHtml(f.error)}</div>`).join('');
  } else {
    errorsBox.hidden = true;
    errorsBox.innerHTML = '';
  }

  const timerFill = $('#prestashop-bulk-timer-bar-fill');
  timerFill.classList.remove('active');
  void timerFill.offsetWidth;
  timerFill.classList.add('active');

  let finished = false;
  const finishAndUpdate = async () => {
    if (finished) return;
    finished = true;
    if (prestashopBulkSuccessTimeout) {
      clearTimeout(prestashopBulkSuccessTimeout);
      prestashopBulkSuccessTimeout = null;
    }
    const dialog = $('#prestashop-bulk-dialog');
    if (dialog.open) dialog.close();

    showFloatingToast(`${successCount} ordin${successCount === 1 ? 'e' : 'i'} allineat${successCount === 1 ? 'o' : 'i'} su PrestaShop`, failCount === 0 ? 'success' : 'warning');
    await refreshControlCenter();
  };

  $('#prestashop-bulk-success-close-btn').onclick = finishAndUpdate;
  prestashopBulkSuccessTimeout = setTimeout(finishAndUpdate, failCount > 0 ? 5500 : 2500);
}

function setupBulkTrackingDialog() {
  const dialog = $('#control-bulk-tracking-dialog');
  if (!dialog) return;
  const close = () => { if (!bulkTrackingRunning && dialog.open) dialog.close(); };
  $('#close-control-bulk-tracking')?.addEventListener('click', close);
  $('#cancel-control-bulk-tracking')?.addEventListener('click', close);
  dialog.addEventListener('cancel', (event) => { if (bulkTrackingRunning) event.preventDefault(); });
  dialog.addEventListener('click', (event) => {
    if (bulkTrackingRunning || event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
  });
  document.querySelectorAll('input[name="control-bulk-carrier-mode"]').forEach((radio) => radio.addEventListener('change', () => {
    $('#control-bulk-tracking-carrier-wrap').hidden = bulkTrackingCarrierMode() !== 'change';
    renderBulkTrackingPreview();
  }));
  $('#control-bulk-tracking-protect')?.addEventListener('change', renderBulkTrackingPreview);
  $('#control-bulk-tracking-carrier')?.addEventListener('change', renderBulkTrackingPreview);
  $('#control-bulk-tracking-filters')?.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-bulk-tracking-filter]');
    if (!button) return;
    bulkTrackingPreviewFilter = button.dataset.bulkTrackingFilter;
    renderBulkTrackingPreview();
  });
  $('#control-bulk-tracking-kpis')?.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-bulk-tracking-filter]');
    if (!button) return;
    bulkTrackingPreviewFilter = button.dataset.bulkTrackingFilter;
    renderBulkTrackingPreview();
  });
  $('#control-bulk-tracking-preview')?.addEventListener('change', (event) => {
    if (!event.target.matches('[data-bulk-tracking-include]')) return;
    const tracking = event.target.dataset.bulkTrackingInclude;
    if (event.target.checked) bulkTrackingExcluded.delete(tracking);
    else bulkTrackingExcluded.add(tracking);
    renderBulkTrackingPreview();
  });
  $('#confirm-control-bulk-tracking')?.addEventListener('click', () => executeBulkTrackingSync(bulkTrackingActionableRows()));
  $('#retry-control-bulk-tracking')?.addEventListener('click', () => executeBulkTrackingSync([...bulkTrackingRetryRows]));
  $('#stop-control-bulk-tracking')?.addEventListener('click', (event) => {
    bulkTrackingRunning = false;
    event.currentTarget.disabled = true;
    event.currentTarget.textContent = 'Interruzione richiesta…';
  });
  $('#finish-control-bulk-tracking')?.addEventListener('click', async () => {
    dialog.close();
    await refreshControlCenter();
  });
}

function bulkTrackingRows() {
  return controlRecords.filter((row) => controlSelectedTrackingNumbers.has(row.trackingNumber));
}

function bulkTrackingCarrierMode() {
  return document.querySelector('input[name="control-bulk-carrier-mode"]:checked')?.value || 'preserve';
}

function bulkTrackingClassification(row) {
  if (!row.orderId && !row.orderReference) return { kind: 'unlinked', label: 'Ordine non collegato', detail: 'Escluso dall’invio' };
  const existing = String(row.existingTracking || '').trim();
  const tracking = String(row.trackingNumber || '').trim();
  const conflict = Boolean(existing && existing !== tracking);
  if (conflict) return { kind: 'conflict', label: 'Tracking differente', detail: `Presente: ${existing}` };
  const changeCarrier = bulkTrackingCarrierMode() === 'change';
  const carrierId = String($('#control-bulk-tracking-carrier')?.value || '').trim();
  const carrierAligned = carrierId && String(row.prestaCarrierId || '').trim() === carrierId;
  if (existing === tracking && tracking && (!changeCarrier || carrierAligned)) return { kind: 'aligned', label: 'Già sincronizzato', detail: 'Nessuna modifica' };
  if (existing === tracking && changeCarrier) return { kind: 'ready', label: 'Corriere da allineare', detail: 'Tracking già presente' };
  return { kind: 'ready', label: 'Tracking da inviare', detail: '' };
}

function bulkTrackingActionableRows() {
  const protect = Boolean($('#control-bulk-tracking-protect')?.checked);
  return bulkTrackingRows().filter((row) => {
    if (bulkTrackingExcluded.has(row.trackingNumber)) return false;
    const classification = bulkTrackingClassification(row);
    return classification.kind === 'ready' || (classification.kind === 'conflict' && !protect);
  });
}

function renderBulkTrackingPreview() {
  const rows = bulkTrackingRows();
  const protect = Boolean($('#control-bulk-tracking-protect')?.checked);
  const changeCarrier = bulkTrackingCarrierMode() === 'change';
  const carrierSelect = $('#control-bulk-tracking-carrier');
  const invalidCarrier = changeCarrier && !carrierSelect?.value;
  const selectedCarrier = prestaShopCarrierCatalog.find((carrier) => String(carrier.id) === String(carrierSelect?.value || ''));
  const carrierStatus = $('#control-bulk-tracking-carrier-status');
  if (carrierStatus) carrierStatus.textContent = selectedCarrier
    ? `${selectedCarrier.name}${selectedCarrier.active === false ? ' · Disattivato, ma associabile agli ordini esistenti.' : ' · Attivo.'}`
    : 'Seleziona il corriere da associare agli ordini aggiornati.';
  const classified = rows.map((row) => ({ row, classification: bulkTrackingClassification(row) }));
  const counts = classified.reduce((result, item) => {
    result[item.classification.kind] = (result[item.classification.kind] || 0) + 1;
    return result;
  }, { ready: 0, aligned: 0, conflict: 0, unlinked: 0 });
  const actionable = bulkTrackingActionableRows();
  const excludedCount = rows.filter((row) => bulkTrackingExcluded.has(row.trackingNumber)).length;

  const summary = $('#control-bulk-tracking-summary');
  if (summary) summary.textContent = actionable.length
    ? `${actionable.length} ordin${actionable.length === 1 ? 'e verrà modificato' : 'i verranno modificati'}. ${rows.length - actionable.length} resteranno invariati.`
    : 'Nessun ordine richiede un aggiornamento con le opzioni correnti.';
  const kpis = $('#control-bulk-tracking-kpis');
  if (kpis) kpis.innerHTML = [
    ['ready', 'Da aggiornare', counts.ready],
    ['aligned', 'Già sincronizzati', counts.aligned],
    ['conflict', protect ? 'Protetti' : 'Da sovrascrivere', counts.conflict],
    ['unlinked', 'Senza ordine', counts.unlinked],
  ].map(([kind, label, count]) => `<button type="button" data-bulk-tracking-filter="${kind}" class="${bulkTrackingPreviewFilter === kind ? 'active' : ''}" aria-pressed="${bulkTrackingPreviewFilter === kind}"><strong>${count}</strong><span>${label}</span></button>`).join('');
  const button = $('#confirm-control-bulk-tracking');
  if (button) {
    button.disabled = !actionable.length || invalidCarrier;
    button.textContent = actionable.length
      ? changeCarrier ? `Aggiorna ${actionable.length} ordin${actionable.length === 1 ? 'e' : 'i'} e corriere` : `Invia tracking a ${actionable.length} ordin${actionable.length === 1 ? 'e' : 'i'}`
      : 'Nessun aggiornamento necessario';
  }
  const footerNote = $('#control-bulk-tracking-footer-note');
  if (footerNote) footerNote.textContent = `${rows.length - actionable.length} non verranno modificati${excludedCount ? `, inclusi ${excludedCount} esclusi manualmente` : ''}.`;

  const filters = $('#control-bulk-tracking-filters');
  if (filters) filters.innerHTML = [
    ['all', 'Tutte', rows.length],
    ['ready', 'Da aggiornare', counts.ready],
    ['attention', 'Attenzione', counts.conflict + counts.unlinked],
    ['aligned', 'Già sincronizzati', counts.aligned],
  ].map(([filter, label, count]) => `<button type="button" data-bulk-tracking-filter="${filter}" class="${bulkTrackingPreviewFilter === filter ? 'active' : ''}" aria-pressed="${bulkTrackingPreviewFilter === filter}">${label} <span>${count}</span></button>`).join('');

  const preview = $('#control-bulk-tracking-preview');
  if (!preview) return;
  const visible = classified.filter(({ classification }) => {
    if (bulkTrackingPreviewFilter === 'all') return true;
    if (bulkTrackingPreviewFilter === 'attention') return ['conflict', 'unlinked'].includes(classification.kind);
    return classification.kind === bulkTrackingPreviewFilter;
  });
  preview.innerHTML = visible.length ? visible.map(({ row, classification }) => {
    const canInclude = classification.kind === 'ready' || (classification.kind === 'conflict' && !protect);
    const included = canInclude && !bulkTrackingExcluded.has(row.trackingNumber);
    return `<div class="bulk-preview-row" role="listitem" data-kind="${classification.kind}"><label class="bulk-preview-include"><input type="checkbox" data-bulk-tracking-include="${escapeHtml(row.trackingNumber)}" ${included ? 'checked' : ''} ${canInclude ? '' : 'disabled'} aria-label="Includi ordine ${escapeHtml(row.orderReference || row.trackingNumber)}"></label><div class="bulk-preview-identity"><strong title="${escapeHtml(row.orderReference || '')}">${escapeHtml(row.orderReference || 'Ordine non collegato')}</strong><small title="${escapeHtml(row.trackingNumber)}">${escapeHtml(row.trackingNumber)}</small></div><div class="bulk-preview-status ${classification.kind}"><strong>${escapeHtml(classification.label)}</strong>${classification.detail ? `<small>${escapeHtml(classification.detail)}</small>` : ''}</div></div>`;
  }).join('') : '<p class="control-bulk-tracking-empty">Nessuna spedizione in questo filtro.</p>';
}

async function openBulkTrackingDialog() {
  const rows = bulkTrackingRows();
  if (!rows.length) return;
  const dialog = $('#control-bulk-tracking-dialog');
  $('#control-bulk-tracking-form').hidden = false;
  $('#control-bulk-tracking-progress').hidden = true;
  $('#control-bulk-tracking-result').hidden = true;
  const preserveCarrier = document.querySelector('input[name="control-bulk-carrier-mode"][value="preserve"]');
  if (preserveCarrier) preserveCarrier.checked = true;
  $('#control-bulk-tracking-carrier-wrap').hidden = true;
  $('#control-bulk-tracking-protect').checked = true;
  bulkTrackingRetryRows = [];
  bulkTrackingExcluded = new Set();
  tell('#control-bulk-tracking-message', '', '');

  try {
    const [catalog, preferred] = await Promise.all([
      request('/api/catalog'),
      request('/api/settings/default-carrier').catch(() => ({})),
    ]);
    prestaShopCarrierCatalog = catalog.carriers || [];
    const select = $('#control-bulk-tracking-carrier');
    let selectedId = preferred.defaultCarrierId || '';
    if (!prestaShopCarrierCatalog.some((carrier) => String(carrier.id) === String(selectedId))) {
      selectedId = prestaShopCarrierCatalog.find((carrier) => /dsv|schenker/i.test(carrier.name))?.id || prestaShopCarrierCatalog[0]?.id || '';
    }
    select.innerHTML = '<option value="">Seleziona un corriere…</option>' + prestaShopCarrierCatalog.map((carrier) => `<option value="${escapeHtml(carrier.id)}"${String(carrier.id) === String(selectedId) ? ' selected' : ''}>${escapeHtml(carrier.name)}${carrier.active === false ? ' · Disattivato' : ''}</option>`).join('');
  } catch (error) {
    tell('#control-bulk-tracking-message', `Catalogo corrieri non disponibile: ${error.message}. Puoi comunque inviare i tracking mantenendo il corriere esistente.`, 'warning');
  }
  const hasAttentionRows = rows.some((row) => ['conflict', 'unlinked'].includes(bulkTrackingClassification(row).kind));
  bulkTrackingPreviewFilter = hasAttentionRows ? 'attention' : 'ready';
  renderBulkTrackingPreview();
  if (!dialog.open) dialog.showModal();
}

async function executeBulkTrackingSync(rows) {
  if (!rows.length || bulkTrackingRunning) return;
  const changeCarrier = bulkTrackingCarrierMode() === 'change';
  const carrierId = changeCarrier ? String($('#control-bulk-tracking-carrier')?.value || '') : '';
  if (changeCarrier && !carrierId) return renderBulkTrackingPreview();
  const skipIfDifferent = Boolean($('#control-bulk-tracking-protect')?.checked);
  const actionable = rows.filter((row) => row.orderId || row.orderReference);
  if (!actionable.length) return;

  bulkTrackingRunning = true;
  bulkTrackingRetryRows = [];
  $('#control-bulk-tracking-form').hidden = true;
  $('#control-bulk-tracking-result').hidden = true;
  $('#control-bulk-tracking-progress').hidden = false;
  const stopButton = $('#stop-control-bulk-tracking');
  stopButton.disabled = false;
  stopButton.textContent = 'Interrompi dopo questa riga';
  const log = $('#control-bulk-tracking-log');
  log.innerHTML = '';
  let successful = 0;
  let skipped = 0;
  let interrupted = false;
  const failures = [];

  const updateProgress = (completed, current = '') => {
    const percent = Math.round((completed / actionable.length) * 100);
    $('#control-bulk-tracking-progress-text').textContent = `${completed} di ${actionable.length}`;
    $('#control-bulk-tracking-progress-percent').textContent = `${percent}%`;
    $('#control-bulk-tracking-progress-bar').style.transform = `scaleX(${percent / 100})`;
    $('#control-bulk-tracking-progress-track').setAttribute('aria-valuenow', String(percent));
    $('#control-bulk-tracking-current').textContent = current;
  };
  updateProgress(0, 'Preparazione aggiornamenti…');

  for (let index = 0; index < actionable.length; index += 1) {
    if (!bulkTrackingRunning) {
      interrupted = true;
      actionable.slice(index).forEach((row) => failures.push({ row, error: 'Operazione interrotta prima dell’invio.' }));
      break;
    }
    const row = actionable[index];
    const orderLabel = row.orderReference || `ID #${row.orderId}`;
    updateProgress(index, `Ordine ${orderLabel} · ${row.trackingNumber}`);
    try {
      const result = await request(`/api/control-center/${encodeURIComponent(row.trackingNumber)}/sync-prestashop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          preserveCarrier: !changeCarrier,
          carrierId: carrierId || undefined,
          skipIfDifferent,
          overwrite: !skipIfDifferent,
        }),
      });
      if (result.skipped) skipped += 1;
      else {
        successful += 1;
        controlSelectedTrackingNumbers.delete(row.trackingNumber);
      }
      log.insertAdjacentHTML('afterbegin', `<div class="bulk-log-row ${result.skipped ? 'skipped' : 'success'}"><strong>${result.skipped ? 'Saltato' : 'Inviato'}</strong><span>${escapeHtml(orderLabel)} · ${escapeHtml(row.trackingNumber)}</span></div>`);
    } catch (error) {
      failures.push({ row, error: error.message });
      log.insertAdjacentHTML('afterbegin', `<div class="bulk-log-row error"><strong>Errore</strong><span>${escapeHtml(orderLabel)} · ${escapeHtml(error.message)}</span></div>`);
    }
    updateProgress(index + 1, `Completati ${index + 1} di ${actionable.length}`);
  }

  bulkTrackingRunning = false;
  bulkTrackingRetryRows = failures.map((failure) => failure.row);
  $('#control-bulk-tracking-progress').hidden = true;
  $('#control-bulk-tracking-result').hidden = false;
  $('#control-bulk-tracking-result-title').textContent = interrupted ? 'Invio interrotto' : failures.length ? 'Invio completato con anomalie' : 'Tracking sincronizzati';
  $('#control-bulk-tracking-result-kpis').innerHTML = `<div class="success"><strong>${successful}</strong><span>Inviati</span></div><div class="skipped"><strong>${skipped}</strong><span>Saltati</span></div><div class="${failures.length ? 'failed' : ''}"><strong>${failures.length}</strong><span>Errori</span></div>`;
  const errors = $('#control-bulk-tracking-errors');
  errors.hidden = failures.length === 0;
  errors.innerHTML = failures.map((failure) => `<div><strong>${escapeHtml(failure.row.orderReference || failure.row.trackingNumber)}:</strong> ${escapeHtml(failure.error)}</div>`).join('');
  const retry = $('#retry-control-bulk-tracking');
  retry.hidden = failures.length === 0;
  retry.textContent = `Riprova ${failures.length} non riuscit${failures.length === 1 ? 'o' : 'i'}`;
  $('#control-bulk-tracking-result').focus();
}

function closeControlDetail({ force = false } = {}) {
  const panel = $('#shipment-detail');
  if (!force && panel?.open && shipmentDetailDirty && !window.confirm('Hai modifiche non salvate nella gestione eccezione. Vuoi chiudere senza salvarle?')) return false;
  controlDetailRequestToken += 1;
  if (panel.open) panel.close();
  shipmentDetailDirty = false;
  activeControlTrackingNumber = '';
  panel.innerHTML = '';
  panel.dataset.empty = 'true';
  panel.removeAttribute('aria-labelledby');
  document.querySelectorAll('#control-table tbody tr').forEach((row) => row.classList.remove('active'));
  controlDetailTrigger?.focus?.();
  controlDetailTrigger = null;
  return true;
}

function exportSelectedControlRows() {
  const rows = controlRecords.filter((row) => controlSelectedTrackingNumbers.has(row.trackingNumber));
  if (!rows.length) return;
  const csv = [['Tracking', 'Riferimento ordine', 'Stato DSV', 'Data evento DSV', 'Stato PrestaShop', 'Ultimo controllo'], ...rows.map((row) => [row.trackingNumber, row.orderReference || '', row.dsvStatus || '', row.dsvStatusAt || row.dsvStatusDateRaw || '', row.currentState || '', row.dsvCheckedAt || row.lastSeenAt || ''])].map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(';')).join('\r\n');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
  link.download = `tracking-center-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

async function markSelectedAsWorking() {
  const trackingNumbers = [...controlSelectedTrackingNumbers];
  if (!trackingNumbers.length) return;
  const button = $('#control-bulk-manage'); button.disabled = true;
  try {
    await Promise.all(trackingNumbers.map((trackingNumber) => request(`/api/control-center/${encodeURIComponent(trackingNumber)}/case`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ caseStatus: 'In lavorazione' }) })));
    tell('#control-dsv-message', `${trackingNumbers.length} spedizioni segnate come “In lavorazione”.`, 'success');
    controlSelectedTrackingNumbers.clear();
    await refreshControlCenter();
  } catch (error) { tell('#control-dsv-message', error.message, 'error'); }
  finally { button.disabled = false; }
}

function showView(requestedView) {
  const [requestedRoot, requestedSettingsSection] = String(requestedView || '').split('/');
  const view = ['control', 'import', 'history', 'settings'].includes(requestedRoot) ? requestedRoot : 'control';
  if (activeView === 'settings' && view !== 'settings' && dirtySettingsSections.size) {
    const sections = [...dirtySettingsSections].map((section) => settingsSectionLabels[section]).join(', ');
    if (!confirm(`Hai modifiche non salvate in: ${sections}.\n\nVuoi uscire senza salvarle?`)) {
      window.history.replaceState(null, '', '#settings');
      return;
    }
    dirtySettingsSections.clear();
    updateSettingsDirtyBar();
  }
  if (view !== 'control') {
    if ($('#shipment-detail')?.open) {
      if (closeControlDetail() === false) {
        if (location.hash !== '#control') location.hash = 'control';
        return;
      }
    } else controlDetailRequestToken += 1;
  }
  activeView = view;
  document.querySelectorAll('.workspace-view').forEach((section) => { section.hidden = section.dataset.view !== view; });
  $('main').dataset.activeView = view;
  document.querySelectorAll('[data-view-link]').forEach((button) => { const active = button.dataset.viewLink === view; button.classList.toggle('active', active); if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
  const titles = { control: ['DSV - Tracking Center', 'Visibilità operativa sulle spedizioni DSV e PrestaShop'], import: ['Importa spedizioni', 'Verifica e aggiorna ordini PrestaShop'], history: ['Storico importazioni', 'Rivedi gli aggiornamenti già eseguiti'], settings: ['Configurazione', 'Connessione e impostazioni del servizio'] };
  $('header h1').textContent = titles[view][0]; $('header > p:not(.eyebrow)').textContent = titles[view][1];
  document.title = view === 'control' ? 'DSV - Tracking Center' : `${titles[view][0]} · DSV - Tracking Center`;
  if (view === 'control') void refreshControlCenter();
  if (view === 'history') void renderImportHistory();
  if (view === 'import') void loadCatalog(true);
  if (view === 'settings') {
    if ($('#dsv-beta')) $('#dsv-beta').hidden = false;
    void loadStateMappings();
    void loadCronStatus();
    void loadNotificationSettings();
    updateSettingsHealth();
    if (settingsSectionLabels[requestedSettingsSection]) requestAnimationFrame(() => activateSettingsSection(requestedSettingsSection, { behavior: 'auto' }));
  }
}

async function loadStateMappings() {
  const rows = $('#state-mapping-rows');
  rows.innerHTML = '<p class="control-empty">Caricamento mappatura e catalogo PrestaShop…</p>';
  try {
    const [mappingData, overview, catalog] = await Promise.all([
      request('/api/dsv-state-mappings'), request('/api/control-center'), request('/api/catalog'),
    ]);
    dsvStateMappings = mappingData.mappings || {};
    prestaShopStateCatalog = catalog.statuses || [];
    const observed = Object.keys(overview.dsvCounts || {});
    const statuses = [...new Set([...DSV_STATUS_ORDER, ...observed])].sort((left, right) => {
      const leftIndex = DSV_STATUS_ORDER.indexOf(left); const rightIndex = DSV_STATUS_ORDER.indexOf(right);
      return (leftIndex < 0 ? 999 : leftIndex) - (rightIndex < 0 ? 999 : rightIndex) || left.localeCompare(right, 'it');
    });
    rows.innerHTML = statuses.map((status) => {
      const mapping = dsvStateMappings[status];
      const hasMapping = Boolean(mapping?.stateId);
      const isAutoSync = Boolean(mapping?.autoSync);
      const options = prestaShopStateCatalog.map((state) => `<option value="${escapeHtml(state.id)}" ${String(mapping?.stateId || '') === String(state.id) ? 'selected' : ''}>${escapeHtml(state.name)}</option>`).join('');
      return `
        <div class="state-mapping-row">
          <span>
            <strong>${escapeHtml(status)}</strong>
            <small>${DSV_DELIVERY_EVENT_STATUSES.includes(status) ? 'Esito da evento storico · ' : ''}${Number(overview.dsvCounts?.[status] || 0)} spedizioni rilevate</small>
          </span>
          <select class="dsv-mapping-select" data-dsv-status="${escapeHtml(status)}">
            <option value="">Nessuna associazione</option>
            ${options}
          </select>
          <label class="mapping-autosync-toggle" title="Se abilitato, il Cron allinea automaticamente l'ordine PrestaShop a questo stato quando DSV lo rileva">
            <input type="checkbox" class="dsv-mapping-autosync" data-dsv-status="${escapeHtml(status)}" ${isAutoSync ? 'checked' : ''} ${hasMapping ? '' : 'disabled'}>
            <span class="autosync-label-text">Auto-sync Cron</span>
          </label>
        </div>
      `;
    }).join('');

    rows.querySelectorAll('.dsv-mapping-select').forEach((select) => {
      select.addEventListener('change', () => {
        const row = select.closest('.state-mapping-row');
        const autoSyncInput = row?.querySelector('.dsv-mapping-autosync');
        if (autoSyncInput) {
          if (!select.value) {
            autoSyncInput.checked = false;
            autoSyncInput.disabled = true;
          } else {
            autoSyncInput.disabled = false;
          }
        }
      });
    });

    const bulkSelect = $('#mapping-bulk-state');
    if (bulkSelect) bulkSelect.innerHTML = '<option value="">Scegli stato…</option>' + prestaShopStateCatalog.map((state) => `<option value="${escapeHtml(state.id)}">${escapeHtml(state.name)}</option>`).join('');

    tell('#state-mapping-message', `${Object.keys(dsvStateMappings).length} associazioni configurate.`);
    updateMappingFilter();
    updateSettingsHealth();
  } catch (error) {
    rows.innerHTML = `<p class="control-empty">${escapeHtml(error.message)}</p>`;
    tell('#state-mapping-message', 'Collega PrestaShop per configurare la mappatura.', 'error');
  }
}

async function saveStateMappings(event) {
  event.preventDefault();
  const button = $('#save-state-mappings'); button.disabled = true;
  try {
    const mappings = {};
    document.querySelectorAll('.dsv-mapping-select').forEach((select) => {
      const state = prestaShopStateCatalog?.find((item) => String(item.id) === select.value);
      const status = select.dataset.dsvStatus;
      const autoSyncCheck = document.querySelector(`.dsv-mapping-autosync[data-dsv-status="${CSS.escape(status)}"]`);
      if (state) {
        mappings[status] = {
          stateId: String(state.id),
          stateName: state.name,
          autoSync: Boolean(autoSyncCheck?.checked),
        };
      }
    });
    const result = await request('/api/dsv-state-mappings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mappings }) });
    dsvStateMappings = result.mappings || {};
    markSettingsClean('mappings');
    updateSettingsHealth();
    tell('#state-mapping-message', result.message, 'success');
    showFloatingToast('Mappature DSV salvate con successo!', 'success');
    if (controlOverview.records?.length) renderControlCenter({ ...controlOverview, stateMappings: dsvStateMappings });
  } catch (error) { tell('#state-mapping-message', error.message, 'error'); }
  finally { button.disabled = false; }
}

async function loadNotificationSettings() {
  try {
    const data = await request('/api/notifications/config');
    const n = data.notifications || {};
    const tg = n.telegram || {};
    const em = n.email || {};
    const tr = n.triggers || {};

    if ($('#notify-tg-enabled')) $('#notify-tg-enabled').checked = Boolean(tg.enabled);
    if ($('#notify-tg-token')) $('#notify-tg-token').value = tg.botToken || '';
    if ($('#notify-tg-chatid')) $('#notify-tg-chatid').value = tg.chatId || '';

    if ($('#notify-email-enabled')) $('#notify-email-enabled').checked = Boolean(em.enabled);
    if ($('#notify-email-host')) $('#notify-email-host').value = em.host || '';
    if ($('#notify-email-port')) $('#notify-email-port').value = em.port || 587;
    if ($('#notify-email-secure')) $('#notify-email-secure').checked = Boolean(em.secure);
    if ($('#notify-email-user')) $('#notify-email-user').value = em.user || '';
    if ($('#notify-email-pass')) $('#notify-email-pass').value = em.pass || '';
    if ($('#notify-email-from')) $('#notify-email-from').value = em.from || '';
    if ($('#notify-email-to')) $('#notify-email-to').value = em.to || '';

    if ($('#trigger-exceptions')) $('#trigger-exceptions').checked = tr.exceptions !== false;
    if ($('#trigger-sla')) $('#trigger-sla').checked = tr.sla48h !== false;
    if ($('#trigger-autosync')) $('#trigger-autosync').checked = Boolean(tr.autoSyncSuccess);
    if ($('#trigger-digest')) $('#trigger-digest').checked = tr.dailyDigest !== false;
    if ($('#trigger-digest-hour')) $('#trigger-digest-hour').value = tr.digestHour ?? 8;
    if ($('#trigger-digest-minute')) $('#trigger-digest-minute').value = tr.digestMinute ?? 30;
    updateSettingsHealth();
  } catch (err) {
    console.error('[NOTIFICATIONS] Errore caricamento impostazioni:', err);
  }
}

function setupNotificationSection() {
  const form = $('#notification-config-form');
  const msg = $('#notification-config-message');
  const saveBtn = $('#save-notifications-btn');
  const testTgBtn = $('#test-tg-btn');
  const testEmailBtn = $('#test-email-btn');
  const testDigestBtn = $('#trigger-digest-test-btn');

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (saveBtn) saveBtn.disabled = true;
    if (msg) { msg.className = 'message'; msg.textContent = 'Salvataggio in corso…'; }

    try {
      const payload = {
        telegram: {
          enabled: $('#notify-tg-enabled')?.checked,
          botToken: $('#notify-tg-token')?.value?.trim(),
          chatId: $('#notify-tg-chatid')?.value?.trim(),
        },
        email: {
          enabled: $('#notify-email-enabled')?.checked,
          host: $('#notify-email-host')?.value?.trim(),
          port: Number($('#notify-email-port')?.value) || 587,
          secure: $('#notify-email-secure')?.checked,
          user: $('#notify-email-user')?.value?.trim(),
          pass: $('#notify-email-pass')?.value || '',
          from: $('#notify-email-from')?.value?.trim(),
          to: $('#notify-email-to')?.value?.trim(),
        },
        triggers: {
          exceptions: $('#trigger-exceptions')?.checked,
          sla48h: $('#trigger-sla')?.checked,
          autoSyncSuccess: $('#trigger-autosync')?.checked,
          dailyDigest: $('#trigger-digest')?.checked,
          digestHour: Number($('#trigger-digest-hour')?.value) || 8,
          digestMinute: Number($('#trigger-digest-minute')?.value) || 30,
        },
      };

      const res = await request('/api/notifications/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (msg) { msg.className = 'message success'; msg.textContent = res.message || 'Impostazioni salvate con successo!'; }
      showFloatingToast('Impostazioni notifiche salvate!', 'success');
      markSettingsClean('notifications');
      updateSettingsHealth();
    } catch (err) {
      if (msg) { msg.className = 'message error'; msg.textContent = `Errore: ${err.message}`; }
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  });

  testTgBtn?.addEventListener('click', async () => {
    testTgBtn.disabled = true;
    const orig = testTgBtn.textContent;
    testTgBtn.textContent = 'Invio in corso…';
    try {
      const payload = {
        enabled: true,
        botToken: $('#notify-tg-token')?.value?.trim(),
        chatId: $('#notify-tg-chatid')?.value?.trim(),
      };
      const res = await request('/api/notifications/test-telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      showFloatingToast('Messaggio di prova Telegram inviato!', 'success');
      setSettingsTestResult('notifications', true, `${res.message || 'Messaggio Telegram inviato'} · Chat ${$('#notify-tg-chatid')?.value?.trim() || 'configurata'}`);
    } catch (err) {
      setSettingsTestResult('notifications', false, `Telegram: ${err.message}`);
      alert(`Test Telegram fallito: ${err.message}`);
    } finally {
      testTgBtn.disabled = false;
      testTgBtn.textContent = orig;
    }
  });

  testEmailBtn?.addEventListener('click', async () => {
    testEmailBtn.disabled = true;
    const orig = testEmailBtn.textContent;
    testEmailBtn.textContent = 'Invio in corso…';
    try {
      const payload = {
        enabled: true,
        host: $('#notify-email-host')?.value?.trim(),
        port: Number($('#notify-email-port')?.value) || 587,
        secure: $('#notify-email-secure')?.checked,
        user: $('#notify-email-user')?.value?.trim(),
        pass: $('#notify-email-pass')?.value || '',
        from: $('#notify-email-from')?.value?.trim(),
        to: $('#notify-email-to')?.value?.trim(),
      };
      const res = await request('/api/notifications/test-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      showFloatingToast('Email di prova inviata!', 'success');
      alert(res.message || 'Email inviata!');
    } catch (err) {
      alert(`Test Email fallito: ${err.message}`);
    } finally {
      testEmailBtn.disabled = false;
      testEmailBtn.textContent = orig;
    }
  });

  testDigestBtn?.addEventListener('click', async () => {
    testDigestBtn.disabled = true;
    const orig = testDigestBtn.textContent;
    testDigestBtn.textContent = 'Generazione…';
    try {
      const res = await request('/api/notifications/trigger-digest', { method: 'POST' });
      showFloatingToast(res.message || 'Digest inviato!', 'success');
      setSettingsTestResult('notifications', true, `${res.message || 'Digest di prova inviato'} · ${settingsTimestamp()}`);
    } catch (err) {
      setSettingsTestResult('notifications', false, `Digest: ${err.message}`);
    } finally {
      testDigestBtn.disabled = false;
      testDigestBtn.textContent = orig;
    }
  });
}

let activeHistorySubtab = 'batches';
let auditTypeFilter = '';
let auditSearchQuery = '';
let auditDateFilter = '';
let historyBatchSearch = '';
let historyBatchOrigin = '';
let activeBatchFilter = null;
let currentImportFileName = 'File Excel';
let currentImportOrigin = 'excel';
let auditSearchDebounceTimer = null;
let historyBatchSearchTimer = null;

function setupHistorySection() {
  const subnavBtns = document.querySelectorAll('.history-subnav-btn');
  const batchesTab = $('#history-batches-tab');
  const auditTab = $('#history-audit-tab');

  subnavBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      subnavBtns.forEach((b) => {
        b.classList.remove('active');
        b.setAttribute('aria-selected', 'false');
      });
      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');

      activeHistorySubtab = btn.dataset.subtab || 'batches';
      if (activeHistorySubtab === 'batches') {
        if (batchesTab) { batchesTab.hidden = false; batchesTab.classList.add('active'); }
        if (auditTab) { auditTab.hidden = true; auditTab.classList.remove('active'); }
        void loadHistoryBatches();
      } else {
        if (auditTab) { auditTab.hidden = false; auditTab.classList.add('active'); }
        if (batchesTab) { batchesTab.hidden = true; batchesTab.classList.remove('active'); }
        void loadAuditLog();
      }
    });
  });

  const pillBtns = document.querySelectorAll('.audit-pill-btn');
  pillBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      pillBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      auditTypeFilter = btn.dataset.type || '';
      void loadAuditLog();
    });
  });

  $('#audit-search-input')?.addEventListener('input', (event) => {
    clearTimeout(auditSearchDebounceTimer);
    auditSearchDebounceTimer = setTimeout(() => {
      auditSearchQuery = event.target.value.trim();
      void loadAuditLog();
    }, 250);
  });

  $('#audit-date-filter')?.addEventListener('change', (event) => {
    auditDateFilter = event.target.value;
    void loadAuditLog();
  });

  $('#export-audit-csv-btn')?.addEventListener('click', () => {
    const params = new URLSearchParams();
    if (auditTypeFilter) params.set('type', auditTypeFilter);
    if (auditSearchQuery) params.set('query', auditSearchQuery);
    if (auditDateFilter === 'today') {
      params.set('dateFrom', new Date().toISOString().slice(0, 10));
    } else if (auditDateFilter === '7d') {
      params.set('dateFrom', new Date(Date.now() - 7 * 24 * 3600_000).toISOString().slice(0, 10));
    } else if (auditDateFilter === '30d') {
      params.set('dateFrom', new Date(Date.now() - 30 * 24 * 3600_000).toISOString().slice(0, 10));
    }
    window.location.href = `/api/history/audit-log/export?${params.toString()}`;
  });

  $('#batch-search-input')?.addEventListener('input', (event) => {
    clearTimeout(historyBatchSearchTimer);
    historyBatchSearchTimer = setTimeout(() => {
      historyBatchSearch = event.target.value.trim();
      void loadHistoryBatches();
    }, 200);
  });
  $('#batch-origin-filter')?.addEventListener('change', (event) => {
    historyBatchOrigin = event.target.value;
    void loadHistoryBatches();
  });
  $('#cancel-delete-batch')?.addEventListener('click', () => $('#delete-batch-dialog')?.close());
  $('#close-delete-batch')?.addEventListener('click', () => $('#delete-batch-dialog')?.close());
  $('#delete-batch-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const dialog = $('#delete-batch-dialog');
    const button = $('#confirm-delete-batch');
    const batchId = dialog?.dataset.batchId;
    if (!batchId) return;
    button.disabled = true;
    try {
      const result = await request(`/api/history/batches/${encodeURIComponent(batchId)}`, { method: 'DELETE' });
      dialog.close();
      tell('#history-batches-message', result.message, 'success');
      await loadHistoryBatches();
    } catch (error) {
      tell('#delete-batch-message', error.message, 'error');
    } finally {
      button.disabled = false;
    }
  });
}

async function renderImportHistory() {
  if (activeHistorySubtab === 'batches') {
    await loadHistoryBatches();
  } else {
    await loadAuditLog();
  }
  try {
    if (activeHistorySubtab === 'batches') {
      const auditRes = await request('/api/history/audit-log?limit=1');
      const badge = $('#audit-count-badge');
      if (badge && auditRes.total !== undefined) badge.textContent = auditRes.total;
    } else {
      const batches = await request('/api/history/batches');
      const badge = $('#batches-count-badge');
      if (badge && batches) badge.textContent = batches.length;
    }
  } catch { /* silenzioso */ }
}

async function loadHistoryBatches() {
  const container = $('#batches-list');
  if (!container) return;
  container.innerHTML = '<div class="control-empty">Caricamento lotti in corso…</div>';
  try {
    const batches = await request('/api/history/batches');
    const badge = $('#batches-count-badge');
    if (badge) badge.textContent = batches.length;
    const needle = historyBatchSearch.toLocaleLowerCase('it-IT');
    const visibleBatches = batches.filter((batch) => {
      const matchesOrigin = !historyBatchOrigin || batch.origin === historyBatchOrigin;
      const matchesSearch = !needle || [batch.filename, batch.id, ...(batch.trackingNumbers || [])]
        .some((value) => String(value || '').toLocaleLowerCase('it-IT').includes(needle));
      return matchesOrigin && matchesSearch;
    });
    const processedRows = visibleBatches.reduce((sum, batch) => sum + Number(batch.totalRows || batch.trackingNumbers?.length || 0), 0);
    const resultsSummary = $('#batch-results-summary');
    if (resultsSummary) resultsSummary.textContent = `${visibleBatches.length} di ${batches.length} lotti · ${processedRows} colli`;
    if (!batches.length) {
      container.innerHTML = '<div class="control-empty">Nessun lotto di importazione registrato.</div>';
      return;
    }
    if (!visibleBatches.length) {
      container.innerHTML = '<div class="control-empty">Nessun lotto corrisponde ai filtri impostati.</div>';
      return;
    }
    container.innerHTML = visibleBatches.map((batch) => {
      const originClass = batch.origin === 'manual' ? 'manual' : 'excel';
      const originLabel = batch.origin === 'manual' ? 'Manuale' : 'File Excel';
      const originIcon = batch.origin === 'manual'
        ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11 2a2 2 0 0 1 2.8 2.8L4.8 13.8l-3.3.7.7-3.3L11 2zM10 3l3 3"/></svg>'
        : '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2H4a1.5 1.5 0 0 0-1.5 1.5v9A1.5 1.5 0 0 0 4 14h8a1.5 1.5 0 0 0 1.5-1.5V6.5L9.5 2zM9.5 2v4.5H14M8 8v4m-2-2h4"/></svg>';
      const trackings = Array.isArray(batch.trackingNumbers) ? batch.trackingNumbers : [];
      return `
        <article class="batch-card" data-batch-id="${escapeHtml(batch.id)}">
          <header class="batch-card-header">
            <div class="batch-title-group">
              <div class="batch-title-row">
                <span class="batch-origin-badge ${originClass}">${originIcon}${originLabel}</span>
                <span class="batch-filename">${escapeHtml(batch.filename)}</span>
              </div>
              <time class="batch-timestamp">${displayDateTime(batch.at)}</time>
            </div>
          </header>
          <div class="batch-metrics-row">
            <span class="metric-chip">Totale colli: <strong>${batch.totalRows || trackings.length}</strong></span>
            <span class="metric-chip">Nuove: <strong>${batch.newCount || 0}</strong></span>
            ${batch.skippedCount ? `<span class="metric-chip">Saltate duplicate: <strong>${batch.skippedCount}</strong></span>` : ''}
            <span class="metric-chip consegnate">Consegnate: <strong>${batch.stats?.consegnate || 0}</strong></span>
            <span class="metric-chip in-transito">In movimento: <strong>${batch.stats?.inTransito || 0}</strong></span>
            ${batch.stats?.eccezioni ? `<span class="metric-chip eccezioni">Eccezioni: <strong>${batch.stats?.eccezioni}</strong></span>` : ''}
          </div>
          <div class="batch-card-actions">
            <button type="button" class="secondary batch-filter-control-btn" data-batch-id="${escapeHtml(batch.id)}">
              <svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor"><path fill-rule="evenodd" d="M8 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM2 8a6 6 0 1 1 10.89 3.476l4.817 4.817a1 1 0 0 1-1.414 1.414l-4.816-4.816A6 6 0 0 1 2 8z" clip-rule="evenodd"/></svg>
              Apri nel centro
            </button>
            <a class="secondary button-link" href="/api/history/batches/${encodeURIComponent(batch.id)}/export" download="lotto-${escapeHtml(batch.id)}.csv">
              <svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor"><path fill-rule="evenodd" d="M3 17a1 1 0 0 1 1-1h12a1 1 0 1 1 0 2H4a1 1 0 0 1-1-1zm3.293-7.707a1 1 0 0 1 1.414 0L9 10.586V3a1 1 0 1 1 2 0v7.586l1.293-1.293a1 1 0 1 1 1.414 1.414l-3 3a1 1 0 0 1-1.414 0l-3-3a1 1 0 0 1 0-1.414z" clip-rule="evenodd"/></svg>
              Esporta CSV
            </a>
            <button type="button" class="secondary batch-toggle-chips-btn" data-batch-id="${escapeHtml(batch.id)}" data-count="${trackings.length}">
              Colli (${trackings.length}) ▾
            </button>
            <button type="button" class="batch-delete-btn" data-batch-id="${escapeHtml(batch.id)}" aria-label="Elimina ${escapeHtml(batch.filename)} dallo storico" title="Elimina dallo storico">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4h11M6 4V2.5h4V4m-6 0 .6 10h6.8L12 4M6.5 6.5v5M9.5 6.5v5"/></svg>
            </button>
          </div>
          <div class="batch-trackings-drawer" id="drawer-${escapeHtml(batch.id)}" hidden>
            <small style="color: var(--muted); font-weight: 600;">Clicca su un tracking per aprire il dettaglio spedizione:</small>
            <div class="batch-trackings-grid">
              ${trackings.map((t) => `<button type="button" class="tracking-chip-link open-batch-chip" data-tracking="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join('')}
            </div>
          </div>
        </article>
      `;
    }).join('');

    container.querySelectorAll('.batch-filter-control-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const batchId = btn.dataset.batchId;
        const b = batches.find((item) => item.id === batchId);
        if (!b) return;
        activeBatchFilter = {
          id: b.id,
          filename: b.filename,
          trackings: new Set(b.trackingNumbers || []),
        };
        location.hash = 'control';
      });
    });

    container.querySelectorAll('.batch-toggle-chips-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const batchId = btn.dataset.batchId;
        const drawer = $(`#drawer-${CSS.escape(batchId)}`);
        if (drawer) {
          drawer.hidden = !drawer.hidden;
          const count = btn.dataset.count || '0';
          btn.textContent = drawer.hidden ? `Colli (${count}) ▾` : `Nascondi colli ▴`;
        }
      });
    });

    container.querySelectorAll('.open-batch-chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        const trk = btn.dataset.tracking;
        if (trk) void openShipmentDetail(trk);
      });
    });

    container.querySelectorAll('.batch-delete-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const batch = batches.find((item) => item.id === btn.dataset.batchId);
        const dialog = $('#delete-batch-dialog');
        if (!batch || !dialog) return;
        dialog.dataset.batchId = batch.id;
        $('#delete-batch-name').textContent = batch.filename || 'Lotto di importazione';
        $('#delete-batch-meta').textContent = `${displayDateTime(batch.at)} · ${batch.trackingNumbers?.length || 0} colli`;
        tell('#delete-batch-message', '');
        dialog.showModal();
      });
    });
  } catch (err) {
    container.innerHTML = `<div class="control-empty">Errore caricamento lotti: ${escapeHtml(err.message)}</div>`;
  }
}

async function loadAuditLog() {
  const tbody = $('#audit-log-table tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="7" class="control-empty">Caricamento eventi in corso…</td></tr>';

  const params = new URLSearchParams();
  if (auditTypeFilter) params.set('type', auditTypeFilter);
  if (auditSearchQuery) params.set('query', auditSearchQuery);

  if (auditDateFilter === 'today') {
    params.set('dateFrom', new Date().toISOString().slice(0, 10));
  } else if (auditDateFilter === '7d') {
    params.set('dateFrom', new Date(Date.now() - 7 * 24 * 3600_000).toISOString().slice(0, 10));
  } else if (auditDateFilter === '30d') {
    params.set('dateFrom', new Date(Date.now() - 30 * 24 * 3600_000).toISOString().slice(0, 10));
  }

  try {
    const data = await request(`/api/history/audit-log?${params}`);
    const badge = $('#audit-count-badge');
    if (badge) badge.textContent = data.total || 0;

    if (!data.events || !data.events.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="control-empty">Nessun evento registrato corrispondente ai filtri.</td></tr>';
      return;
    }
    tbody.innerHTML = data.events.map((ev) => {
      const typeClass = ev.type || 'info';
      return `
        <tr>
          <td>${displayDateTime(ev.at)}</td>
          <td><span class="audit-type-badge ${escapeHtml(typeClass)}">${escapeHtml(ev.type || 'info')}</span></td>
          <td><button type="button" class="open-audit-tracking-btn text-button" data-tracking="${escapeHtml(ev.trackingNumber)}" style="background:none;border:none;padding:0;color:var(--dsv-blue);cursor:pointer;font-family:monospace;font-weight:700;">${escapeHtml(ev.trackingNumber)}</button></td>
          <td>${escapeHtml(ev.orderReference || '—')}</td>
          <td>${dsvBadge(ev.dsvStatus)}</td>
          <td><strong>${escapeHtml(ev.label || '—')}</strong></td>
          <td>${escapeHtml(ev.detail || '—')}</td>
        </tr>
      `;
    }).join('');

    tbody.querySelectorAll('.open-audit-tracking-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const trk = btn.dataset.tracking;
        if (trk) void openShipmentDetail(trk);
      });
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="control-empty">Errore caricamento audit log: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function setShipmentDetailFeedback(message, kind = '') {
  const feedback = $('#shipment-detail-feedback');
  if (!feedback) {
    tell('#control-dsv-message', message, kind);
    return;
  }
  feedback.hidden = !message;
  feedback.className = `detail-feedback ${kind}`.trim();
  feedback.textContent = message;
}

function allowShipmentDetailRefresh() {
  if (!shipmentDetailDirty) return true;
  const discard = window.confirm('Hai modifiche non salvate nella gestione eccezione. Vuoi continuare senza salvarle?');
  if (discard) shipmentDetailDirty = false;
  return discard;
}

function renderShipmentAlignment(shipment, mappedState) {
  const aligned = isPrestaShopStateAligned(shipment);
  const hasOrder = Boolean(shipment.orderId);
  const eventAge = relativeAge(shipment.dsvStatusAt || shipment.dsvStatusDateRaw);
  const checkedAt = parseFlexibleDate(shipment.dsvCheckedAt || shipment.lastSeenAt);
  const isStale = Boolean(checkedAt && Date.now() - checkedAt.getTime() > 24 * 60 * 60 * 1000);
  const resultKind = aligned ? 'aligned' : hasOrder ? 'mismatch' : 'unavailable';
  const resultLabel = aligned ? 'Allineato' : hasOrder ? (mappedState ? 'Da aggiornare' : 'Mappatura richiesta') : 'Ordine non collegato';
  let resultHint = aligned
    ? 'DSV e PrestaShop coincidono'
    : mappedState
      ? `Stato previsto: ${mappedState.stateName}`
      : hasOrder ? 'Scegli lo stato PrestaShop corretto' : 'Nessun ordine associato alla spedizione';
  if (isStale) resultHint += ' · Verifica DSV consigliata';
  const alignmentAction = !hasOrder
    ? '<button id="link-detail-prestashop-order" type="button" class="alignment-text-action">Collega ordine</button>'
    : !mappedState
      ? '<button id="configure-detail-state-mapping" type="button" class="alignment-text-action">Configura mappatura</button>'
      : '';
  return `<section class="shipment-alignment ${resultKind}${isStale ? ' stale' : ''}" aria-labelledby="shipment-alignment-title"><div class="alignment-state"><span class="alignment-label" id="shipment-alignment-title">Stato DSV</span>${dsvBadge(shipment.dsvStatus)}${shipment.dsvPhaseStatus ? `<small>Fase: ${escapeHtml(shipment.dsvPhaseStatus)}</small>` : ''}<small>Evento: ${displayDsvEventDate(shipment)}${eventAge ? ` · ${escapeHtml(eventAge)}` : ''}</small>${shipment.dsvEventReason ? `<small title="Motivo dichiarato da DSV">${escapeHtml(shipment.dsvEventReason)}</small>` : ''}</div><div class="alignment-direction" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12h14M14 7l5 5-5 5"/></svg></div><div class="alignment-state"><span class="alignment-label">Stato PrestaShop</span>${prestaShopBadge(shipment.currentState)}<small>${escapeHtml(shipment.orderId ? `Ordine ${shipment.orderReference || shipment.orderId}` : 'Ordine non collegato')}</small></div><div class="alignment-outcome"><span class="alignment-label">Allineamento</span><span class="alignment-result ${resultKind}"><span class="status-dot" aria-hidden="true"></span>${escapeHtml(resultLabel)}</span><small>${escapeHtml(resultHint)}</small>${alignmentAction}</div></section>`;
}

function renderShipmentCaseManagement(shipment) {
  const hasCase = Boolean(shipment.caseStatus);
  const shouldOpen = hasCase || shipment.operationalStatus === 'Da gestire';
  const summaryTitle = hasCase ? shipment.caseStatus : 'Nessuna eccezione aperta';
  const summaryHint = hasCase
    ? (shipment.assignee ? `Assegnata a ${shipment.assignee}` : 'Non assegnata')
    : shouldOpen ? 'Richiede una decisione operativa' : 'Apri solo quando serve un intervento';

  return `<details id="shipment-case-disclosure" class="shipment-case-disclosure"${shouldOpen ? ' open' : ''}><summary><span><strong>Gestione eccezione</strong><small>${escapeHtml(summaryHint)}</small></span><span class="case-disclosure-state">${hasCase ? caseBadge(shipment.caseStatus) : escapeHtml(summaryTitle)}</span></summary><form id="shipment-case-form" class="shipment-case"><div class="case-fields"><label>Stato<select id="case-status"><option${!shipment.caseStatus || shipment.caseStatus === 'Aperta' ? ' selected' : ''}>Aperta</option><option${shipment.caseStatus === 'In lavorazione' ? ' selected' : ''}>In lavorazione</option><option${shipment.caseStatus === 'Risolta' ? ' selected' : ''}>Risolta</option><option${shipment.caseStatus === 'Ignorata' ? ' selected' : ''}>Ignorata</option></select></label><label>Assegnata a<input id="case-assignee" maxlength="120" value="${escapeHtml(shipment.assignee || '')}" placeholder="Nome operatore"></label></div><label>Nota interna<textarea id="case-note" maxlength="2000" rows="3" placeholder="Aggiungi contesto per il prossimo operatore…">${escapeHtml(shipment.note || '')}</textarea></label><button>Salva gestione</button></form></details>`;
}

function renderShipmentLocalActivity(shipment) {
  const events = Array.isArray(shipment.events) ? shipment.events : [];
  const countLabel = `${events.length} ${events.length === 1 ? 'evento' : 'eventi'}`;
  const eventRows = events.slice().reverse().map((event) => `<li><span class="event-marker" aria-hidden="true"></span><div><time${dateTimeAttribute(event.at)}>${displayDateTime(event.at)}</time><strong>${escapeHtml(event.label)}</strong><span>${escapeHtml(event.detail || event.type)}</span></div></li>`).join('') || '<li class="detail-empty">Nessuna attività registrata.</li>';
  return `<details class="detail-history"><summary><span><strong>Attività interna</strong><small>Audit delle operazioni locali</small></span><span>${countLabel}</span></summary><ol class="shipment-events">${eventRows}</ol></details>`;
}

async function openShipmentDetail(trackingNumber, feedback = null) {
  try {
    const panel = $('#shipment-detail');
    if (panel.open && activeControlTrackingNumber && activeControlTrackingNumber !== trackingNumber && shipmentDetailDirty) {
      const discard = window.confirm('Hai modifiche non salvate nella gestione eccezione. Vuoi passare a un’altra spedizione senza salvarle?');
      if (!discard) return;
    }
    shipmentDetailDirty = false;
    const requestToken = ++controlDetailRequestToken;
    if (!panel.open) controlDetailTrigger = document.activeElement;
    const shipment = await request(`/api/control-center/${encodeURIComponent(trackingNumber)}`);
    if (requestToken !== controlDetailRequestToken) return;
    activeControlTrackingNumber = trackingNumber;
    document.querySelectorAll('#control-table tbody tr').forEach((row) => row.classList.toggle('active', row.dataset.tracking === trackingNumber));
    delete panel.dataset.empty;
    const fallbackTrackingUrl = `https://www.dsv.com/mydsv/tracking-public/?refNumber=${encodeURIComponent(shipment.trackingNumber)}&language_region=it-IT_IT`;
    const trackingUrl = shipment.dsvTrackingUrl || fallbackTrackingUrl;
    const dsvTimeline = shipmentDetailTimeline(shipment);
    const mappedState = mappedPrestaShopState(shipment);
    const canUpdateOrderState = Boolean(shipment.orderId) && !isPrestaShopStateAligned(shipment);
    const navigation = shipmentDetailNavigation(shipment.trackingNumber);
    const checkedAge = relativeAge(shipment.dsvCheckedAt || shipment.lastSeenAt);
    const updateAction = canUpdateOrderState
      ? `<button id="update-detail-prestashop-state" type="button"><span>Aggiorna PrestaShop</span><small>${escapeHtml(mappedState ? `Imposta ${mappedState.stateName}` : 'Scegli lo stato')}</small></button>`
      : '';
    const archiveAction = shipment.archived
      ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 5.5h12v8.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5.5zM1 2.5h14v3H1zM6 9.5l2-2 2 2M8 7.5v5"/></svg><span>Ripristina spedizione</span>'
      : '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 5.5h12v8.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5.5zM1 2.5h14v3H1zM6 9.5h4"/></svg><span>Archivia spedizione</span>';
    const deleteAction = shipment.archived
      ? '<button id="delete-archived-shipment" type="button" class="danger-text"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4h11M6 4V2.5h4V4m-6 0 .6 10h6.8L12 4M6.5 6.5v5M9.5 6.5v5"/></svg><span>Elimina definitivamente</span></button>'
      : '';

    panel.innerHTML = `<div class="detail-heading"><div><h2 id="shipment-detail-title" class="detail-title-row">${copyableValue(shipment.trackingNumber, 'Numero spedizione', 'detail-tracking-btn')}</h2><span class="detail-order">Ordine ${copyableValue(shipment.orderReference, 'Riferimento ordine', 'detail-order-btn')}${shipment.archived ? '<span class="detail-archived-label">Archiviata</span>' : ''}</span></div><button id="close-shipment-detail" type="button" class="detail-close" aria-label="Chiudi dettaglio"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg></button></div>${renderShipmentAlignment(shipment, mappedState)}<div id="shipment-detail-feedback" class="detail-feedback" role="status" aria-live="polite" hidden></div><div class="detail-dialog-body"><div class="detail-dialog-primary">${renderShipmentDsvTimeline(dsvTimeline, trackingUrl)}</div><aside class="detail-dialog-operations" aria-label="Gestione operativa"><dl class="detail-operations-summary"><div><dt>Ultimo controllo</dt><dd>${displayDateTime(shipment.dsvCheckedAt || shipment.lastSeenAt)}</dd></div><div><dt>Gestione</dt><dd>${caseBadge(shipment.caseStatus)}</dd></div><div><dt>Assegnata a</dt><dd>${escapeHtml(shipment.assignee || 'Non assegnata')}</dd></div></dl><div id="detail-prestashop-sync" class="detail-prestashop-sync-card"><div class="sync-loading-skeleton" role="status"><span class="sync-live-dot loading" aria-hidden="true"></span><span>Verifica collegamento PrestaShop…</span></div></div>${renderShipmentCaseManagement(shipment)}${renderShipmentLocalActivity(shipment)}</aside></div><div class="detail-actions"><div class="detail-actions-main">${updateAction}<button id="verify-single-dsv" type="button" class="${canUpdateOrderState ? 'secondary' : ''}" ${dsvBetaSettings?.enabled ? '' : 'disabled'}>${shipment.archived ? 'Forza verifica DSV' : 'Verifica DSV'}</button><a class="dsv-external-link" href="${escapeHtml(trackingUrl)}" target="_blank" rel="noopener noreferrer">Apri su DSV <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 5h9v9M19 5l-9 9M14 19H5V10"/></svg></a></div><details class="detail-more-menu"><summary aria-label="Altre azioni"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg></summary><div><button id="toggle-archive-shipment" type="button" title="${shipment.archived ? 'Ripristina tra le spedizioni attive' : 'Archivia la spedizione per escluderla dai controlli automatici'}">${archiveAction}</button>${deleteAction}</div></details></div>`;
    const closeButton = panel.querySelector('#close-shipment-detail');
    closeButton.insertAdjacentHTML('beforebegin', `<nav class="detail-record-navigation" aria-label="Navigazione spedizioni nella pagina"><button id="shipment-detail-previous" type="button" aria-label="Spedizione precedente, scorciatoia K" aria-keyshortcuts="K"${navigation.previous ? '' : ' disabled'}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6"/></svg></button><span>${navigation.index >= 0 ? navigation.index + 1 : '—'} di ${navigation.total}</span><button id="shipment-detail-next" type="button" aria-label="Spedizione successiva, scorciatoia J" aria-keyshortcuts="J"${navigation.next ? '' : ' disabled'}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 6 6 6-6 6"/></svg></button></nav>`);
    const lastCheckValue = panel.querySelector('.detail-operations-summary dd');
    if (lastCheckValue && checkedAge) lastCheckValue.insertAdjacentHTML('beforeend', `<small class="detail-freshness${panel.querySelector('.shipment-alignment.stale') ? ' stale' : ''}">${escapeHtml(checkedAge)}</small>`);
    const caseForm = panel.querySelector('#shipment-case-form');
    const caseSaveButton = caseForm.querySelector('button');
    caseSaveButton.disabled = true;
    panel.querySelector('#verify-single-dsv')?.setAttribute('aria-keyshortcuts', 'V');
    panel.querySelector('#update-detail-prestashop-state')?.setAttribute('aria-keyshortcuts', 'U');
    const heading = panel.querySelector('.detail-heading');
    heading.setAttribute('tabindex', '-1');
    panel.setAttribute('aria-labelledby', 'shipment-detail-title');
    if (!panel.open) panel.showModal();
    $('#close-shipment-detail').addEventListener('click', closeControlDetail);
    setTimeout(() => heading.focus(), 0);
    if (feedback?.message) setShipmentDetailFeedback(feedback.message, feedback.kind || 'success');
    loadPrestaShopLiveSync(shipment, requestToken);
    $('#shipment-detail-previous')?.addEventListener('click', () => navigation.previous && openShipmentDetail(navigation.previous));
    $('#shipment-detail-next')?.addEventListener('click', () => navigation.next && openShipmentDetail(navigation.next));
    $('#configure-detail-state-mapping')?.addEventListener('click', () => {
      if (closeControlDetail() === false) return;
      location.hash = 'settings';
      setTimeout(() => $('#state-mapping-view')?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 120);
    });
    $('#link-detail-prestashop-order')?.addEventListener('click', () => openPrestaShopLinkDialog(shipment));
    $('#update-detail-prestashop-state')?.addEventListener('click', () => {
      if (allowShipmentDetailRefresh()) openPrestaShopStateDialog(shipment.trackingNumber);
    });
    $('#verify-single-dsv').addEventListener('click', async () => {
      if (!allowShipmentDetailRefresh()) return;
      const button = $('#verify-single-dsv'); button.disabled = true;
      setShipmentDetailFeedback('Verifica DSV in corso…');
      try { await startControlDsvVerification([shipment.trackingNumber]); await openShipmentDetail(shipment.trackingNumber, { message: 'Verifica DSV completata.', kind: 'success' }); }
      catch (e) { setShipmentDetailFeedback(e.message, 'error'); }
      finally { button.disabled = false; }
    });
    $('#toggle-archive-shipment')?.addEventListener('click', async () => {
      if (!allowShipmentDetailRefresh()) return;
      const button = $('#toggle-archive-shipment');
      button.disabled = true;
      const nextArchived = !shipment.archived;
      try {
        const res = await request(`/api/control-center/${encodeURIComponent(shipment.trackingNumber)}/archive`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ archived: nextArchived }),
        });
        await refreshControlCenter();
        await openShipmentDetail(shipment.trackingNumber, { message: res.message, kind: 'success' });
      } catch (e) {
        setShipmentDetailFeedback(e.message, 'error');
      } finally {
        button.disabled = false;
      }
    });
    $('#delete-archived-shipment')?.addEventListener('click', () => openDeleteShipmentDialog(shipment));
    caseForm.addEventListener('input', () => {
      shipmentDetailDirty = true;
      caseSaveButton.disabled = false;
    });
    caseForm.addEventListener('change', () => {
      shipmentDetailDirty = true;
      caseSaveButton.disabled = false;
    });
    caseForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = caseSaveButton; button.disabled = true;
      try {
        await request(`/api/control-center/${encodeURIComponent(shipment.trackingNumber)}/case`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ caseStatus: $('#case-status').value, assignee: $('#case-assignee').value, note: $('#case-note').value }) });
        shipmentDetailDirty = false;
        await refreshControlCenter(); await openShipmentDetail(shipment.trackingNumber, { message: 'Gestione salvata.', kind: 'success' });
      } catch (e) { setShipmentDetailFeedback(e.message, 'error'); }
      finally { button.disabled = false; }
    });
  } catch (e) {
    if ($('#shipment-detail')?.open) setShipmentDetailFeedback(e.message, 'error');
    else tell('#control-dsv-message', e.message, 'error');
  }
}

async function loadPrestaShopLiveSync(shipment, requestToken) {
  const container = $('#detail-prestashop-sync');
  if (!container) return;
  try {
    const res = await request(`/api/control-center/${encodeURIComponent(shipment.trackingNumber)}/prestashop-live`);
    if (requestToken !== controlDetailRequestToken) return;

    if (!res.ok) {
      if (res.notConfigured) {
        container.innerHTML = `<div class="sync-card-header"><span class="sync-card-title"><span class="sync-live-dot error" aria-hidden="true"></span>Collegamento PrestaShop</span></div><p class="sync-status-msg" style="color:var(--muted);margin:4px 0;">PrestaShop non configurato. Configura URL e chiave Webservice per verificare tracking e corriere.</p>`;
      } else {
        container.innerHTML = `<div class="sync-card-header"><span class="sync-card-title"><span class="sync-live-dot error" aria-hidden="true"></span>Collegamento PrestaShop</span><button id="retry-prestashop-live-btn" type="button" class="sync-refresh-btn" aria-label="Riprova verifica collegamento PrestaShop"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2v4h-4M2 14v-4h4"/><path d="M2.5 9a6 6 0 0 1 9.5-4.5L14 6M13.5 7a6 6 0 0 1-9.5 4.5L2 10"/></svg></button></div><p class="sync-status-msg" style="color:var(--danger);margin:4px 0;">${escapeHtml(res.error || 'Impossibile verificare tracking e corriere su PrestaShop.')}</p>`;
        $('#retry-prestashop-live-btn')?.addEventListener('click', () => {
          container.innerHTML = `<div class="sync-loading-skeleton" role="status"><span class="sync-live-dot loading" aria-hidden="true"></span><span>Verifica collegamento PrestaShop…</span></div>`;
          loadPrestaShopLiveSync(shipment, requestToken);
        });
      }
      return;
    }

    const { orderReference, liveTracking, dsvTracking, trackingStatus, liveCarrierName, defaultCarrierId, defaultCarrierName, carrierMatches } = res;

    let badgeHtml = '';
    if (trackingStatus === 'matches') {
      badgeHtml = `<span class="sync-badge matches"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 8.5 6.5 12 13 4"/></svg><span>Sincronizzato</span>${copyableValue(liveTracking, 'Tracking PrestaShop', 'live-tracking-copy-btn')}</span>`;
    } else if (trackingStatus === 'missing') {
      badgeHtml = `<span class="sync-badge missing"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="7"/><line x1="8" y1="5" x2="8" y2="8"/><circle cx="8" cy="11" r="0.75" fill="currentColor"/></svg> Non presente su PrestaShop</span>`;
    } else {
      badgeHtml = `<span class="sync-badge differs"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="7"/><line x1="8" y1="5" x2="8" y2="8"/><circle cx="8" cy="11" r="0.75" fill="currentColor"/></svg><span>Diverso</span>${copyableValue(liveTracking, 'Tracking PrestaShop', 'live-tracking-copy-btn')}</span>`;
    }

    let actionHtml = '';
    if (trackingStatus === 'missing') {
      actionHtml = `<button id="sync-prestashop-btn" type="button" class="sync-action-btn primary"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v8M4 7l4 4 4-4M2 13h12"/></svg><span>Importa tracking e imposta ${escapeHtml(defaultCarrierName || 'corriere')}</span></button>`;
    } else if (trackingStatus === 'matches' && !carrierMatches) {
      actionHtml = `<button id="sync-prestashop-btn" type="button" class="sync-action-btn primary"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2v4h-4M2 14v-4h4"/><path d="M2.5 9a6 6 0 0 1 9.5-4.5L14 6M13.5 7a6 6 0 0 1-9.5 4.5L2 10"/></svg><span>Allinea corriere a ${escapeHtml(defaultCarrierName)}</span></button>`;
    } else if (trackingStatus === 'matches' && carrierMatches) {
      actionHtml = `<span class="sync-status-msg success"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 8.5 6.5 12 13 4"/></svg> Tracking e corriere sincronizzati su PrestaShop</span>`;
    } else if (trackingStatus === 'differs') {
      actionHtml = `<button id="sync-prestashop-btn" type="button" class="sync-action-btn warning" data-overwrite="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg><span>Sovrascrivi tracking con ${escapeHtml(dsvTracking)}</span></button>`;
    }
    const linkOrderHtml = !shipment.orderId
      ? `<button id="link-live-prestashop-order" type="button" class="sync-action-btn primary"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 9.5 9.5 6.5M5 11l-1 1a2.1 2.1 0 0 1-3-3l3-3a2.1 2.1 0 0 1 3 0M11 5l1-1a2.1 2.1 0 0 1 3 3l-3 3a2.1 2.1 0 0 1-3 0"/></svg><span>Registra collegamento all’ordine ${escapeHtml(orderReference || res.orderId)}</span></button>`
      : '';

    container.innerHTML = `
      <div class="sync-card-header">
        <span class="sync-card-title">
          <span class="sync-live-dot" aria-hidden="true"></span>
          Collegamento PrestaShop
        </span>
        <button id="refresh-prestashop-live-btn" type="button" class="sync-refresh-btn" aria-label="Aggiorna collegamento PrestaShop">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2v4h-4M2 14v-4h4"/><path d="M2.5 9a6 6 0 0 1 9.5-4.5L14 6M13.5 7a6 6 0 0 1-9.5 4.5L2 10"/></svg>
        </button>
      </div>
      <div class="sync-grid">
        <div class="sync-field">
          <span class="sync-field-label">Tracking su PrestaShop</span>
          ${badgeHtml}
        </div>
        <div class="sync-field">
          <span class="sync-field-label">Corriere su PrestaShop</span>
          <div class="sync-carrier-val"><strong>${escapeHtml(liveCarrierName || 'Non assegnato')}</strong></div>
          <span class="sync-carrier-hint ${carrierMatches ? 'match' : 'mismatch'}">${carrierMatches ? '✓ Allineato a ' + escapeHtml(defaultCarrierName) : 'Configurato per DSV: ' + escapeHtml(defaultCarrierName || 'Non configurato')}</span>
        </div>
      </div>
      <div class="sync-actions-row">
        ${linkOrderHtml}
        ${actionHtml}
      </div>
    `;

    $('#refresh-prestashop-live-btn')?.addEventListener('click', () => {
      $('#refresh-prestashop-live-btn').classList.add('spinning');
      loadPrestaShopLiveSync(shipment, requestToken);
    });
    $('#link-live-prestashop-order')?.addEventListener('click', () => openPrestaShopLinkDialog(shipment, orderReference || res.orderId));

    const syncBtn = $('#sync-prestashop-btn');
    if (syncBtn) {
      syncBtn.addEventListener('click', async () => {
        if (!allowShipmentDetailRefresh()) return;
        const isOverwrite = Boolean(syncBtn.dataset.overwrite);
        if (isOverwrite) {
          const confirmMsg = `Attenzione: su PrestaShop è presente il tracking "${liveTracking}".\n\nVuoi davvero sovrascriverlo con "${dsvTracking}" e impostare il corriere "${defaultCarrierName}"?`;
          if (!window.confirm(confirmMsg)) return;
        }
        syncBtn.disabled = true;
        const originalContent = syncBtn.innerHTML;
        syncBtn.innerHTML = '<span>Aggiornamento in corso…</span>';
        try {
          const result = await request(`/api/control-center/${encodeURIComponent(shipment.trackingNumber)}/sync-prestashop`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ overwrite: isOverwrite, carrierId: defaultCarrierId }),
          });
          await refreshControlCenter();
          await openShipmentDetail(shipment.trackingNumber, { message: result.message, kind: 'success' });
        } catch (err) {
          setShipmentDetailFeedback(err.message, 'error');
          syncBtn.disabled = false;
          syncBtn.innerHTML = originalContent;
        }
      });
    }
  } catch (err) {
    if (requestToken !== controlDetailRequestToken) return;
    container.innerHTML = `<div class="sync-card-header"><span class="sync-card-title"><span class="sync-live-dot error" aria-hidden="true"></span>Collegamento PrestaShop</span></div><p class="sync-status-msg" style="color:var(--danger);margin:4px 0;">Errore: ${escapeHtml(err.message)}</p>`;
  }
}

$('#config-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try { const config = await request('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseUrl: $('#base-url').value, apiKey: $('#api-key').value }) }); tell('#connection-message', config.configured ? 'Connessione salvata. Verifica ora i permessi del Webservice.' : 'URL salvato. Inserisci anche la chiave Webservice.', config.configured ? 'success' : 'warning'); $('#config-form').dataset.configured = config.configured ? 'true' : 'false'; $('#api-key').value = ''; markSettingsClean('connections'); updateSettingsHealth(); showFloatingToast('Connessione PrestaShop salvata!', 'success'); }
  catch (e) { tell('#connection-message', e.message, 'error'); }
});

$('#test-connection').addEventListener('click', async () => {
  try {
    $('#test-connection').disabled = true; tell('#connection-message', 'Controllo connessione e autorizzazioni in corso…');
    const { results, passed } = await request('/api/config/test', { method: 'POST' });
    const panel = $('#permission-check'); panel.hidden = false;
    panel.innerHTML = `<h3>${passed ? 'Connessione pronta' : 'Permessi da correggere'}</h3><p>Il test di scrittura usa richieste intenzionalmente non valide: non modifica ordini né spedizioni.</p><div class="permission-grid">${results.map((item) => `<div class="permission ${item.authorized ? 'pass' : 'fail'}"><strong>${item.authorized ? '✓' : '!'} ${escapeHtml(item.label)}</strong><span>${item.method} · HTTP ${item.status}</span><small>${escapeHtml(item.detail)}</small></div>`).join('')}</div>`;
    tell('#connection-message', passed ? 'Tutte le autorizzazioni necessarie sono disponibili.' : 'Alcune autorizzazioni richieste non sono disponibili.', passed ? 'success' : 'error');
    setSettingsTestResult('prestashop', passed, passed ? `Permessi Webservice verificati per ${$('#base-url').value}` : 'Correggi i permessi evidenziati e ripeti il test.');
  } catch (e) { tell('#connection-message', e.message, 'error'); setSettingsTestResult('prestashop', false, e.message); }
  finally { $('#test-connection').disabled = false; }
});

async function loadCatalog(silent = false) {
  try {
    const [{ statuses, carriers }, defCarrier] = await Promise.all([
      request('/api/catalog'),
      request('/api/settings/default-carrier').catch(() => ({})),
    ]);
    const fill = (el, rows, label) => {
      if (!el) return;
      el.innerHTML = `<option value="">Seleziona ${label}</option>` + rows.map((x) => `<option value="${escapeHtml(x.id)}">${escapeHtml(x.name)}</option>`).join('');
    };
    fill($('#state'), statuses, 'uno stato');
    fill($('#import-state'), statuses, 'uno stato');
    fill($('#carrier'), carriers, 'un corriere');
    fill($('#import-carrier'), carriers, 'un corriere');

    const savedCarrier = localStorage.getItem('dsv_preferred_carrier') || defCarrier?.defaultCarrierId;
    if (savedCarrier) {
      if ($('#carrier')) $('#carrier').value = savedCarrier;
      if ($('#import-carrier')) $('#import-carrier').value = savedCarrier;
    }
    const savedState = localStorage.getItem('dsv_preferred_state');
    if (savedState) {
      if ($('#state')) $('#state').value = savedState;
      if ($('#import-state')) $('#import-state').value = savedState;
    }
    if (!silent) {
      tell('#catalog-message', `${statuses.length} stati e ${carriers.length} corrieri disponibili.`, 'success');
    }
  } catch (e) {
    if (!silent) tell('#catalog-message', e.message, 'error');
  }
}

function syncCarrier(carrierId, carrierName = '') {
  if ($('#carrier') && $('#carrier').value !== carrierId) $('#carrier').value = carrierId;
  if ($('#import-carrier') && $('#import-carrier').value !== carrierId) $('#import-carrier').value = carrierId;
  if (carrierId) {
    localStorage.setItem('dsv_preferred_carrier', carrierId);
    request('/api/settings/default-carrier', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ carrierId, carrierName }),
    }).catch(() => {});
  }
}

$('#load-catalog')?.addEventListener('click', () => loadCatalog(false));

$('#carrier')?.addEventListener('change', () => {
  const select = $('#carrier');
  syncCarrier(select.value, select.options[select.selectedIndex]?.textContent || '');
});

$('#import-carrier')?.addEventListener('change', () => {
  const select = $('#import-carrier');
  syncCarrier(select.value, select.options[select.selectedIndex]?.textContent || '');
});

$('#state')?.addEventListener('change', () => {
  const select = $('#state');
  if ($('#import-state')) $('#import-state').value = select.value;
  if (select.value) localStorage.setItem('dsv_preferred_state', select.value);
});

$('#import-state')?.addEventListener('change', () => {
  const select = $('#import-state');
  if ($('#state')) $('#state').value = select.value;
  if (select.value) localStorage.setItem('dsv_preferred_state', select.value);
});

$('#carrier')?.addEventListener('change', async () => {
  const select = $('#carrier');
  const carrierId = select.value;
  const carrierName = select.options[select.selectedIndex]?.textContent || '';
  if (carrierId) {
    try {
      await request('/api/settings/default-carrier', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ carrierId, carrierName }),
      });
    } catch { /* silent */ }
  }
});

$('#tab-import-excel')?.addEventListener('click', () => {
  $('#tab-import-excel').classList.add('active');
  $('#tab-import-excel').setAttribute('aria-selected', 'true');
  $('#tab-import-manual').classList.remove('active');
  $('#tab-import-manual').setAttribute('aria-selected', 'false');
  $('#excel-import-panel').hidden = false;
  $('#manual-import-panel').hidden = true;
  currentImportOrigin = 'excel';
});

$('#tab-import-manual')?.addEventListener('click', () => {
  $('#tab-import-manual').classList.add('active');
  $('#tab-import-manual').setAttribute('aria-selected', 'true');
  $('#tab-import-excel').classList.remove('active');
  $('#tab-import-excel').setAttribute('aria-selected', 'false');
  $('#excel-import-panel').hidden = true;
  $('#manual-import-panel').hidden = false;
  currentImportOrigin = 'manual';
  currentImportFileName = 'Inserimento manuale';
  $('#manual-tracking')?.focus();
});

$('#manual-import-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const trackingInput = $('#manual-tracking');
  const orderRefInput = $('#manual-order-ref');
  const trackingNumber = trackingInput.value.trim();
  const orderReference = orderRefInput.value.trim();
  if (!trackingNumber || !orderReference) return;

  const alreadyInPreview = previewRows.some((r) =>
    (r.trackingNumber && r.trackingNumber.toLowerCase() === trackingNumber.toLowerCase()) ||
    (r.orderReference && r.orderReference.toLowerCase() === orderReference.toLowerCase())
  );
  if (alreadyInPreview) {
    tell('#import-message', `Attenzione: la spedizione “${trackingNumber}” o il riferimento “${orderReference}” è già presente nella lista di anteprima.`, 'error');
    return;
  }

  try {
    const nextSourceRow = previewRows.length ? Math.max(...previewRows.map((r) => r.sourceRow || 0)) + 1 : 1;
    const row = await request('/api/import/manual-row', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackingNumber, orderReference, sourceRow: nextSourceRow }),
    });

    previewRows.push(row);
    verificationId = '';
    importApplied = false;
    $('#summary').hidden = false;
    $('#verify-progress').hidden = true;
    $('#apply-feedback').hidden = true;
    if ($('#apply-progress')) $('#apply-progress').hidden = true;

    const total = previewRows.length;
    const ready = previewRows.filter((r) => r.validation === 'Pronta per la verifica' && !r.alreadyImported).length;
    const skipped = previewRows.filter((r) => r.alreadyImported).length;
    const invalid = previewRows.filter((r) => !r.alreadyImported && r.validation !== 'Pronta per la verifica').length;
    $('#summary').textContent = `${total} righe in lista · ${ready} nuove candidate · ${skipped ? `${skipped} già importate (saltate) · ` : ''}${invalid} da controllare`;

    renderRows(previewRows);
    $('#preview').hidden = false;
    $('#verify-import').hidden = ready === 0;
    $('#apply-import').hidden = true;
    $('#select-all').hidden = true;
    $('#clear-selection').hidden = true;
    $('#toggle-all').hidden = true;
    $('#selected-count').hidden = true;
    $('#update-options').hidden = true;
    $('#dsv-beta').hidden = true;
    $('#verify-dsv-beta').hidden = true;

    if (row.alreadyImported) {
      tell('#import-message', `Spedizione ${trackingNumber} aggiunta come “Già importata (saltata)”: tracking già presente (${row.existingTracking}).`, 'warning');
    } else {
      tell('#import-message', `Spedizione ${trackingNumber} (Rif. ${orderReference}) aggiunta alla lista. Puoi aggiungerne altre o avviare la verifica.`, 'success');
    }

    trackingInput.value = '';
    orderRefInput.value = '';
    trackingInput.focus();
  } catch (e) {
    tell('#import-message', e.message, 'error');
  }
});

$('#manual-clear-btn')?.addEventListener('click', () => {
  if (!previewRows.length) return;
  if (!window.confirm('Vuoi davvero svuotare la lista delle spedizioni in anteprima?')) return;
  previewRows = [];
  verificationId = '';
  importApplied = false;
  $('#summary').hidden = true;
  $('#preview').hidden = true;
  $('#preview tbody').innerHTML = '';
  $('#verify-import').hidden = true;
  $('#apply-import').hidden = true;
  $('#select-all').hidden = true;
  $('#clear-selection').hidden = true;
  $('#toggle-all').hidden = true;
  $('#selected-count').hidden = true;
  $('#update-options').hidden = true;
  $('#dsv-beta').hidden = true;
  $('#verify-dsv-beta').hidden = true;
  tell('#import-message', 'Lista di anteprima svuotata.', 'success');
  $('#manual-tracking')?.focus();
});

async function startUnifiedImport(fileObj) {
  if (!fileObj) return;
  currentImportFileName = fileObj.name || 'File Excel';
  currentImportOrigin = 'excel';

  const dropZone = $('#import-drop-zone');
  const activeFileBox = $('#drop-zone-active-file');
  const activeFilename = $('#active-filename');
  if (dropZone) dropZone.classList.add('has-file');
  if (activeFileBox) activeFileBox.hidden = false;
  if (activeFilename) {
    const sizeKb = Math.round(fileObj.size / 1024);
    activeFilename.textContent = `${fileObj.name} (${sizeKb} KB)`;
  }

  previewRows = [];
  verificationId = '';
  importApplied = false;
  currentVerificationJobId = null;
  currentPreviewTab = 'ready';

  if ($('#import-success-card')) $('#import-success-card').hidden = true;
  if ($('#apply-feedback')) $('#apply-feedback').hidden = true;
  if ($('#apply-progress')) $('#apply-progress').hidden = true;

  tell('#import-message', 'Lettura ed analisi del file in corso…');

  try {
    const form = new FormData();
    form.append('file', fileObj);
    const { summary, rows } = await request('/api/import/preview', { method: 'POST', body: form });

    previewRows = rows.map((r) => {
      if (r.alreadyImported) {
        return { ...r, verification: 'Tracking già presente', canApply: false };
      }
      if (r.validation !== 'Pronta per la verifica') {
        return { ...r, verification: r.validation, canApply: false };
      }
      return { ...r, verification: 'In verifica…', canApply: false };
    });

    if ($('#summary')) {
      $('#summary').hidden = false;
      $('#summary').textContent = `${summary.total} righe lette · ${summary.ready} nuove candidate · ${summary.skipped ? `${summary.skipped} già presenti (saltate) · ` : ''}${summary.invalid} da controllare`;
    }

    if ($('#import-preview-tabs')) $('#import-preview-tabs').hidden = false;
    if ($('#import-action-bar')) $('#import-action-bar').hidden = false;
    if ($('#preview')) $('#preview').hidden = false;

    renderRows(previewRows);
    updatePreviewTabCounts();
    updateSelectionUi();

    const readyToVerify = previewRows.filter((row) => row.validation === 'Pronta per la verifica' && !row.alreadyImported);

    if (readyToVerify.length === 0) {
      if ($('#verify-progress')) $('#verify-progress').hidden = true;
      if ($('#cancel-verify-btn')) $('#cancel-verify-btn').hidden = true;
      tell('#import-message', summary.skipped ? `Analisi completata: tutte le ${summary.skipped} spedizioni sono già presenti nel sistema.` : 'File analizzato: nessuna riga idonea da verificare.', 'warning');
      return;
    }

    if ($('#verify-progress')) $('#verify-progress').hidden = false;
    if ($('#cancel-verify-btn')) $('#cancel-verify-btn').hidden = false;
    updateProgress({ completed: 0, total: readyToVerify.length });
    tell('#import-message', `Verifica in tempo reale su PrestaShop (${readyToVerify.length} ordini)…`);

    const { jobId } = await request('/api/import/verification-jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows: previewRows, filename: currentImportFileName, origin: currentImportOrigin }),
    });
    currentVerificationJobId = jobId;

    const result = await waitForVerification(jobId);
    if (result.cancelled) {
      tell('#import-message', 'Verifica annullata dall’utente.', 'warning');
      if ($('#verify-progress')) $('#verify-progress').hidden = true;
      if ($('#cancel-verify-btn')) $('#cancel-verify-btn').hidden = true;
      return;
    }

    const { summary: verifySummary, rows: verifiedRows, requestPlan, verificationId: resultId } = result;
    verificationId = resultId;
    currentVerificationJobId = null;
    importApplied = false;

    if ($('#verify-progress')) $('#verify-progress').hidden = true;
    if ($('#cancel-verify-btn')) $('#cancel-verify-btn').hidden = true;

    previewRows = verifiedRows.map((row) => ({
      ...row,
      selected: row.verification === 'Pronta per aggiornamento',
    }));

    const readyCount = previewRows.filter((row) => row.verification === 'Pronta per aggiornamento').length;
    const skippedCount = previewRows.filter((row) => row.verification === 'Tracking già presente' || row.alreadyImported || row.verification?.includes('saltata')).length;

    if ($('#summary')) {
      $('#summary').textContent = `${readyCount} pronte per aggiornamento · ${skippedCount} saltate (già presenti/importate) · ${previewRows.length - readyCount - skippedCount} da controllare`;
    }

    renderRows(previewRows, 'verification');
    updateSelectionUi();
    void refreshControlCenter();

    tell(
      '#import-message',
      `${readyCount} ordini pronti per l'aggiornamento (${skippedCount} già presenti e saltati). Seleziona il corriere e conferma.`,
      skippedCount ? 'warning' : 'success'
    );
  } catch (e) {
    if ($('#verify-progress')) $('#verify-progress').hidden = true;
    if ($('#cancel-verify-btn')) $('#cancel-verify-btn').hidden = true;
    tell('#import-message', e.message, 'error');
  }
}

function resetImportWorkspace() {
  if (currentVerificationJobId) {
    request(`/api/import/verification-jobs/${encodeURIComponent(currentVerificationJobId)}/cancel`, { method: 'POST' }).catch(() => {});
    currentVerificationJobId = null;
  }
  const dropZone = $('#import-drop-zone');
  const activeFileBox = $('#drop-zone-active-file');
  const fileInput = $('#file');
  if (dropZone) dropZone.classList.remove('has-file', 'drag-over');
  if (activeFileBox) activeFileBox.hidden = true;
  if (fileInput) fileInput.value = '';

  previewRows = [];
  verificationId = '';
  importApplied = false;

  if ($('#summary')) $('#summary').hidden = true;
  if ($('#import-preview-tabs')) $('#import-preview-tabs').hidden = true;
  if ($('#import-action-bar')) $('#import-action-bar').hidden = true;
  if ($('#preview')) {
    $('#preview').hidden = true;
    const tbody = $('#preview tbody');
    if (tbody) tbody.innerHTML = '';
  }
  if ($('#verify-progress')) $('#verify-progress').hidden = true;
  if ($('#cancel-verify-btn')) $('#cancel-verify-btn').hidden = true;
  if ($('#apply-feedback')) $('#apply-feedback').hidden = true;
  if ($('#import-success-card')) $('#import-success-card').hidden = true;
  if ($('#apply-progress')) $('#apply-progress').hidden = true;
}

function showImportSuccessCard(summary, results) {
  const card = $('#import-success-card');
  const grid = $('#success-kpi-grid');
  const subtitle = $('#success-card-subtitle');
  if (!card || !grid) return;

  const updated = Number(summary.Aggiornata || 0);
  const errors = Number(summary.Errore || 0);
  const skipped = Number(summary.Saltata || 0);
  const total = results?.length || (updated + errors + skipped);

  if (subtitle) {
    subtitle.textContent = errors > 0
      ? `${updated} ordini aggiornati con successo, ${errors} con errori o avvisi.`
      : `Tutti i ${updated} ordini selezionati sono stati aggiornati su PrestaShop.`;
  }

  grid.innerHTML = `
    <div class="kpi-box success">
      <span class="kpi-num">${updated}</span>
      <span class="kpi-lbl">Aggiornati</span>
    </div>
    <div class="kpi-box ${errors > 0 ? 'error' : 'neutral'}">
      <span class="kpi-num">${errors}</span>
      <span class="kpi-lbl">Con errori</span>
    </div>
    <div class="kpi-box neutral">
      <span class="kpi-num">${skipped}</span>
      <span class="kpi-lbl">Saltati</span>
    </div>
    <div class="kpi-box neutral">
      <span class="kpi-num">${total}</span>
      <span class="kpi-lbl">Totale elaborati</span>
    </div>
  `;

  card.hidden = false;
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// Drop zone and file input listeners
const dropZone = $('#import-drop-zone');
const fileInput = $('#file');

if (dropZone && fileInput) {
  ['dragenter', 'dragover'].forEach((eventName) => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.add('drag-over');
    });
  });

  ['dragleave', 'dragend', 'drop'].forEach((eventName) => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.remove('drag-over');
    });
  });

  dropZone.addEventListener('drop', (e) => {
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      fileInput.files = files;
      startUnifiedImport(files[0]);
    }
  });

  dropZone.addEventListener('click', (e) => {
    if (e.target.closest('#cancel-file-btn')) return;
    fileInput.click();
  });

  dropZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      if (e.target.closest('#cancel-file-btn')) return;
      e.preventDefault();
      fileInput.click();
    }
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files.length > 0) {
      startUnifiedImport(fileInput.files[0]);
    }
  });
}

$('#cancel-file-btn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  resetImportWorkspace();
  tell('#import-message', 'File rimosso. Trascina o seleziona un nuovo file Excel.', 'success');
});

$('#cancel-verify-btn')?.addEventListener('click', async () => {
  if (currentVerificationJobId) {
    try {
      await request(`/api/import/verification-jobs/${encodeURIComponent(currentVerificationJobId)}/cancel`, { method: 'POST' });
      tell('#import-message', 'Annullamento in corso…', 'warning');
    } catch (e) {
      tell('#import-message', e.message, 'error');
    }
  }
});

$('#import-preview-tabs')?.addEventListener('click', (event) => {
  const pill = event.target.closest('.import-tab-pill');
  if (!pill) return;
  currentPreviewTab = pill.dataset.previewFilter || 'ready';
  document.querySelectorAll('.import-tab-pill').forEach((p) => {
    p.classList.toggle('active', p === pill);
  });
  renderRows();
});

$('#success-goto-control-btn')?.addEventListener('click', () => {
  location.hash = 'control';
  showView('control');
  setTimeout(() => {
    document.querySelector('.control-center-card')?.scrollIntoView({ behavior: 'smooth' });
  }, 100);
});

$('#success-export-csv-btn')?.addEventListener('click', () => {
  if (!previewRows.length) return;
  const headers = ['Riga', 'Riferimento Ordine', 'Numero Spedizione', 'Data Ordine', 'Stato PrestaShop', 'Stato DSV beta', 'Esito', 'Dettaglio'];
  const csvRows = [headers.join(';')];
  previewRows.forEach((r) => {
    const rowData = [
      r.sourceRow,
      `"${(r.orderReference || '').replace(/"/g, '""')}"`,
      `"${(r.trackingNumber || '').replace(/"/g, '""')}"`,
      `"${(displayDate(r.orderDate) || '').replace(/"/g, '""')}"`,
      `"${(r.currentState || '').replace(/"/g, '""')}"`,
      `"${(r.dsvBetaStatus || '').replace(/"/g, '""')}"`,
      `"${(r.applyResult || r.verification || r.validation || '').replace(/"/g, '""')}"`,
      `"${(r.applyDetail || (r.existingTracking ? `già presente: ${r.existingTracking}` : '')).replace(/"/g, '""')}"`,
    ];
    csvRows.push(rowData.join(';'));
  });

  const blob = new Blob(['\uFEFF' + csvRows.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `report-import-dsv-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

$('#success-new-import-btn')?.addEventListener('click', () => {
  resetImportWorkspace();
  document.querySelector('.import-card')?.scrollIntoView({ behavior: 'smooth' });
});

$('#upload-form')?.addEventListener('submit', (e) => {
  e.preventDefault();
  if (fileInput?.files?.[0]) startUnifiedImport(fileInput.files[0]);
});

$('#verify-import').addEventListener('click', async () => {
  try {
    $('#verify-import').disabled = true; updateProgress({ completed: 0, total: previewRows.filter((row) => row.validation === 'Pronta per la verifica' && !row.alreadyImported).length });
    tell('#import-message', 'Verifica in corso con richieste limitate, una alla volta…');
    const { jobId } = await request('/api/import/verification-jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows: previewRows, filename: currentImportFileName, origin: currentImportOrigin }),
    });
    const { summary, rows, requestPlan, verificationId: resultId } = await waitForVerification(jobId);
    verificationId = resultId; importApplied = false; $('#apply-feedback').hidden = true; if ($('#apply-progress')) $('#apply-progress').hidden = true; previewRows = rows.map((row) => ({ ...row, selected: row.verification === 'Pronta per aggiornamento' })); renderRows(previewRows, 'verification');
    const ready = previewRows.filter((row) => row.verification === 'Pronta per aggiornamento').length; const skipped = previewRows.filter((row) => row.verification === 'Tracking già presente' || row.alreadyImported || row.verification?.includes('saltata')).length;
    $('#summary').textContent = `${ready} pronte per aggiornamento · ${skipped} saltate (già presenti/importate) · ${previewRows.length - ready - skipped} da controllare`;
    $('#update-options').hidden = false; $('#dsv-beta').hidden = false; updateSelectionUi(); void refreshControlCenter();
    tell('#import-message', `${Object.entries(summary).map(([name, count]) => `${name}: ${count}`).join(' · ')}. Verifica eseguita in ${requestPlan.batches} blocchi, massimo ${requestPlan.maxRequests} richieste distanziate di ${requestPlan.intervalMs} ms.`, skipped ? 'warning' : 'success');
  } catch (e) { tell('#import-message', e.message, 'error'); }
  finally { $('#verify-import').disabled = false; }
});

$('#preview tbody').addEventListener('change', (event) => {
  if (!event.target.matches('.row-select')) return;
  const row = previewRows.find((item) => Number(item.sourceRow) === Number(event.target.dataset.row));
  if (row) row.selected = event.target.checked;
  updateSelectionUi();
});
$('#select-all').addEventListener('click', () => { previewRows.forEach((row) => { if (row.canApply) row.selected = true; }); renderRows(previewRows, 'verification'); updateSelectionUi(); });
$('#clear-selection').addEventListener('click', () => { previewRows.forEach((row) => { if (row.canApply) row.selected = false; }); renderRows(previewRows, 'verification'); updateSelectionUi(); });
$('#toggle-all').addEventListener('change', (event) => { previewRows.forEach((row) => { if (row.canApply) row.selected = event.target.checked; }); renderRows(previewRows, 'verification'); updateSelectionUi(); });

$('#apply-import').addEventListener('click', async () => {
  const selected = selectedRows();
  if (!selected.length) return;

  const carrierId = $('#import-carrier')?.value || $('#carrier')?.value;
  const stateId = $('#import-state')?.value || $('#state')?.value;
  const updateTracking = $('#update-tracking')?.checked ?? true;
  const updateState = $('#update-state')?.checked ?? true;

  if (!updateTracking && !updateState) {
    tell('#import-message', 'Seleziona almeno un tipo di aggiornamento (tracking o stato).', 'error');
    return;
  }
  if (updateTracking && !carrierId) {
    tell('#import-message', 'Seleziona un corriere PrestaShop prima di confermare l\’aggiornamento del tracking.', 'error');
    $('#import-carrier')?.focus();
    return;
  }
  if (updateState && !stateId) {
    tell('#import-message', 'Seleziona il nuovo stato ordine PrestaShop prima di confermare.', 'error');
    $('#import-state')?.focus();
    return;
  }

  if (!confirm(`Confermi l’aggiornamento di ${selected.length} ordini selezionati? Le righe non selezionate non saranno modificate.`)) return;

  try {
    $('#apply-import').disabled = true;
    updateApplyProgress({ completed: 0, total: selected.length });
    tell('#import-message', `Aggiornamento di ${selected.length} ordini in corso su PrestaShop…`);

    const { jobId } = await request('/api/import/apply-jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        verificationId,
        carrierId,
        stateId,
        updateTracking,
        updateState,
        selectedSourceRows: selected.map((row) => row.sourceRow),
      }),
    });

    const { summary, results } = await waitForApply(jobId);
    const outcomeByRow = new Map(results.map((row) => [Number(row.sourceRow), row]));
    const selectStateEl = $('#import-state') || $('#state');
    const selectedStateName = selectStateEl?.selectedOptions?.[0]?.textContent || '';
    importApplied = true;

    previewRows = previewRows.map((row) => {
      const outcome = outcomeByRow.get(Number(row.sourceRow));
      if (!outcome) return row;
      return {
        ...row,
        selected: false,
        applyResult: outcome.result,
        applyDetail: outcome.detail,
        currentState: outcome.result === 'Aggiornata' && updateState ? selectedStateName : row.currentState,
      };
    });

    renderRows(previewRows, 'verification');
    updateSelectionUi();
    showImportSuccessCard(summary, results);
    showApplyFeedback(summary);
    void refreshControlCenter();

    tell('#import-message', Object.entries(summary).map(([name, count]) => `${name}: ${count}`).join(' · '), Number(summary.Errore || 0) ? 'warning' : 'success');
  } catch (e) {
    tell('#import-message', e.message, 'error');
  } finally {
    $('#apply-import').disabled = false;
  }
});

$('#save-dsv-beta').addEventListener('click', async () => {
  const button = $('#save-dsv-beta');
  try {
    button.disabled = true;
    const speedProfile = document.querySelector('input[name="dsv-speed-profile"]:checked')?.value || 'safe';
    const data = await request('/api/dsv-beta/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: $('#dsv-beta-enabled').checked, camofoxUrl: $('#dsv-camofox-url').value, trackingUrl: $('#dsv-tracking-url').value, speedProfile }) });
    dsvBetaSettings = data; updateControlServiceStatus(); updateSelectionUi(); updateControlSelectionUi([...document.querySelectorAll('.control-row-select')].map((input) => ({ trackingNumber: input.dataset.tracking })));
    const modeLabel = dsvSpeedLabel(data.speedProfile, true);
    tell('#dsv-config-message', data.enabled ? `Servizio attivo in modalità ${modeLabel}. Una spedizione alla volta, pausa media ${data.intervalMs / 1000} secondi.` : 'Configurazione salvata; servizio disattivato.', 'success'); markSettingsClean('connections'); updateSettingsHealth(); showFloatingToast('Configurazione DSV salvata!', 'success');
  } catch (e) { tell('#dsv-config-message', e.message, 'error'); }
  finally { button.disabled = false; }
});

$('#test-dsv-beta').addEventListener('click', async () => {
  try { $('#test-dsv-beta').disabled = true; tell('#dsv-config-message', 'Controllo del servizio Camoufox locale in corso…'); const result = await request('/api/dsv-beta/test', { method: 'POST' }); tell('#dsv-config-message', result.message, 'success'); setSettingsTestResult('camofox', true, `${result.message} · ${$('#dsv-camofox-url').value}`); }
  catch (e) { tell('#dsv-config-message', e.message, 'error'); setSettingsTestResult('camofox', false, `${e.message} · ${$('#dsv-camofox-url').value}`); }
  finally { $('#test-dsv-beta').disabled = false; }
});

$('#verify-dsv-beta').addEventListener('click', async () => {
  const selected = selectedRows().filter((row) => row.trackingNumber);
  if (!dsvBetaSettings?.enabled) { tell('#dsv-beta-message', 'Attiva e salva prima la beta.', 'error'); return; }
  if (!selected.length) { tell('#dsv-beta-message', 'Seleziona almeno una riga con tracking.', 'error'); return; }
  if (selected.length > dsvBetaSettings.maxRows) { tell('#dsv-beta-message', `Per sicurezza la beta può verificare al massimo ${dsvBetaSettings.maxRows} righe alla volta.`, 'error'); return; }
  if (!confirm(`Avvia la verifica pubblica DSV per ${selected.length} spedizioni? Non verrà modificato alcun ordine.`)) return;
  try {
    $('#verify-dsv-beta').disabled = true; updateDsvProgress({ completed: 0, total: selected.length });
    tell('#dsv-beta-message', `Verifica sequenziale in corso · modalità ${dsvSpeedLabel(dsvBetaSettings.speedProfile).toLocaleLowerCase('it-IT')}.`);
    const { jobId } = await request('/api/dsv-beta/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trackingNumbers: selected.map((row) => row.trackingNumber) }) });
    const { results, safeguards } = await waitForDsvBeta(jobId);
    const byTracking = new Map(results.map((result) => [result.trackingNumber, result]));
    previewRows = previewRows.map((row) => { const result = byTracking.get(row.trackingNumber); return result ? { ...row, dsvBetaStatus: result.status, dsvBetaDetail: result.detail } : row; });
    renderRows(previewRows, 'verification'); updateSelectionUi(); void refreshControlCenter();
    const cached = results.filter((row) => row.cached).length;
    const fallback = safeguards.fallbackReason ? ` ${safeguards.fallbackReason}` : '';
    tell('#dsv-beta-message', `${results.length} spedizioni controllate${cached ? `, ${cached} da cache` : ''}. Modalità effettiva: ${dsvSpeedLabel(safeguards.effectiveSpeedProfile).toLocaleLowerCase('it-IT')}.${fallback}`, safeguards.fallbackReason ? 'warning' : 'success');
  } catch (e) { tell('#dsv-beta-message', e.message, 'error'); }
  finally { $('#verify-dsv-beta').disabled = false; }
});

$('#refresh-control-center').addEventListener('click', refreshControlCenter);
$('#control-exceptions').addEventListener('change', () => { controlMetricFilter = $('#control-exceptions').checked ? 'attention' : 'all'; controlPage = 1; refreshControlCenter(); });
$('.control-center-card').addEventListener('click', (event) => {
  const metric = event.target.closest('.control-metric[data-metric-filter]');
  if (metric) {
    controlMetricFilter = metric.dataset.metricFilter || 'all';
    $('#control-dsv-filter').value = '';
    $('#control-exceptions').checked = controlMetricFilter === 'attention';
    controlPage = 1;
    refreshControlCenter();
    return;
  }
  const quickFilter = event.target.closest('[data-dsv-status], [data-control-filter]');
  if (!quickFilter) return;
  const controlFilter = quickFilter.dataset.controlFilter || '';
  if (controlFilter === 'attention') {
    $('#control-dsv-filter').value = '';
    $('#control-exceptions').checked = true;
    controlMetricFilter = 'attention';
  } else {
    $('#control-dsv-filter').value = quickFilter.dataset.dsvStatus || '';
    $('#control-exceptions').checked = false;
    controlMetricFilter = 'all';
  }
  controlPage = 1;
  refreshControlCenter();
});
$('.control-center-card').addEventListener('change', (event) => {
  if (!event.target.matches('#control-other-status') || !event.target.value) return;
  $('#control-dsv-filter').value = event.target.value;
  $('#control-exceptions').checked = false;
  controlMetricFilter = 'all';
  controlPage = 1;
  refreshControlCenter();
});
$('#control-table tbody').addEventListener('change', (event) => {
  if (!event.target.matches('.control-row-select')) return;
  const trackingNumber = event.target.dataset.tracking;
  if (event.target.checked) controlSelectedTrackingNumbers.add(trackingNumber);
  else controlSelectedTrackingNumbers.delete(trackingNumber);
  event.target.closest('tr')?.classList.toggle('is-selected', event.target.checked);
  updateControlSelectionUi([...document.querySelectorAll('.control-row-select')].map((input) => ({ trackingNumber: input.dataset.tracking })));
});
$('#control-toggle-all').addEventListener('change', (event) => {
  document.querySelectorAll('.control-row-select').forEach((input) => {
    input.checked = event.target.checked;
    input.closest('tr')?.classList.toggle('is-selected', event.target.checked);
    if (event.target.checked) controlSelectedTrackingNumbers.add(input.dataset.tracking);
    else controlSelectedTrackingNumbers.delete(input.dataset.tracking);
  });
  lastControlSelectedTrackingNumber = '';
  updateControlSelectionUi([...document.querySelectorAll('.control-row-select')].map((input) => ({ trackingNumber: input.dataset.tracking })));
});
$('#verify-control-selected').addEventListener('click', async () => {
  const button = $('#verify-control-selected');
  const bulkButton = $('#control-bulk-verify');
  button.disabled = true;
  if (bulkButton) bulkButton.disabled = true;
  try { await startControlDsvVerification([...controlSelectedTrackingNumbers]); }
  catch (e) { tell('#control-dsv-message', e.message, 'error'); }
  finally { updateControlSelectionUi([...document.querySelectorAll('.control-row-select')].map((input) => ({ trackingNumber: input.dataset.tracking }))); }
});
$('.control-center-card').addEventListener('click', (event) => {
  const button = event.target.closest('.control-page');
  if (!button || button.disabled) return;
  controlPage = Number(button.dataset.page);
  if (activeBatchFilter) renderControlCenter(controlOverview);
  else refreshControlCenter();
});
$('#control-table tbody').addEventListener('click', (event) => {
  const selectionInput = event.target.closest('.control-row-select');
  if (selectionInput) {
    const inputs = [...document.querySelectorAll('#control-table tbody .control-row-select')];
    const currentIndex = inputs.indexOf(selectionInput);
    const anchorIndex = inputs.findIndex((input) => input.dataset.tracking === lastControlSelectedTrackingNumber);
    if (event.shiftKey && anchorIndex >= 0 && currentIndex >= 0) {
      const [start, end] = anchorIndex < currentIndex ? [anchorIndex, currentIndex] : [currentIndex, anchorIndex];
      inputs.slice(start, end + 1).forEach((input) => {
        input.checked = selectionInput.checked;
        input.closest('tr')?.classList.toggle('is-selected', selectionInput.checked);
        if (selectionInput.checked) controlSelectedTrackingNumbers.add(input.dataset.tracking);
        else controlSelectedTrackingNumbers.delete(input.dataset.tracking);
      });
      updateControlSelectionUi(inputs.map((input) => ({ trackingNumber: input.dataset.tracking })));
    }
    lastControlSelectedTrackingNumber = selectionInput.dataset.tracking;
    return;
  }
  if (event.target.closest('.control-select-cell')) return;
  const stateFilterButton = event.target.closest('.control-presta-state-shortcut');
  if (stateFilterButton) {
    controlPrestaStateFilter = stateFilterButton.dataset.prestaStateFilter || '';
    controlPage = 1;
    closeControlPrestaFilter();
    refreshControlCenter();
    return;
  }
  const linkButton = event.target.closest('.link-prestashop-order');
  if (linkButton) {
    const shipment = controlRecords.find((row) => row.trackingNumber === linkButton.dataset.tracking);
    if (shipment) return openPrestaShopLinkDialog(shipment);
  }
  const updateButton = event.target.closest('.update-prestashop-state');
  if (updateButton && !updateButton.disabled) return openPrestaShopStateDialog(updateButton.dataset.tracking);
  const button = event.target.closest('.open-shipment');
  if (button) return openShipmentDetail(button.dataset.tracking);
  if (event.target.closest('input, button')) return;
  const row = event.target.closest('tr[data-tracking]');
  if (row) openShipmentDetail(row.dataset.tracking);
});

document.addEventListener('click', (event) => {
  const trigger = event.target.closest('#control-presta-filter-trigger');
  const menu = $('#control-presta-filter-menu');
  if (trigger && menu) {
    const willOpen = menu.hidden;
    menu.hidden = !willOpen;
    trigger.setAttribute('aria-expanded', String(willOpen));
    if (willOpen) requestAnimationFrame(positionControlPrestaFilter);
    return;
  }
  const option = event.target.closest('#control-presta-filter-menu [data-presta-state-filter]');
  if (option) {
    controlPrestaStateFilter = option.dataset.prestaStateFilter || '';
    controlPage = 1;
    closeControlPrestaFilter();
    refreshControlCenter();
    return;
  }
  if (menu && !menu.hidden && !event.target.closest('#control-presta-filter-menu')) closeControlPrestaFilter();
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || $('#control-presta-filter-menu')?.hidden) return;
  closeControlPrestaFilter();
  $('#control-presta-filter-trigger')?.focus();
});

window.addEventListener('resize', closeControlPrestaFilter);
window.addEventListener('scroll', closeControlPrestaFilter, true);

$('.control-center-card').addEventListener('click', (event) => {
  if (!event.target.closest('#configure-control-mappings')) return;
  location.hash = 'settings/mappings';
  setTimeout(() => activateSettingsSection('mappings'), 120);
});

document.addEventListener('click', async (event) => {
  const button = event.target.closest('.copyable-btn');
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  const textToCopy = button.dataset.copy;
  if (!textToCopy) return;
  const label = button.dataset.copyLabel || 'Valore';
  const success = await copyToClipboard(textToCopy);
  if (success) {
    button.classList.add('copied');
    setTimeout(() => button.classList.remove('copied'), 1500);
    showCopyConfirmPopup(button, textToCopy, label);
  }
});

window.addEventListener('scroll', () => {
  const popup = document.getElementById('copy-confirm-popup');
  if (popup?.classList.contains('visible')) {
    popup.classList.remove('visible');
  }
}, { passive: true });

setupWorkspace();
Promise.all([initialConfig(), loadDsvBeta(), refreshControlCenter(), loadCronStatus()])
  .then(() => resumeControlDsvVerification())
  .catch(() => {});
showView(location.hash.slice(1) || 'control');

document.addEventListener('click', async (event) => {
  const trackingUrlCopyButton = event.target.closest('#copy-dsv-tracking-url');
  if (trackingUrlCopyButton) {
    event.preventDefault();
    event.stopPropagation();
    const trackingUrl = $('#dsv-tracking-url')?.value.trim();
    if (!trackingUrl) return;
    const success = await copyToClipboard(trackingUrl);
    if (success) {
      trackingUrlCopyButton.classList.add('copied');
      const orig = trackingUrlCopyButton.textContent;
      trackingUrlCopyButton.textContent = 'Copiato!';
      setTimeout(() => {
        trackingUrlCopyButton.classList.remove('copied');
        trackingUrlCopyButton.textContent = orig;
      }, 1500);
      showFloatingToast('URL tracking DSV copiato negli appunti!', 'success');
    }
  }
});
