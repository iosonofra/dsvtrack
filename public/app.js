const $ = (selector) => document.querySelector(selector);
const tell = (selector, message, kind = '') => { const el = $(selector); el.textContent = message; el.className = `message ${kind}`; };
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
let previewRows = [];
let verificationId = '';
let dsvBetaSettings = null;
let importApplied = false;
let activeView = 'control';
let controlSelectedTrackingNumbers = new Set();
let controlRecords = [];
let controlPage = 1;
const CONTROL_PAGE_SIZE = 50;
let controlOverview = { records: [], total: 0, counts: {} };
let activeControlTrackingNumber = '';
let controlDetailTrigger = null;
let controlDetailRequestToken = 0;
let prestaShopStateCatalog = null;
let prestaShopStateTracking = '';
let dsvStateMappings = {};
let lastVerificationReport = null;
let activeReportFilter = 'all';
let reportSearchQuery = '';

async function request(url, options) { const r = await fetch(url, options); const data = await r.json(); if (!r.ok) throw new Error(data.error); return data; }
async function initialConfig() { const config = await request('/api/config'); $('#base-url').value = config.baseUrl; }
function displayDate(value) { return value ? escapeHtml(value.replace(/^([0-9]{4})-([0-9]{2})-([0-9]{2})/, '$3/$2/$1')) : '—'; }
function displayDateTime(value) { return value ? escapeHtml(new Date(value).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' })) : '—'; }
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

function renderRows(rows, state = 'validation') {
  $('#preview tbody').innerHTML = rows.map((row) => {
    const originalValue = state === 'verification' ? row.verification : row.validation;
    const value = row.applyResult || originalValue;
    const detail = row.applyResult ? ` — ${escapeHtml(row.applyDetail || '')}` : row.existingTracking ? ` — già presente: ${escapeHtml(row.existingTracking)}` : '';
    const level = row.applyResult === 'Aggiornata' ? 'applied-ok' : row.applyResult === 'Errore' ? 'applied-error' : (row.canApply || originalValue === 'Pronta per la verifica') ? 'ok' : (originalValue.includes('già presente') || originalValue.includes('saltata') || originalValue.includes('Già importata')) ? 'notice' : 'warning';
    const checkbox = row.canApply && !importApplied ? `<input class="row-select" data-row="${row.sourceRow}" type="checkbox" ${row.selected ? 'checked' : ''} aria-label="Includi riga ${row.sourceRow}">` : '—';
    const dsvStatus = row.dsvBetaStatus ? `<span class="dsv-status">${escapeHtml(row.dsvBetaStatus)}</span>` : '—';
    return `<tr><td>${checkbox}</td><td>${row.sourceRow}</td><td>${copyableValue(row.orderReference, 'Riferimento ordine', 'order-val')}</td><td>${displayDate(row.orderDate)}</td><td>${stateBadge(row.currentState)}</td><td>${copyableValue(row.trackingNumber, 'Numero spedizione', 'tracking-val')}</td><td>${dsvStatus}</td><td class="${level}">${escapeHtml(value)}${detail}</td></tr>`;
  }).join('');
}

function updateSelectionUi() {
  const total = previewRows.filter((row) => row.canApply).length;
  const selected = selectedRows().length;
  $('#selected-count').hidden = !verificationId || importApplied;
  $('#selected-count').textContent = `${selected} di ${total} righe pronte selezionate per l’aggiornamento.`;
  $('#select-all').hidden = !verificationId || importApplied;
  $('#clear-selection').hidden = !verificationId || importApplied;
  $('#toggle-all').hidden = !verificationId || importApplied;
  $('#toggle-all').checked = total > 0 && selected === total;
  $('#toggle-all').indeterminate = selected > 0 && selected < total;
  $('#apply-import').hidden = selected === 0 || importApplied;
  if (dsvBetaSettings?.enabled && verificationId) $('#verify-dsv-beta').hidden = selected === 0;
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
  updateControlServiceStatus();
  updateControlSelectionUi([...document.querySelectorAll('.control-row-select')].map((input) => ({ trackingNumber: input.dataset.tracking })));
}

function updateControlServiceStatus() {
  const status = $('#control-service-status');
  if (!status) return;
  const enabled = Boolean(dsvBetaSettings?.enabled);
  status.dataset.state = enabled ? 'ready' : 'off';
  status.textContent = enabled ? 'DSV tracking attivo' : 'DSV tracking non attivo';
}

function controlBadge(status) {
  const kind = status === 'Da gestire' ? 'attention' : status === 'Verifica incompleta' ? 'incomplete' : status === 'Consegnata' ? 'delivered' : ['Centro di distribuzione', 'In transito', 'In consegna'].includes(status) ? 'transit' : status === 'Prenotata' ? 'booked' : 'neutral';
  return `<span class="control-status ${kind}"><span class="status-dot" aria-hidden="true"></span>${escapeHtml(status || 'Non classificato')}</span>`;
}

function dsvBadge(status) {
  const label = status || 'Non verificato';
  const normalized = label.toLocaleLowerCase('it-IT');
  const kind = normalized.includes('errore') || normalized.includes('verificare manualmente') ? 'incomplete' : normalized.includes('intervento') || normalized.includes('eccezione') ? 'attention' : normalized.includes('non trovato') ? 'warning' : normalized === 'non verificato' ? 'pending' : normalized.includes('consegnat') ? 'delivered' : /in transito|in consegna|centro di distribuzione/.test(normalized) ? 'transit' : normalized.includes('prenotat') ? 'booked' : 'unmapped';
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
  if (isPrestaShopStateAligned(row)) return '<span class="state-aligned">Allineato</span>';
  if (!row.orderId) return '<span class="state-unavailable">Non collegato</span>';
  const mapped = mappedPrestaShopState(row);
  const label = mapped ? 'Aggiorna' : 'Scegli stato';
  return `<button class="update-prestashop-state" data-tracking="${escapeHtml(row.trackingNumber)}" type="button" aria-label="${label} PrestaShop per ${escapeHtml(row.trackingNumber)}">${label}</button>`;
}

const DSV_STATUS_ORDER = ['Prenotata', 'In transito', 'Centro di distribuzione', 'In consegna', 'Consegnata', 'Non verificato', 'Da verificare manualmente', 'Spedizione non trovata', 'Intervento manuale richiesto', 'Eccezione DSV', 'Errore beta'];

function dsvFilterKind(status) {
  const normalized = status.toLocaleLowerCase('it-IT');
  if (normalized.includes('consegnat')) return 'delivered';
  if (/in transito|in consegna|centro di distribuzione/.test(normalized)) return 'transit';
  if (normalized.includes('prenotat')) return 'booked';
  if (/intervento|eccezione|non trovata/.test(normalized)) return 'attention';
  if (/errore|verificare manualmente/.test(normalized)) return 'incomplete';
  if (normalized === 'non verificato') return 'pending';
  return 'unmapped';
}

function renderDsvStatusFilters(counts = {}, archivedCount = 0) {
  const bar = $('#control-quick-filters');
  if (!bar) return;
  const activeStatus = $('#control-dsv-filter')?.value || '';
  const total = Object.values(counts).reduce((sum, count) => sum + Number(count || 0), 0);
  const statuses = Object.keys(counts).filter((status) => counts[status] > 0).sort((left, right) => {
    const leftIndex = DSV_STATUS_ORDER.indexOf(left);
    const rightIndex = DSV_STATUS_ORDER.indexOf(right);
    return (leftIndex < 0 ? 999 : leftIndex) - (rightIndex < 0 ? 999 : rightIndex) || left.localeCompare(right, 'it');
  });
  const select = $('#control-dsv-filter');
  statuses.forEach((status) => { if (![...select.options].some((option) => option.value === status)) select.add(new Option(status, status)); });
  if (![...select.options].some((option) => option.value === 'Archiviate')) select.add(new Option('Archiviate', 'Archiviate'));
  const archivedButton = `<button type="button" class="control-quick-filter archived ${activeStatus === 'Archiviate' ? 'active' : ''}" data-dsv-status="Archiviate" title="Visualizza solo spedizioni archiviate"><span>Archiviate</span><strong>${archivedCount}</strong></button>`;
  bar.innerHTML = `<span class="filter-bar-label">Stati DSV</span><button type="button" class="control-quick-filter ${activeStatus ? '' : 'active'}" data-dsv-status=""><span>Tutte</span><strong>${total}</strong></button>${statuses.map((status) => `<button type="button" class="control-quick-filter ${dsvFilterKind(status)} ${activeStatus === status ? 'active' : ''}" data-dsv-status="${escapeHtml(status)}"><span>${escapeHtml(status)}</span><strong>${counts[status]}</strong></button>`).join('')}${archivedButton}`;
}

function caseBadge(status) {
  if (!status) return '<span class="case-status none">Non aperta</span>';
  const kind = status === 'Risolta' ? 'resolved' : status === 'Ignorata' ? 'ignored' : status === 'In lavorazione' ? 'working' : 'open';
  return `<span class="case-status ${kind}">${escapeHtml(status)}</span>`;
}

function renderControlCenter(data) {
  controlOverview = data;
  dsvStateMappings = data.stateMappings || dsvStateMappings;
  controlRecords = data.records || [];
  let batchBanner = $('#control-batch-banner');
  if (activeBatchFilter && activeBatchFilter.trackings) {
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
  const totalPages = Math.max(1, Math.ceil(controlRecords.length / CONTROL_PAGE_SIZE));
  controlPage = Math.min(controlPage, totalPages);
  const pageRecords = controlRecords.slice((controlPage - 1) * CONTROL_PAGE_SIZE, controlPage * CONTROL_PAGE_SIZE);
  const counts = data.counts || {};
  const moving = (counts['Centro di distribuzione'] || 0) + (counts['In transito'] || 0) + (counts['In consegna'] || 0);
  $('#control-metrics').innerHTML = [
    ['Monitorate', data.total || 0, 'neutral'], ['In movimento', moving, 'transit'],
    ['Consegnate', counts.Consegnata || 0, 'delivered'], ['Richiedono attenzione', counts['Da gestire'] || 0, 'attention'],
  ].map(([label, value, kind]) => `<div class="control-metric ${kind}"><strong>${value}</strong><span>${label}</span></div>`).join('');
  renderDsvStatusFilters(data.dsvCounts || {}, data.archivedCount || 0);
  const backupBadge = $('#backup-shipments-badge');
  if (backupBadge && data.total !== undefined) {
    backupBadge.textContent = `${data.total} spedizioni pronte`;
  }
  const isArchivedActive = $('#control-dsv-filter')?.value === 'Archiviate';
  const emptyMessage = isArchivedActive ? 'Nessuna spedizione archiviata.' : data.total ? 'Nessuna spedizione corrisponde ai filtri.' : 'Nessuna spedizione ancora archiviata. Verifica un file per popolare il centro.';
  const visible = new Set(controlRecords.map((row) => row.trackingNumber));
  controlSelectedTrackingNumbers = new Set([...controlSelectedTrackingNumbers].filter((trackingNumber) => visible.has(trackingNumber)));
  $('#control-table tbody').innerHTML = pageRecords.length ? pageRecords.map((row) => {
    const archivedTag = row.archived ? '<span class="control-status archived"><span class="status-dot" aria-hidden="true"></span>Archiviata</span>' : '';
    return `<tr data-tracking="${escapeHtml(row.trackingNumber)}" class="${row.trackingNumber === activeControlTrackingNumber ? 'active' : ''}"><td><input class="control-row-select row-select" data-tracking="${escapeHtml(row.trackingNumber)}" type="checkbox" ${controlSelectedTrackingNumbers.has(row.trackingNumber) ? 'checked' : ''} aria-label="Seleziona spedizione ${escapeHtml(row.trackingNumber)}"></td><td>${copyableValue(row.trackingNumber, 'Numero spedizione', 'tracking-val')}</td><td>${copyableValue(row.orderReference, 'Riferimento ordine', 'order-val')}</td><td><div class="dsv-state-cell">${dsvBadge(row.dsvStatus)}${archivedTag}<small title="Data e ora dichiarate da DSV">${displayDsvEventDate(row)}</small></div></td><td><div class="prestashop-state-cell">${prestaShopBadge(row.currentState)}${prestaShopStateAction(row)}</div></td><td>${displayDateTime(row.dsvCheckedAt || row.lastSeenAt)}</td><td><button class="open-shipment secondary" data-tracking="${escapeHtml(row.trackingNumber)}">Dettaglio <span aria-hidden="true">›</span></button></td></tr>`;
  }).join('') : `<tr><td colspan="7" class="control-empty">${emptyMessage}</td></tr>`;
  updateControlSelectionUi(pageRecords);
  renderControlPager(controlRecords.length, totalPages);
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
  const maxRows = dsvBetaSettings?.maxRows || 10;
  const button = $('#verify-control-selected');
  button.disabled = !dsvBetaSettings?.enabled || selected === 0;
  button.textContent = selected ? `Verifica DSV (${selected})` : 'Verifica DSV';
  const bulkBar = $('#control-bulk-bar');
  if (bulkBar) {
    bulkBar.hidden = selected === 0;
    $('#control-bulk-count').textContent = `${selected} selezionat${selected === 1 ? 'a' : 'e'}`;
    $('#control-bulk-verify').disabled = button.disabled;
    $('#control-bulk-manage').disabled = selected === 0;
    const bulkSyncBtn = $('#control-bulk-sync-prestashop');
    if (bulkSyncBtn) bulkSyncBtn.disabled = selected === 0;
  }
  const batchCount = Math.ceil(selected / maxRows);
  const summary = !dsvBetaSettings?.enabled ? 'Verifica DSV non disponibile: attivala nella Configurazione.' : selected > maxRows ? `${selected} selezionate: saranno verificate automaticamente in ${batchCount} blocchi da massimo ${maxRows}.` : selected ? `${selected} selezionate: la verifica DSV non modifica gli ordini.` : 'Seleziona una o più spedizioni per verificare lo stato DSV.';
  const selectionSummary = $('#control-selection-summary');
  selectionSummary.textContent = summary;
  selectionSummary.hidden = Boolean(dsvBetaSettings?.enabled) && selected <= maxRows;
  const toggle = $('#control-toggle-all');
  const pageSelected = records.filter((record) => controlSelectedTrackingNumbers.has(record.trackingNumber)).length;
  toggle.checked = records.length > 0 && pageSelected === records.length;
  toggle.indeterminate = pageSelected > 0 && pageSelected < records.length;
}

function updateControlDsvProgress(progress) {
  const percentage = progress.total ? Math.round((progress.completed / progress.total) * 100) : 0;
  $('#control-dsv-progress').hidden = false;
  $('#control-dsv-progress-bar').style.width = `${percentage}%`;
  $('#control-dsv-progress-text').textContent = `${percentage}% · ${progress.completed}/${progress.total} spedizioni`;
}

async function waitForControlDsvBeta(jobId, batchContext = { completedBefore: 0, total: 0, batchIndex: 0, batchCount: 1 }) {
  const snapshot = await request(`/api/dsv-beta/jobs/${jobId}`);
  updateControlDsvProgress({ completed: batchContext.completedBefore + snapshot.progress.completed, total: batchContext.total || snapshot.progress.total });
  if (snapshot.status === 'queued' || snapshot.status === 'running') {
    const batchLabel = batchContext.batchCount > 1 ? `Blocco ${batchContext.batchIndex + 1} di ${batchContext.batchCount}. ` : '';
    tell('#control-dsv-message', snapshot.status === 'queued' ? `${batchLabel}In coda: Camoufox sta completando un’altra richiesta.` : `${batchLabel}Verifica DSV in corso, una spedizione alla volta…`);
    await new Promise((resolve) => setTimeout(resolve, 750));
    return waitForControlDsvBeta(jobId, batchContext);
  }
  if (snapshot.status === 'failed') throw new Error(snapshot.error || 'La verifica DSV non è riuscita.');
  return snapshot.result;
}

async function startControlDsvVerification(trackingNumbers) {
  if (!dsvBetaSettings?.enabled) throw new Error('Attiva prima la beta DSV/Schenker nella configurazione e salva.');
  const maxRows = dsvBetaSettings.maxRows;
  if (!trackingNumbers.length) throw new Error('Seleziona almeno una spedizione.');
  const uniqueTrackingNumbers = [...new Set(trackingNumbers)];

  const previousMap = new Map();
  for (const tn of uniqueTrackingNumbers) {
    const existing = controlRecords.find((r) => r.trackingNumber === tn);
    previousMap.set(tn, {
      dsvStatus: existing?.dsvStatus || 'Non verificato',
      orderReference: existing?.orderReference || '—',
      currentState: existing?.currentState || '—',
      dsvStatusAt: existing?.dsvStatusAt || existing?.dsvStatusDateRaw || '',
    });
  }

  const batches = [];
  for (let index = 0; index < uniqueTrackingNumbers.length; index += maxRows) batches.push(uniqueTrackingNumbers.slice(index, index + maxRows));
  $('#control-dsv-progress strong').textContent = 'Verifica DSV in corso';
  updateControlDsvProgress({ completed: 0, total: uniqueTrackingNumbers.length });
  tell('#control-dsv-message', batches.length > 1 ? `Preparazione di ${batches.length} blocchi sequenziali…` : 'Verifica DSV in preparazione…');
  const results = [];
  let safeguards = null;
  try {
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      const batch = batches[batchIndex];
      const completedBefore = results.length;
      const { jobId } = await request('/api/dsv-beta/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trackingNumbers: batch }) });
      const result = await waitForControlDsvBeta(jobId, { completedBefore, total: uniqueTrackingNumbers.length, batchIndex, batchCount: batches.length });
      results.push(...result.results);
      safeguards = result.safeguards;
      updateControlDsvProgress({ completed: results.length, total: uniqueTrackingNumbers.length });
    }
  } catch (error) {
    const progressElem = $('#control-dsv-progress');
    if (progressElem) progressElem.hidden = true;
    await refreshControlCenter();
    throw new Error(`Verifica interrotta dopo ${results.length} di ${uniqueTrackingNumbers.length} spedizioni: ${error.message}`);
  }
  const cached = results.filter((row) => row.cached).length;
  const failed = results.filter((row) => row.status === 'Errore beta').length;
  const completed = results.length - failed;
  const progressElem = $('#control-dsv-progress');
  if (progressElem) progressElem.hidden = true;
  const batchSummary = batches.length > 1 ? ` in ${batches.length} blocchi` : '';

  const reportRows = results.map((item) => {
    const prev = previousMap.get(item.trackingNumber) || { dsvStatus: 'Non verificato', orderReference: '—', currentState: '—', dsvStatusAt: '' };
    const prevStatus = prev.dsvStatus;
    const newStatus = item.status;
    const isChanged = prevStatus !== newStatus;
    return {
      trackingNumber: item.trackingNumber,
      orderReference: prev.orderReference,
      currentState: prev.currentState,
      prevStatus,
      newStatus,
      isChanged,
      detail: item.detail || '',
      cached: Boolean(item.cached),
      statusAt: item.statusAt || item.statusDateRaw || prev.dsvStatusAt || '',
      timeline: item.timeline || [],
    };
  });

  lastVerificationReport = {
    timestamp: new Date(),
    total: uniqueTrackingNumbers.length,
    batches: batches.length,
    completed,
    failed,
    cached,
    rows: reportRows,
    safeguards,
  };

  const messageText = failed
    ? `${completed} spedizioni verificate${batchSummary}, ${failed} con errore.`
    : `${completed} spedizioni verificate${batchSummary}${cached ? `, ${cached} da cache` : ''}.`;

  renderControlDsvSuccessNotification(messageText, failed ? 'warning' : 'success');
  controlSelectedTrackingNumbers.clear();
  await refreshControlCenter();
  return { results, safeguards };
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
  const query = ($('#global-tracking-query')?.value || '').trim();
  if (query) params.set('query', query);
  if ($('#control-dsv-filter')?.value) params.set('dsvStatus', $('#control-dsv-filter').value);
  if ($('#control-date-filter')?.value) params.set('checkedAfter', $('#control-date-filter').value);
  if ($('#control-exceptions').checked) params.set('exceptions', '1');
  try {
    renderControlCenter(await request(`/api/control-center?${params}`));
    $('#control-last-sync').textContent = `Elenco aggiornato alle ${new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}`;
  }
  catch (e) { $('#control-table tbody').innerHTML = `<tr><td colspan="7" class="control-empty">${escapeHtml(e.message)}</td></tr>`; }
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
      indicator.textContent = 'In esecuzione';
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

      summaryList.innerHTML = `
        <li>Spedizioni verificate: <strong>${s.checked || 0}</strong> di ${s.totalCandidates || 0}${cancelledText}</li>
        <li>Esito: ${deliveredText}${errorsText}</li>
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
  stateMapping.innerHTML = '<div class="control-heading"><div><p class="eyebrow">ALLINEAMENTO</p><h2>Mappatura stati DSV → PrestaShop</h2><p>Definisci lo stato ordine atteso per ogni esito DSV. I nuovi stati rilevati da Camoufox compariranno automaticamente qui.</p></div></div><form id="state-mapping-form"><div class="state-mapping-header"><span>Stato DSV rilevato</span><span>Stato PrestaShop corrispondente</span><span>Auto-allinea via Cron</span></div><div id="state-mapping-rows" class="state-mapping-rows"><p class="control-empty">Apri la configurazione per caricare gli stati.</p></div><div class="state-mapping-actions"><p id="state-mapping-message" class="message" aria-live="polite"></p><button id="save-state-mappings" type="submit">Salva mappatura</button></div></form>';
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
    if (saveButton) actionGroup.append(saveButton);
    form?.append(actionGroup);
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
  }

  if (dsvBetaCard && importCard) {
    const betaTitle = dsvBetaCard.querySelector('h3');
    if (betaTitle) betaTitle.textContent = 'Connessione DSV via Camoufox';
    const betaDescription = dsvBetaCard.querySelector('.beta-heading p');
    if (betaDescription) betaDescription.textContent = 'Configura il browser locale usato per leggere lo stato pubblico delle spedizioni DSV.';
    const betaPill = dsvBetaCard.querySelector('.beta-pill');
    if (betaPill) betaPill.textContent = 'SERVIZIO LOCALE';
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
  }

  settingsDashboard.append(...settingsCards);
  main.append(settingsDashboard);
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
  $('#global-tracking-query')?.addEventListener('input', () => { controlPage = 1; clearTimeout(window.controlSearchTimer); window.controlSearchTimer = setTimeout(refreshControlCenter, 300); });
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
  const dsvHeader = [...card.querySelectorAll('#control-table thead th')].find((cell) => cell.textContent.trim() === 'Stato DSV');
  if (![...card.querySelectorAll('#control-table thead th')].some((cell) => cell.textContent.trim() === 'Stato PrestaShop')) dsvHeader?.insertAdjacentHTML('afterend', '<th>Stato PrestaShop</th>');
  card.querySelector('.control-heading > div').insertAdjacentHTML('beforeend', '<div class="control-meta"><span id="control-service-status" class="control-service-status" data-state="off">DSV tracking non attivo</span><span id="control-last-sync" class="control-last-sync" aria-live="polite"></span></div>');
  card.querySelector('.control-filters').insertAdjacentHTML('beforebegin', '<nav id="control-quick-filters" class="control-quick-filters" aria-label="Filtra per stato DSV"><span class="filter-bar-label">Stati DSV</span><button type="button" class="control-quick-filter active" data-dsv-status=""><span>Tutte</span><strong>0</strong></button></nav>');
  card.querySelector('.control-filters').insertAdjacentHTML('beforeend', '<label class="control-dsv-filter-label" hidden>Stato DSV<select id="control-dsv-filter"><option value="">Tutti gli esiti DSV</option><option>Prenotata</option><option>In transito</option><option>Centro di distribuzione</option><option>In consegna</option><option>Consegnata</option><option>Non verificato</option><option>Da verificare manualmente</option><option>Errore beta</option><option>Spedizione non trovata</option><option>Intervento manuale richiesto</option><option>Eccezione DSV</option><option value="Archiviate">Archiviate</option></select></label><div class="control-filters-right"><label class="control-date-label">Controllato dal<input id="control-date-filter" type="date"></label><button id="control-clear-filters" type="button" class="secondary control-clear-filters">Pulisci filtri</button></div>');
  card.querySelector('.control-filters').insertAdjacentHTML('afterend', '<div id="control-bulk-bar" class="control-bulk-bar" hidden><strong id="control-bulk-count">0 selezionate</strong><span>Azioni sulla selezione</span><button id="control-bulk-verify" type="button">Verifica DSV</button><button id="control-bulk-sync-prestashop" type="button" class="secondary">Allinea stato PrestaShop</button><button id="control-bulk-export" type="button" class="secondary">Esporta CSV</button><button id="control-bulk-manage" type="button" class="secondary">Segna in lavorazione</button><button id="control-bulk-clear" type="button" class="secondary">Deseleziona</button></div>');
  $('#control-dsv-filter').addEventListener('change', () => { controlPage = 1; refreshControlCenter(); });
  $('#control-date-filter').addEventListener('change', () => { controlPage = 1; refreshControlCenter(); });
  $('#control-clear-filters').addEventListener('click', () => { if ($('#global-tracking-query')) $('#global-tracking-query').value = ''; if ($('#control-dsv-filter')) $('#control-dsv-filter').value = ''; if ($('#control-date-filter')) $('#control-date-filter').value = ''; if ($('#control-exceptions')) $('#control-exceptions').checked = false; controlPage = 1; refreshControlCenter(); });
  $('#control-bulk-clear').addEventListener('click', () => { controlSelectedTrackingNumbers.clear(); refreshControlCenter(); });
  $('#control-bulk-verify').addEventListener('click', () => $('#verify-control-selected').click());
  $('#control-bulk-sync-prestashop').addEventListener('click', openBulkPrestaShopDialog);
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
  document.body.insertAdjacentHTML('beforeend', '<dialog id="prestashop-state-dialog" class="prestashop-state-dialog" aria-labelledby="prestashop-state-title"><div id="prestashop-state-form-wrap"><form id="prestashop-state-form"><div class="prestashop-dialog-heading"><div><span>Aggiornamento ordine</span><h3 id="prestashop-state-title">Allinea stato PrestaShop</h3></div><button id="close-prestashop-state" type="button" class="detail-close" aria-label="Chiudi"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg></button></div><div id="prestashop-state-comparison" class="prestashop-state-comparison"></div><label>Nuovo stato PrestaShop<select id="prestashop-target-state" required><option value="">Caricamento stati…</option></select></label><p class="prestashop-dialog-note">Verrà creato un nuovo evento nello storico dell’ordine. L’email al cliente resterà disattivata.</p><p id="prestashop-state-message" class="message" aria-live="polite"></p><div class="prestashop-dialog-actions"><button id="cancel-prestashop-state" type="button" class="secondary">Annulla</button><button id="confirm-prestashop-state" type="submit">Aggiorna PrestaShop</button></div></form></div><div id="prestashop-state-success-wrap" class="prestashop-state-success-card" hidden><div class="prestashop-success-icon-ring"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg></div><div class="prestashop-success-content"><span class="prestashop-success-eyebrow">Operazione completata</span><h3 class="prestashop-success-title">Stato PrestaShop aggiornato!</h3><div id="prestashop-success-badge-slot" class="prestashop-success-badge-slot"></div><p id="prestashop-success-desc" class="prestashop-success-desc"></p></div><div class="prestashop-timer-bar-track"><div id="prestashop-timer-bar-fill" class="prestashop-timer-bar-fill"></div></div><div class="prestashop-dialog-actions prestashop-success-actions"><button id="prestashop-success-close-btn" type="button" class="secondary prestashop-quick-close">Chiudi subito</button></div></div></dialog><dialog id="prestashop-bulk-dialog" class="prestashop-state-dialog prestashop-bulk-dialog" aria-labelledby="prestashop-bulk-title"><div id="prestashop-bulk-form-wrap" class="prestashop-bulk-form-wrap"><div class="prestashop-dialog-heading"><div><span>Aggiornamento massivo ordini</span><h3 id="prestashop-bulk-title">Allinea stati PrestaShop</h3></div><button id="close-prestashop-bulk" type="button" class="detail-close" aria-label="Chiudi"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg></button></div><label class="prestashop-bulk-select-label">Modalità di allineamento stato PrestaShop<select id="prestashop-bulk-state-select" class="prestashop-bulk-state-select"><option value="auto">⚡ Mappatura automatica DSV (consigliata)</option><optgroup id="prestashop-bulk-forced-group" label="Oppure forza uno stato PrestaShop per tutte"></optgroup></select></label><div id="prestashop-bulk-forced-notice" class="prestashop-bulk-forced-notice" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x2="12.01" y1="17" y2="17"/></svg><span><strong>Modalità forzata:</strong> le regole basate sullo stato DSV vengono ignorate. Tutte le spedizioni con ordine verranno impostate sullo stato selezionato.</span></div><div id="prestashop-bulk-preview-content"></div><p class="prestashop-dialog-note">Come per l’aggiornamento singolo, verrà creato un nuovo evento nello storico di ciascun ordine. L’email al cliente resterà disattivata.</p><p id="prestashop-bulk-message" class="message" aria-live="polite"></p><div class="prestashop-dialog-actions"><button id="cancel-prestashop-bulk" type="button" class="secondary">Annulla</button><button id="confirm-prestashop-bulk" type="button">Conferma allineamento</button></div></div><div id="prestashop-bulk-progress-wrap" class="prestashop-bulk-progress-wrap" hidden><svg class="prestashop-bulk-progress-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"></circle><path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round"></path></svg><h3 class="prestashop-bulk-progress-title">Allineamento PrestaShop in corso…</h3><div class="prestashop-bulk-progress-bar-wrap"><div class="prestashop-bulk-progress-labels"><span id="prestashop-bulk-progress-text">0 di 0</span><span id="prestashop-bulk-progress-percent">0%</span></div><div class="prestashop-bulk-progress-track"><div id="prestashop-bulk-progress-bar" class="prestashop-bulk-progress-bar"></div></div></div><p id="prestashop-bulk-progress-info" class="prestashop-bulk-progress-info">Preparazione aggiornamenti…</p></div><div id="prestashop-bulk-success-wrap" class="prestashop-state-success-card" hidden><div class="prestashop-success-icon-ring"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg></div><div class="prestashop-success-content"><span class="prestashop-success-eyebrow">Operazione completata</span><h3 class="prestashop-success-title" id="prestashop-bulk-success-title">Allineamento completato!</h3><p id="prestashop-bulk-success-desc" class="prestashop-success-desc"></p><div id="prestashop-bulk-errors-box" class="prestashop-bulk-errors" hidden></div></div><div class="prestashop-timer-bar-track"><div id="prestashop-bulk-timer-bar-fill" class="prestashop-timer-bar-fill"></div></div><div class="prestashop-dialog-actions prestashop-success-actions"><button id="prestashop-bulk-success-close-btn" type="button" class="secondary prestashop-quick-close">Chiudi subito</button></div></div></dialog>');
  
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

    const timerFill = $('#prestashop-timer-bar-fill');
    timerFill.classList.remove('active');
    void timerFill.offsetWidth;
    timerFill.classList.add('active');

    let finished = false;
    const finishAndUpdate = async () => {
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
      if (activeControlTrackingNumber === tracking) {
        await openShipmentDetail(tracking);
      }
    };

    $('#prestashop-success-close-btn').onclick = finishAndUpdate;
    prestashopSuccessTimeout = setTimeout(finishAndUpdate, 1500);

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

function closeControlDetail() {
  const panel = $('#shipment-detail');
  controlDetailRequestToken += 1;
  if (panel.open) panel.close();
  activeControlTrackingNumber = '';
  panel.innerHTML = '';
  panel.dataset.empty = 'true';
  panel.removeAttribute('aria-labelledby');
  document.querySelectorAll('#control-table tbody tr').forEach((row) => row.classList.remove('active'));
  controlDetailTrigger?.focus?.();
  controlDetailTrigger = null;
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
  const view = ['control', 'import', 'history', 'settings'].includes(requestedView) ? requestedView : 'control';
  if (view !== 'control') {
    controlDetailRequestToken += 1;
    if ($('#shipment-detail')?.open) closeControlDetail();
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
  if (view === 'settings') {
    if ($('#dsv-beta')) $('#dsv-beta').hidden = false;
    void loadStateMappings();
    void loadCronStatus();
    void loadNotificationSettings();
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
            <small>${Number(overview.dsvCounts?.[status] || 0)} spedizioni rilevate</small>
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

    tell('#state-mapping-message', `${Object.keys(dsvStateMappings).length} associazioni configurate.`);
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
      alert(res.message || 'Messaggio inviato!');
    } catch (err) {
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
    } catch (err) {
      alert(`Errore invio digest: ${err.message}`);
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
let activeBatchFilter = null;
let currentImportFileName = 'File Excel';
let currentImportOrigin = 'excel';
let auditSearchDebounceTimer = null;

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
    if (!batches.length) {
      container.innerHTML = '<div class="control-empty">Nessun lotto di importazione registrato.</div>';
      return;
    }
    container.innerHTML = batches.map((batch) => {
      const originClass = batch.origin === 'manual' ? 'manual' : 'excel';
      const originLabel = batch.origin === 'manual' ? '✍️ Manuale' : '📥 File Excel';
      const trackings = Array.isArray(batch.trackingNumbers) ? batch.trackingNumbers : [];
      return `
        <article class="batch-card" data-batch-id="${escapeHtml(batch.id)}">
          <header class="batch-card-header">
            <div class="batch-title-group">
              <div class="batch-title-row">
                <span class="batch-origin-badge ${originClass}">${originLabel}</span>
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
              Vedi nel Centro di Controllo
            </button>
            <a class="secondary button-link" href="/api/history/batches/${encodeURIComponent(batch.id)}/export" download="lotto-${escapeHtml(batch.id)}.csv">
              <svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor"><path fill-rule="evenodd" d="M3 17a1 1 0 0 1 1-1h12a1 1 0 1 1 0 2H4a1 1 0 0 1-1-1zm3.293-7.707a1 1 0 0 1 1.414 0L9 10.586V3a1 1 0 1 1 2 0v7.586l1.293-1.293a1 1 0 1 1 1.414 1.414l-3 3a1 1 0 0 1-1.414 0l-3-3a1 1 0 0 1 0-1.414z" clip-rule="evenodd"/></svg>
              Esporta CSV
            </a>
            <button type="button" class="secondary batch-toggle-chips-btn" data-batch-id="${escapeHtml(batch.id)}" data-count="${trackings.length}">
              Colli (${trackings.length}) ▾
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

async function openShipmentDetail(trackingNumber) {
  try {
    const panel = $('#shipment-detail');
    const requestToken = ++controlDetailRequestToken;
    if (!panel.open) controlDetailTrigger = document.activeElement;
    const shipment = await request(`/api/control-center/${encodeURIComponent(trackingNumber)}`);
    if (requestToken !== controlDetailRequestToken) return;
    activeControlTrackingNumber = trackingNumber;
    document.querySelectorAll('#control-table tbody tr').forEach((row) => row.classList.toggle('active', row.dataset.tracking === trackingNumber));
    delete panel.dataset.empty;
    const fallbackTrackingUrl = `https://www.dsv.com/mydsv/tracking-public/?refNumber=${encodeURIComponent(shipment.trackingNumber)}&language_region=it-IT_IT`;
    const trackingUrl = shipment.dsvTrackingUrl || fallbackTrackingUrl;
    const dsvTimeline = Array.isArray(shipment.dsvTimeline) ? shipment.dsvTimeline : [];
    panel.innerHTML = `<div class="detail-heading"><div><span class="detail-kicker">Dettaglio spedizione</span><h2 id="shipment-detail-title" class="detail-title-row">${copyableValue(shipment.trackingNumber, 'Numero spedizione', 'detail-tracking-btn')}</h2><span class="detail-order">Ordine ${copyableValue(shipment.orderReference, 'Riferimento ordine', 'detail-order-btn')}</span></div><button id="close-shipment-detail" type="button" class="detail-close" aria-label="Chiudi dettaglio"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg></button></div><div class="detail-status-row">${controlBadge(shipment.operationalStatus)}${shipment.archived ? '<span class="control-status archived"><span class="status-dot" aria-hidden="true"></span>Archiviata</span>' : ''}<div class="detail-dsv-state">${dsvBadge(shipment.dsvStatus)}<small>Evento DSV: ${displayDsvEventDate(shipment)}</small></div></div><dl class="shipment-facts"><div><dt>PrestaShop</dt><dd>${escapeHtml(shipment.currentState || '—')}</dd></div><div><dt>Ultimo controllo</dt><dd>${displayDateTime(shipment.dsvCheckedAt || shipment.lastSeenAt)}</dd></div><div><dt>Gestione</dt><dd>${caseBadge(shipment.caseStatus)}</dd></div><div><dt>Assegnata a</dt><dd>${escapeHtml(shipment.assignee || 'Non assegnata')}</dd></div></dl><div id="detail-prestashop-sync" class="detail-prestashop-sync-card"><div class="sync-loading-skeleton"><span class="sync-live-dot loading" aria-hidden="true"></span><span>Verifica stato PrestaShop in corso…</span></div></div><div class="detail-actions"><button id="verify-single-dsv" type="button" ${dsvBetaSettings?.enabled ? '' : 'disabled'}>${shipment.archived ? 'Forza verifica DSV' : 'Verifica nuovamente'}</button><button id="toggle-archive-shipment" type="button" class="secondary archive-action-btn" title="${shipment.archived ? 'Ripristina tra le spedizioni attive' : 'Archivia la spedizione per escluderla dai controlli automatici'}">${shipment.archived ? '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 5.5h12v8.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5.5z"/><path d="M1 2.5h14v3H1z"/><path d="m6 9.5 2-2 2 2"/><path d="M8 7.5v5"/></svg><span>Ripristina spedizione</span>' : '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 5.5h12v8.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5.5z"/><path d="M1 2.5h14v3H1z"/><path d="M6 9.5h4"/></svg><span>Archivia spedizione</span>'}</button><a class="dsv-external-link" href="${escapeHtml(trackingUrl)}" target="_blank" rel="noopener noreferrer">Apri tracking DSV <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 5h9v9M19 5l-9 9M14 19H5V10"/></svg></a></div>${dsvTimeline.length ? `<section class="dsv-history"><div class="detail-section-heading"><h4>Storico DSV</h4><span>${dsvTimeline.length} eventi</span></div><ol class="dsv-timeline">${dsvTimeline.slice().reverse().map((event) => `<li><span class="event-marker" aria-hidden="true"></span><div><div class="dsv-event-heading"><strong>${escapeHtml(event.event || 'Evento DSV')}</strong><time>${escapeHtml(event.date || '—')}</time></div><span>${escapeHtml([event.country, event.location].filter(Boolean).join(' · ') || 'Località non disponibile')}</span>${event.reason ? `<small>${escapeHtml(event.reason)}</small>` : ''}</div></li>`).join('')}</ol></section>` : `<section class="dsv-history dsv-history-empty"><div><strong>Storico DSV non ancora acquisito</strong><span>Ripeti la verifica per importare gli eventi disponibili.</span></div><a href="${escapeHtml(trackingUrl)}" target="_blank" rel="noopener noreferrer">Consulta su DSV</a></section>`}<form id="shipment-case-form" class="shipment-case"><div class="detail-section-heading"><h4>Gestione eccezione</h4><span>Uso interno</span></div><div class="case-fields"><label>Stato<select id="case-status"><option${!shipment.caseStatus ? ' selected' : ''}>Aperta</option><option${shipment.caseStatus === 'In lavorazione' ? ' selected' : ''}>In lavorazione</option><option${shipment.caseStatus === 'Risolta' ? ' selected' : ''}>Risolta</option><option${shipment.caseStatus === 'Ignorata' ? ' selected' : ''}>Ignorata</option></select></label><label>Assegnata a<input id="case-assignee" maxlength="120" value="${escapeHtml(shipment.assignee || '')}" placeholder="Nome operatore"></label></div><label>Nota interna<textarea id="case-note" maxlength="2000" rows="3" placeholder="Aggiungi contesto per il prossimo operatore…">${escapeHtml(shipment.note || '')}</textarea></label><button>Salva gestione</button></form><section class="detail-history"><div class="detail-section-heading"><h4>Cronologia locale</h4><span>${(shipment.events || []).length} eventi</span></div><ol class="shipment-events">${(shipment.events || []).slice().reverse().map((event) => `<li><span class="event-marker" aria-hidden="true"></span><div><time>${displayDateTime(event.at)}</time><strong>${escapeHtml(event.label)}</strong><span>${escapeHtml(event.detail || event.type)}</span></div></li>`).join('') || '<li class="detail-empty">Nessun evento disponibile.</li>'}</ol></section>`;
    const heading = panel.querySelector('.detail-heading');
    heading.setAttribute('tabindex', '-1');
    const dialogBody = document.createElement('div');
    const primary = document.createElement('div');
    const operations = document.createElement('div');
    dialogBody.className = 'detail-dialog-body';
    primary.className = 'detail-dialog-primary';
    operations.className = 'detail-dialog-operations';
    primary.append(panel.querySelector('.detail-status-row'), panel.querySelector('.shipment-facts'), panel.querySelector('#detail-prestashop-sync'), panel.querySelector('.detail-actions'), panel.querySelector('.dsv-history'));
    operations.append(panel.querySelector('.shipment-case'), panel.querySelector('.detail-history'));
    dialogBody.append(primary, operations);
    panel.replaceChildren(heading, dialogBody);
    panel.setAttribute('aria-labelledby', 'shipment-detail-title');
    if (!panel.open) panel.showModal();
    $('#close-shipment-detail').addEventListener('click', closeControlDetail);
    setTimeout(() => heading.focus(), 0);
    loadPrestaShopLiveSync(shipment, requestToken);
    $('#verify-single-dsv').addEventListener('click', async () => {
      const button = $('#verify-single-dsv'); button.disabled = true;
      try { await startControlDsvVerification([shipment.trackingNumber]); await openShipmentDetail(shipment.trackingNumber); }
      catch (e) { tell('#control-dsv-message', e.message, 'error'); }
      finally { button.disabled = false; }
    });
    $('#toggle-archive-shipment')?.addEventListener('click', async () => {
      const button = $('#toggle-archive-shipment');
      button.disabled = true;
      const nextArchived = !shipment.archived;
      try {
        const res = await request(`/api/control-center/${encodeURIComponent(shipment.trackingNumber)}/archive`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ archived: nextArchived }),
        });
        tell('#control-dsv-message', res.message, 'success');
        await refreshControlCenter();
        await openShipmentDetail(shipment.trackingNumber);
      } catch (e) {
        tell('#control-dsv-message', e.message, 'error');
      } finally {
        button.disabled = false;
      }
    });
    $('#shipment-case-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = $('#shipment-case-form button'); button.disabled = true;
      try {
        await request(`/api/control-center/${encodeURIComponent(shipment.trackingNumber)}/case`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ caseStatus: $('#case-status').value, assignee: $('#case-assignee').value, note: $('#case-note').value }) });
        await refreshControlCenter(); await openShipmentDetail(shipment.trackingNumber);
      } catch (e) { tell('#control-dsv-message', e.message, 'error'); }
      finally { button.disabled = false; }
    });
  } catch (e) { tell('#control-dsv-message', e.message, 'error'); }
}

async function loadPrestaShopLiveSync(shipment, requestToken) {
  const container = $('#detail-prestashop-sync');
  if (!container) return;
  try {
    const res = await request(`/api/control-center/${encodeURIComponent(shipment.trackingNumber)}/prestashop-live`);
    if (requestToken !== controlDetailRequestToken) return;

    if (!res.ok) {
      if (res.notConfigured) {
        container.innerHTML = `<div class="sync-card-header"><span class="sync-card-title"><span class="sync-live-dot error" aria-hidden="true"></span>Sincronizzazione PrestaShop</span></div><p class="sync-status-msg" style="color:var(--muted);margin:4px 0;">PrestaShop non configurato. Configura URL e chiave Webservice per attivare il controllo live.</p>`;
      } else {
        container.innerHTML = `<div class="sync-card-header"><span class="sync-card-title"><span class="sync-live-dot error" aria-hidden="true"></span>Sincronizzazione PrestaShop</span><button id="retry-prestashop-live-btn" type="button" class="sync-refresh-btn" title="Riprova verifica live"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2v4h-4M2 14v-4h4"/><path d="M2.5 9a6 6 0 0 1 9.5-4.5L14 6M13.5 7a6 6 0 0 1-9.5 4.5L2 10"/></svg></button></div><p class="sync-status-msg" style="color:var(--danger);margin:4px 0;">${escapeHtml(res.error || 'Impossibile verificare lo stato live su PrestaShop.')}</p>`;
        $('#retry-prestashop-live-btn')?.addEventListener('click', () => {
          container.innerHTML = `<div class="sync-loading-skeleton"><span class="sync-live-dot loading" aria-hidden="true"></span><span>Verifica stato PrestaShop in corso…</span></div>`;
          loadPrestaShopLiveSync(shipment, requestToken);
        });
      }
      return;
    }

    const { liveTracking, dsvTracking, trackingStatus, liveCarrierName, defaultCarrierId, defaultCarrierName, carrierMatches } = res;

    let badgeHtml = '';
    if (trackingStatus === 'matches') {
      badgeHtml = `<span class="sync-badge matches"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 8.5 6.5 12 13 4"/></svg> Sincronizzato (${copyableValue(liveTracking, 'Tracking PrestaShop', 'live-tracking-copy-btn')})</span>`;
    } else if (trackingStatus === 'missing') {
      badgeHtml = `<span class="sync-badge missing"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="7"/><line x1="8" y1="5" x2="8" y2="8"/><circle cx="8" cy="11" r="0.75" fill="currentColor"/></svg> Non presente su PrestaShop</span>`;
    } else {
      badgeHtml = `<span class="sync-badge differs"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="7"/><line x1="8" y1="5" x2="8" y2="8"/><circle cx="8" cy="11" r="0.75" fill="currentColor"/></svg> Diverso: ${copyableValue(liveTracking, 'Tracking PrestaShop', 'live-tracking-copy-btn')}</span>`;
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

    container.innerHTML = `
      <div class="sync-card-header">
        <span class="sync-card-title">
          <span class="sync-live-dot" aria-hidden="true"></span>
          Sincronizzazione PrestaShop Live
        </span>
        <button id="refresh-prestashop-live-btn" type="button" class="sync-refresh-btn" title="Ricarica stato live da PrestaShop">
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
        ${actionHtml}
      </div>
    `;

    $('#refresh-prestashop-live-btn')?.addEventListener('click', () => {
      $('#refresh-prestashop-live-btn').classList.add('spinning');
      loadPrestaShopLiveSync(shipment, requestToken);
    });

    const syncBtn = $('#sync-prestashop-btn');
    if (syncBtn) {
      syncBtn.addEventListener('click', async () => {
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
          tell('#control-dsv-message', result.message, 'success');
          await refreshControlCenter();
          await openShipmentDetail(shipment.trackingNumber);
        } catch (err) {
          tell('#control-dsv-message', err.message, 'error');
          syncBtn.disabled = false;
          syncBtn.innerHTML = originalContent;
        }
      });
    }
  } catch (err) {
    if (requestToken !== controlDetailRequestToken) return;
    container.innerHTML = `<div class="sync-card-header"><span class="sync-card-title"><span class="sync-live-dot error" aria-hidden="true"></span>Sincronizzazione PrestaShop</span></div><p class="sync-status-msg" style="color:var(--danger);margin:4px 0;">Errore: ${escapeHtml(err.message)}</p>`;
  }
}

$('#config-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try { const config = await request('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseUrl: $('#base-url').value, apiKey: $('#api-key').value }) }); tell('#connection-message', config.configured ? 'Configurazione salvata. Ora scarica stati e corrieri.' : 'URL salvato. Inserisci anche la chiave Webservice.', 'success'); $('#api-key').value = ''; }
  catch (e) { tell('#connection-message', e.message, 'error'); }
});

$('#test-connection').addEventListener('click', async () => {
  try {
    $('#test-connection').disabled = true; tell('#connection-message', 'Controllo connessione e autorizzazioni in corso…');
    const { results, passed } = await request('/api/config/test', { method: 'POST' });
    const panel = $('#permission-check'); panel.hidden = false;
    panel.innerHTML = `<h3>${passed ? 'Connessione pronta' : 'Permessi da correggere'}</h3><p>Il test di scrittura usa richieste intenzionalmente non valide: non modifica ordini né spedizioni.</p><div class="permission-grid">${results.map((item) => `<div class="permission ${item.authorized ? 'pass' : 'fail'}"><strong>${item.authorized ? '✓' : '!'} ${escapeHtml(item.label)}</strong><span>${item.method} · HTTP ${item.status}</span><small>${escapeHtml(item.detail)}</small></div>`).join('')}</div>`;
    tell('#connection-message', passed ? 'Tutte le autorizzazioni necessarie sono disponibili.' : 'Alcune autorizzazioni richieste non sono disponibili.', passed ? 'success' : 'error');
  } catch (e) { tell('#connection-message', e.message, 'error'); }
  finally { $('#test-connection').disabled = false; }
});

$('#load-catalog').addEventListener('click', async () => {
  try {
    const [{ statuses, carriers }, defCarrier] = await Promise.all([
      request('/api/catalog'),
      request('/api/settings/default-carrier').catch(() => ({})),
    ]);
    const fill = (el, rows, label) => { el.innerHTML = `<option value="">Seleziona ${label}</option>` + rows.map((x) => `<option value="${escapeHtml(x.id)}">${escapeHtml(x.name)}</option>`).join(''); };
    fill($('#state'), statuses, 'uno stato');
    fill($('#carrier'), carriers, 'un corriere');
    if (defCarrier.defaultCarrierId) {
      $('#carrier').value = defCarrier.defaultCarrierId;
    }
    tell('#catalog-message', `${statuses.length} stati e ${carriers.length} corrieri disponibili.`, 'success');
  } catch (e) { tell('#catalog-message', e.message, 'error'); }
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

$('#upload-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const fileObj = $('#file').files[0];
    currentImportFileName = fileObj?.name || 'File Excel';
    currentImportOrigin = 'excel';
    const form = new FormData(); form.append('file', fileObj);
    const { summary, rows } = await request('/api/import/preview', { method: 'POST', body: form });
    previewRows = rows; verificationId = ''; importApplied = false; $('#summary').hidden = false; $('#verify-progress').hidden = true; $('#apply-feedback').hidden = true; if ($('#apply-progress')) $('#apply-progress').hidden = true;
    $('#summary').textContent = `${summary.total} righe lette · ${summary.ready} nuove candidate · ${summary.skipped ? `${summary.skipped} già importate (saltate) · ` : ''}${summary.invalid} da controllare`;
    renderRows(rows); $('#preview').hidden = false; $('#verify-import').hidden = false; $('#apply-import').hidden = true; $('#select-all').hidden = true; $('#clear-selection').hidden = true; $('#toggle-all').hidden = true; $('#selected-count').hidden = true; $('#update-options').hidden = true; $('#dsv-beta').hidden = true; $('#verify-dsv-beta').hidden = true;
    tell('#import-message', summary.skipped ? `Analisi completata: ${summary.skipped} spedizioni già importate escluse, ${summary.ready} nuove pronte per verifica.` : 'Analisi completata. Verifica ora gli ordini: quelli con tracking esistente saranno saltati.', 'success');
  } catch (e) { tell('#import-message', e.message, 'error'); }
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
  const updateTracking = $('#update-tracking').checked; const updateState = $('#update-state').checked;
  if (!updateTracking && !updateState) { tell('#import-message', 'Scegli almeno un tipo di aggiornamento.', 'error'); return; }
  if (!confirm(`Confermi l’aggiornamento di ${selected.length} righe selezionate? Le righe non selezionate non saranno modificate.`)) return;
  try {
    $('#apply-import').disabled = true; updateApplyProgress({ completed: 0, total: selected.length }); tell('#import-message', `Aggiornamento di ${selected.length} righe in corso…`);
    const { jobId } = await request('/api/import/apply-jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ verificationId, carrierId: $('#carrier').value, stateId: $('#state').value, updateTracking, updateState, selectedSourceRows: selected.map((row) => row.sourceRow) }) });
    const { summary, results } = await waitForApply(jobId);
    const outcomeByRow = new Map(results.map((row) => [Number(row.sourceRow), row]));
    const selectedStateName = $('#state').selectedOptions[0]?.textContent || '';
    importApplied = true;
    previewRows = previewRows.map((row) => {
      const outcome = outcomeByRow.get(Number(row.sourceRow));
      if (!outcome) return row;
      return { ...row, selected: false, applyResult: outcome.result, applyDetail: outcome.detail, currentState: outcome.result === 'Aggiornata' && updateState ? selectedStateName : row.currentState };
    });
    renderRows(previewRows, 'verification'); updateSelectionUi(); showApplyFeedback(summary); void refreshControlCenter();
    tell('#import-message', Object.entries(summary).map(([name, count]) => `${name}: ${count}`).join(' · '), Number(summary.Errore || 0) ? 'warning' : 'success');
  }
  catch (e) { tell('#import-message', e.message, 'error'); }
  finally { $('#apply-import').disabled = false; }
});

$('#save-dsv-beta').addEventListener('click', async () => {
  try {
    const data = await request('/api/dsv-beta/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: $('#dsv-beta-enabled').checked, camofoxUrl: $('#dsv-camofox-url').value, trackingUrl: $('#dsv-tracking-url').value }) });
    dsvBetaSettings = data; updateControlServiceStatus(); updateSelectionUi(); updateControlSelectionUi([...document.querySelectorAll('.control-row-select')].map((input) => ({ trackingNumber: input.dataset.tracking })));
    tell('#dsv-config-message', data.enabled ? `Servizio attivo: massimo ${data.maxRows} righe per blocco, una richiesta ogni ${data.intervalMs / 1000} secondi, cache fino a ${data.cacheHours} ore.` : 'Configurazione salvata; servizio disattivato.', data.enabled ? 'warning' : '');
  } catch (e) { tell('#dsv-config-message', e.message, 'error'); }
});

$('#test-dsv-beta').addEventListener('click', async () => {
  try { $('#test-dsv-beta').disabled = true; tell('#dsv-config-message', 'Controllo del servizio Camoufox locale in corso…'); const result = await request('/api/dsv-beta/test', { method: 'POST' }); tell('#dsv-config-message', result.message, 'success'); }
  catch (e) { tell('#dsv-config-message', e.message, 'error'); }
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
    tell('#dsv-beta-message', 'Verifica lenta e sequenziale in corso: una spedizione ogni 5 secondi.');
    const { jobId } = await request('/api/dsv-beta/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trackingNumbers: selected.map((row) => row.trackingNumber) }) });
    const { results, safeguards } = await waitForDsvBeta(jobId);
    const byTracking = new Map(results.map((result) => [result.trackingNumber, result]));
    previewRows = previewRows.map((row) => { const result = byTracking.get(row.trackingNumber); return result ? { ...row, dsvBetaStatus: result.status, dsvBetaDetail: result.detail } : row; });
    renderRows(previewRows, 'verification'); updateSelectionUi(); void refreshControlCenter();
    const cached = results.filter((row) => row.cached).length;
    tell('#dsv-beta-message', `${results.length} spedizioni controllate${cached ? `, ${cached} da cache` : ''}. Limiti applicati: ${safeguards.maxRows} righe, ${safeguards.intervalMs / 1000}s tra richieste, cache fino a ${safeguards.cacheHours}h.`, 'success');
  } catch (e) { tell('#dsv-beta-message', e.message, 'error'); }
  finally { $('#verify-dsv-beta').disabled = false; }
});

$('#refresh-control-center').addEventListener('click', refreshControlCenter);
$('#control-exceptions').addEventListener('change', () => { controlPage = 1; refreshControlCenter(); });
$('.control-center-card').addEventListener('click', (event) => {
  const quickFilter = event.target.closest('.control-quick-filter');
  if (!quickFilter) return;
  $('#control-dsv-filter').value = quickFilter.dataset.dsvStatus || '';
  $('#control-exceptions').checked = false;
  document.querySelectorAll('.control-quick-filter').forEach((button) => button.classList.toggle('active', button === quickFilter));
  controlPage = 1;
  refreshControlCenter();
});
$('#control-table tbody').addEventListener('change', (event) => {
  if (!event.target.matches('.control-row-select')) return;
  const trackingNumber = event.target.dataset.tracking;
  if (event.target.checked) controlSelectedTrackingNumbers.add(trackingNumber);
  else controlSelectedTrackingNumbers.delete(trackingNumber);
  updateControlSelectionUi([...document.querySelectorAll('.control-row-select')].map((input) => ({ trackingNumber: input.dataset.tracking })));
});
$('#control-toggle-all').addEventListener('change', (event) => {
  document.querySelectorAll('.control-row-select').forEach((input) => {
    input.checked = event.target.checked;
    if (event.target.checked) controlSelectedTrackingNumbers.add(input.dataset.tracking);
    else controlSelectedTrackingNumbers.delete(input.dataset.tracking);
  });
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
  renderControlCenter(controlOverview);
});
$('#control-table tbody').addEventListener('click', (event) => {
  const updateButton = event.target.closest('.update-prestashop-state');
  if (updateButton && !updateButton.disabled) return openPrestaShopStateDialog(updateButton.dataset.tracking);
  const button = event.target.closest('.open-shipment');
  if (button) return openShipmentDetail(button.dataset.tracking);
  if (event.target.closest('input, button')) return;
  const row = event.target.closest('tr[data-tracking]');
  if (row) openShipmentDetail(row.dataset.tracking);
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
Promise.all([initialConfig(), loadDsvBeta(), refreshControlCenter(), loadCronStatus()]).catch(() => {});
showView(location.hash.slice(1) || 'control');
