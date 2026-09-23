import { randomUUID } from 'node:crypto';

const DSV_HOSTS = new Set(['www.dsv.com', 'dsv.com']);
const REQUEST_TIMEOUT_MS = 20_000;
const TRACKING_POLL_TIMEOUT_MS = 18_000;
const TRACKING_POLL_INTERVAL_MS = 700;
const FAST_TRACKING_POLL_INTERVALS_MS = [250, 500, 800, 1200];
const ULTRA_TRACKING_POLL_INTERVALS_MS = [150, 250, 400, 600];
export const DSV_PARSER_VERSION = 6;
export const DEFAULT_DSV_TRACKING_URL = 'https://www.dsv.com/mydsv/tracking-public/?refNumber=TRACKINGDAINSERIRE&language_region=it-IT_IT';

export const DSV_SPEED_PROFILES = Object.freeze({
  safe: Object.freeze({ id: 'safe', reuseTab: false, initialDelayMs: 500, manualDelayMs: [2000, 3200], cronDelayMs: [4000, 6000] }),
  fast: Object.freeze({ id: 'fast', reuseTab: true, initialDelayMs: 150, manualDelayMs: [1200, 2000], cronDelayMs: [1800, 3000] }),
  ultra: Object.freeze({ id: 'ultra', reuseTab: true, initialDelayMs: 80, manualDelayMs: [400, 800], cronDelayMs: [1000, 1600] }),
});

export function normalizeDsvSpeedProfile(value) {
  return ['fast', 'ultra'].includes(value) ? value : 'safe';
}

function assertLoopback(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new Error('Il servizio Camofox deve essere disponibile solo in locale (127.0.0.1 o localhost).');
  }
  return url.toString().replace(/\/$/, '');
}

export function normalizeBetaSettings(input = {}) {
  const camofoxUrl = assertLoopback(input.camofoxUrl || 'http://127.0.0.1:9377');
  const trackingUrl = new URL(input.trackingUrl || DEFAULT_DSV_TRACKING_URL);
  if (trackingUrl.protocol !== 'https:' || !DSV_HOSTS.has(trackingUrl.hostname)) {
    throw new Error('Per la beta è consentita solo una pagina HTTPS ufficiale dsv.com.');
  }
  return { enabled: Boolean(input.enabled), camofoxUrl, trackingUrl: trackingUrl.toString(), speedProfile: normalizeDsvSpeedProfile(input.speedProfile) };
}

function cleanSnapshot(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 700);
}

function findRef(snapshot, expression) {
  const line = String(snapshot).split(/\r?\n/).find((item) => expression.test(item));
  return line?.match(/\b(e\d+)\b/i)?.[1] || null;
}

const DSV_STATUS_RULES = [
  { status: 'Consegnata', expression: /\b(?:consegnat[ao]|delivered)\b/i },
  { status: 'In consegna', expression: /\b(?:in consegna|out for delivery)\b/i },
  { status: 'Centro di distribuzione', expression: /\b(?:(?:presso (?:il )?)?centro di distribuzione|distribution cent(?:er|re))\b/i },
  { status: 'In transito', expression: /\b(?:in transito|in transit)\b/i },
  { status: 'Prenotata', expression: /\b(?:prenotat[ao]|booked)\b/i },
];

export function canonicalDsvStatus(value) {
  if (/\b(?:non consegnat[oa]|not delivered|delivery failed)\b/i.test(String(value))) return null;
  return DSV_STATUS_RULES.find((rule) => rule.expression.test(String(value)))?.status || null;
}

function statusResult(status, detail, { evidence = 'none', confidence = 0, reasonCode = 'STATUS_UNRESOLVED', rawStatus = '', statusDateRaw = '', statusAt = '', statusDatePrecision = '' } = {}) {
  return { status, detail, rawStatus: cleanSnapshot(rawStatus).slice(0, 160), evidence, confidence, reasonCode, statusDateRaw, statusAt, statusDatePrecision, parserVersion: DSV_PARSER_VERSION };
}

export function parseDsvStatusSnapshot(snapshot) {
  const raw = String(snapshot ?? '');
  const text = cleanSnapshot(raw);
  const guarded = /captcha|recaptcha|verify you are human|access denied|sign in|log in|password/i.test(raw);
  if (guarded) return statusResult('Intervento manuale richiesto', 'Il sito richiede una verifica o un accesso: la beta non li aggira.', { evidence: 'guard', confidence: 1, reasonCode: 'ACCESS_GUARD' });
  if (/spedizione non trovata|shipment not found/i.test(raw)) return statusResult('Spedizione non trovata', 'DSV non trova il numero di riferimento indicato.', { evidence: 'message', confidence: .98, reasonCode: 'SHIPMENT_NOT_FOUND' });

  const headlinePatterns = [
    /la tua spedizione\s+(?:è|e')\s+([^\n!?.]{2,100})/i,
    /your shipment\s+is\s+([^\n!?.]{2,100})/i,
    /lo status attuale della tua spedizione(?:\s+è|\s+is)\s*[:\-]?\s*([^\n.!]{2,140})/i,
    /(?:current status of your shipment)(?:\s+is)?\s*[:\-]?\s*([^\n.!]{2,140})/i,
  ];
  for (const pattern of headlinePatterns) {
    const match = raw.match(pattern);
    const status = match && canonicalDsvStatus(match[1]);
    if (status) return statusResult(status, 'Stato corrente letto dal riepilogo della pagina pubblica DSV.', { evidence: 'headline', confidence: .99, reasonCode: 'STATUS_CONFIRMED', rawStatus: match[1] });
  }

  const activeLine = raw.split(/\r?\n/).find((line) => /\b(?:selected|current|active|aria-current|stato attuale|step attuale)\b/i.test(line) && canonicalDsvStatus(line));
  if (activeLine) return statusResult(canonicalDsvStatus(activeLine), 'Stato corrente letto dallo step attivo della pagina pubblica DSV.', { evidence: 'active-step', confidence: .96, reasonCode: 'STATUS_CONFIRMED', rawStatus: activeLine });

  const labelledPatterns = [
    /(?:shipment|tracking|delivery)\s+status\s*[:\-]?\s*([^\n|]{2,100})/i,
    /(?:stato(?: della)? spedizione)\s*[:\-]?\s*([^\n|]{2,100})/i,
  ];
  for (const pattern of labelledPatterns) {
    const match = raw.match(pattern);
    const status = match && canonicalDsvStatus(match[1]);
    if (status) return statusResult(status, 'Stato corrente letto dalla pagina pubblica DSV.', { evidence: 'label', confidence: .9, reasonCode: 'STATUS_CONFIRMED', rawStatus: match[1] });
  }

  const statusesFound = new Set(DSV_STATUS_RULES.filter((rule) => rule.expression.test(raw)).map((rule) => rule.status));
  if (/\bnon consegnat[oa]\b/i.test(raw)) statusesFound.delete('Consegnata');
  if (statusesFound.size === 1) return statusResult([...statusesFound][0], 'Unico stato riconoscibile nella pagina pubblica DSV.', { evidence: 'unique-text', confidence: .72, reasonCode: 'STATUS_INFERRED', rawStatus: [...statusesFound][0] });
  return statusResult('Da verificare manualmente', text ? 'La pagina non espone ancora uno stato corrente riconoscibile.' : 'Nessun contenuto leggibile restituito dalla pagina.', { evidence: 'none', confidence: 0, reasonCode: text ? 'STATUS_NOT_READY' : 'EMPTY_PAGE' });
}

export function normalizeDsvTimeline(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, 60).map((row) => {
    let country = cleanSnapshot(row?.country).slice(0, 40);
    let date = cleanSnapshot(row?.date).slice(0, 80);
    let location = cleanSnapshot(row?.location).slice(0, 160);
    let reason = cleanSnapshot(row?.reason).slice(0, 300);
    // Alcune pagine DSV non hanno la colonna Paese: i quattro valori risultano traslati.
    if (parseDsvEventDate(country).local && !parseDsvEventDate(date).local) {
      reason ||= location;
      location = date;
      date = country;
      country = '';
    }
    if (!parseDsvEventDate(date).local && parseDsvEventDate(location).local) [date, location] = [location, date];
    return {
      event: cleanSnapshot(row?.event).slice(0, 160),
      country,
      date,
      location,
      reason,
    };
  }).filter((row) => row.event || row.date || row.location || row.reason);
}

export function parseDsvEventDate(value) {
  const raw = cleanSnapshot(value).slice(0, 80);
  if (!raw) return { raw: '', local: '', precision: '' };
  const italian = raw.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:[,\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (italian) {
    const [, day, month, year, hour, minute, second] = italian;
    const date = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    return hour === undefined
      ? { raw, local: date, precision: 'date' }
      : { raw, local: `${date}T${hour.padStart(2, '0')}:${minute}:${second || '00'}`, precision: 'datetime' };
  }
  const iso = raw.match(/^(\d{4}-\d{2}-\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (iso) return iso[2]
    ? { raw, local: `${iso[1]}T${iso[2]}:${iso[3]}:${iso[4] || '00'}`, precision: 'datetime' }
    : { raw, local: iso[1], precision: 'date' };
  return { raw, local: '', precision: 'raw' };
}

export function timelineRowStatus(row) {
  const event = String(row?.event || '');
  const reason = String(row?.reason || '');
  const value = `${event} ${reason}`;
  if (/terminal dal mittente|sender terminal/i.test(value)) return 'Prenotata';
  if (/\b(?:consegnat[oa]|delivered)\b/i.test(event) && !/\b(?:non consegnat[oa]|not delivered)\b/i.test(event)) return 'Consegnata';
  if (/\b(?:non consegnat[oa]|failed delivery|delivery failed)\b/i.test(event)) {
    if (/\b(?:restituit[oa] al mittente|reso al mittente|return(?:ed)? to sender)\b/i.test(reason)) return 'Reso al mittente';
    if (/\b(?:data (?:di )?consegna variat[ao]|consegna riprogrammat[ao]|nuova data|rescheduled|posticipat[ao]|rinviat[ao])\b/i.test(reason)) return 'Consegna riprogrammata';
    if (/\b(?:rifiutat[oa]|rifiuto|refused)\b/i.test(reason)) return 'Consegna rifiutata';
    return 'Tentativo non riuscito';
  }
  if (/\b(?:a disposizione del destinatario|in giacenza|giacenza|available for collection|held for collection)\b/i.test(event)) {
    if (/\b(?:restituit[oa] al mittente|reso al mittente|return(?:ed)? to sender)\b/i.test(reason)) return 'Reso al mittente';
    if (/\b(?:data (?:di )?consegna variat[ao]|consegna riprogrammat[ao]|nuova data|rescheduled|posticipat[ao]|rinviat[ao])\b/i.test(reason)) return 'Consegna riprogrammata';
    return 'In attesa del destinatario';
  }
  if (/\b(?:restituit[oa] al mittente|reso al mittente|return(?:ed)? to sender)\b/i.test(value)) return 'Reso al mittente';
  if (/\b(?:non caricat|mancanza di capacit|ritardo operativo|capacity shortage)\b/i.test(value)) return 'Ritardo operativo';
  if (/\b(?:rifiutat[oa]|rifiuto|refused)\b/i.test(event)) return 'Consegna rifiutata';
  if (/\b(?:eccezion|exception)\b/i.test(value)) return 'Eccezione DSV';
  const canonical = canonicalDsvStatus(event);
  if (canonical) return canonical;
  if (/fuori per la consegna|out for delivery/i.test(value)) return 'In consegna';
  if (/\b(?:partit|arrivat|departed|arrived)\b/i.test(value)) return 'In transito';
  return null;
}

export const DSV_DELIVERY_EVENT_STATUSES = Object.freeze(['Consegna riprogrammata', 'Consegna rifiutata', 'Tentativo non riuscito', 'In attesa del destinatario', 'Ritardo operativo', 'Reso al mittente', 'Eccezione DSV']);
const DELIVERY_EVENT_OUTCOMES = new Set(DSV_DELIVERY_EVENT_STATUSES);

function latestRecognizedTimelineEvent(timeline) {
  const rows = normalizeDsvTimeline(timeline).map((row, index) => ({ row, index, status: timelineRowStatus(row), parsed: parseDsvEventDate(row.date) })).filter((item) => item.status);
  if (!rows.length) return null;
  // Lo storico DSV può contenere righe fuori ordine: la data prevale sulla posizione nel DOM.
  rows.sort((left, right) => {
    if (left.parsed.local && right.parsed.local) return left.parsed.local.localeCompare(right.parsed.local) || left.index - right.index;
    return left.index - right.index;
  });
  return rows.at(-1);
}

export function findDsvStatusEvent(status, timeline) {
  const row = [...normalizeDsvTimeline(timeline)].reverse().find((item) => timelineRowStatus(item) === status);
  if (!row) return null;
  const parsedDate = parseDsvEventDate(row.date);
  return { ...row, statusDateRaw: parsedDate.raw, statusAt: parsedDate.local, statusDatePrecision: parsedDate.precision };
}

function statusFromTimeline(timeline) {
  const latest = latestRecognizedTimelineEvent(timeline);
  if (!latest) return null;
  const { row, status, parsed } = latest;
  const exception = DELIVERY_EVENT_OUTCOMES.has(status);
  const options = { evidence: 'timeline', confidence: exception ? .96 : status === 'In transito' ? .76 : status === 'Prenotata' ? .72 : .82, reasonCode: exception ? 'DELIVERY_EVENT' : 'STATUS_INFERRED', rawStatus: row.event, statusDateRaw: parsed.raw, statusAt: parsed.local, statusDatePrecision: parsed.precision };
  return { ...statusResult(status, exception ? `Ultimo evento DSV: ${row.event}${row.reason ? ` — ${row.reason}` : ''}.` : 'Stato inferito dall’ultimo evento utile dello storico DSV.', options), eventReason: row.reason, eventLocation: row.location };
}

export function parseDsvDomEvidence(evidence = {}) {
  const latestTimeline = statusFromTimeline(evidence.timeline);
  const headingResults = (evidence.headings || []).map((heading) => parseDsvStatusSnapshot(heading));
  const deliveredHeading = headingResults.find((result) => result.status === 'Consegnata');
  if (deliveredHeading) return { ...deliveredHeading, evidence: 'dom-headline', confidence: Math.max(deliveredHeading.confidence, .98) };
  // Un tentativo non riuscito più recente dello step "In consegna" non deve essere nascosto dal titolo.
  if (latestTimeline && DELIVERY_EVENT_OUTCOMES.has(latestTimeline.status)) {
    const phaseStatus = headingResults.find((result) => result.status === 'In consegna')?.status
      || (evidence.activeTexts || []).map(canonicalDsvStatus).find((status) => status === 'In consegna') || '';
    return { ...latestTimeline, phaseStatus };
  }
  for (const result of headingResults) {
    if (result.status !== 'Da verificare manualmente') return { ...result, evidence: 'dom-headline', confidence: Math.max(result.confidence, .98) };
  }
  for (const activeText of evidence.activeTexts || []) {
    const statuses = DSV_STATUS_RULES.filter((rule) => rule.expression.test(String(activeText))).map((rule) => rule.status);
    if (statuses.length === 1) return statusResult(statuses[0], 'Stato letto dall’elemento attivo della pagina DSV.', { evidence: 'dom-active-step', confidence: .97, reasonCode: 'STATUS_CONFIRMED', rawStatus: activeText });
  }
  return latestTimeline;
}

export class DsvBetaClient {
  constructor(settings) {
    this.settings = normalizeBetaSettings(settings);
    this.userId = 'prestashop-dsv-beta';
    this.activeSessionKey = 'dsv-shared-session';
    this.requestedSpeedProfile = this.settings.speedProfile;
    this.effectiveSpeedProfile = this.requestedSpeedProfile;
    this.activeTabId = '';
    this.unstableResultCount = 0;
    this.fallbackReason = '';
    this.cookieConsentChecked = false;
  }

  async resetSession(reason = 'La sessione Camoufox è stata reimpostata dopo un errore.') {
    const staleTabId = this.activeTabId;
    this.activeTabId = '';
    this.cookieConsentChecked = false;
    this.activeSessionKey = `dsv-session-${randomUUID()}`;
    if (this.effectiveSpeedProfile !== 'safe') this.downgradeProfile(reason);
    await this.closeTab(staleTabId);
  }

  downgradeProfile(reason, forceSafe = false) {
    if (this.effectiveSpeedProfile === 'safe') return;
    this.effectiveSpeedProfile = forceSafe || this.effectiveSpeedProfile === 'fast' ? 'safe' : 'fast';
    this.fallbackReason = `${reason} Ora è attiva la modalità ${this.effectiveSpeedProfile === 'fast' ? 'rapida' : 'affidabile'}.`;
  }

  getRuntimeProfile() {
    return {
      requested: this.requestedSpeedProfile,
      effective: this.effectiveSpeedProfile,
      fallback: this.requestedSpeedProfile !== this.effectiveSpeedProfile,
      fallbackReason: this.fallbackReason,
    };
  }

  getPacingDelay(scope = 'manual', random = Math.random) {
    const profile = DSV_SPEED_PROFILES[this.effectiveSpeedProfile];
    const [min, max] = scope === 'cron' ? profile.cronDelayMs : profile.manualDelayMs;
    return min + Math.floor(random() * (max - min + 1));
  }

  async closeTab(tabId) {
    if (!tabId) return;
    await this.request(`/tabs/${encodeURIComponent(tabId)}?userId=${encodeURIComponent(this.userId)}`, { method: 'DELETE' }).catch(() => {});
    if (this.activeTabId === tabId) this.activeTabId = '';
  }

  async close() {
    const tabId = this.activeTabId;
    this.activeTabId = '';
    await this.closeTab(tabId);
  }

  noteTrackingResult(result) {
    const accessGuard = result?.reasonCode === 'ACCESS_GUARD' || result?.status === 'Intervento manuale richiesto';
    const unstable = result?.status === 'Da verificare manualmente' || result?.reasonCode === 'STATUS_TIMEOUT';
    this.unstableResultCount = unstable ? this.unstableResultCount + 1 : 0;
    if (accessGuard) this.downgradeProfile('DSV richiede una verifica o blocca l’accesso.', true);
    else if (this.effectiveSpeedProfile === 'ultra' && unstable) this.downgradeProfile('Un risultato DSV non è stato stabile.');
    else if (this.effectiveSpeedProfile === 'fast' && this.unstableResultCount >= 2) this.downgradeProfile('Due risultati DSV consecutivi non sono stati stabili.');
  }

  async acquireTab(url) {
    const reuseTab = DSV_SPEED_PROFILES[this.effectiveSpeedProfile].reuseTab;
    if (reuseTab && this.activeTabId) {
      try {
        await this.request(`/tabs/${encodeURIComponent(this.activeTabId)}/navigate`, {
          method: 'POST',
          body: JSON.stringify({ userId: this.userId, sessionKey: this.activeSessionKey, url }),
        });
        return this.activeTabId;
      } catch {
        await this.closeTab(this.activeTabId);
      }
    }
    const tab = await this.request('/tabs', { method: 'POST', body: JSON.stringify({ userId: this.userId, sessionKey: this.activeSessionKey, url }) });
    const tabId = tab.tabId || tab.id;
    if (!tabId) throw new Error('Camofox non ha restituito una scheda di navigazione.');
    if (reuseTab) this.activeTabId = tabId;
    return tabId;
  }

  async request(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${this.settings.camofoxUrl}${path}`, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...(process.env.CAMOFOX_ACCESS_KEY ? { Authorization: `Bearer ${process.env.CAMOFOX_ACCESS_KEY}` } : {}),
          ...(options.headers || {}),
        },
        signal: controller.signal,
      });
      const body = await response.text();
      let data;
      try { data = body ? JSON.parse(body) : {}; } catch { data = { raw: body }; }
      if (!response.ok) throw new Error(data.error || data.message || `Camofox ha risposto HTTP ${response.status}.`);
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('Camofox non ha risposto entro 20 secondi.');
      if (error instanceof TypeError && error.message === 'fetch failed') throw new Error('Camofox locale non è raggiungibile. Avvialo con npm run camofox e riprova.');
      throw error;
    } finally { clearTimeout(timer); }
  }

  async testConnection() {
    await this.request('/health');
    return { ok: true };
  }

  async extractDomEvidence(tabId) {
    const expression = `(() => {
      const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const hasDate = (value) => /^\\d{1,2}[./-]\\d{1,2}[./-]\\d{4}/.test(value);
      const makeRow = (cells) => {
        const values = cells.map(clean);
        while (values.length > 4 && !values[0]) values.shift();
        if (hasDate(values[1])) return { event: values[0], country: '', date: values[1], location: values[2], reason: values[3] };
        return { event: values[0], country: values[1], date: values[2], location: values[3], reason: values[4] };
      };
      const documents = [document];
      for (const frame of document.querySelectorAll('iframe')) { try { if (frame.contentDocument) documents.push(frame.contentDocument); } catch {} }
      const headings = documents.flatMap((doc) => Array.from(doc.querySelectorAll('h1,h2,h3,[role="heading"]')).map((node) => clean(node.innerText || node.textContent))).filter(Boolean).slice(0, 30);
      const activeSelector = '[aria-current="true"],[aria-current="step"],[aria-selected="true"],.active,.selected,.current,[class*="active"],[class*="selected"],[class*="current"]';
      const activeTexts = documents.flatMap((doc) => Array.from(doc.querySelectorAll(activeSelector)).map((node) => clean(node.innerText || node.textContent)).filter((value) => value.length <= 120 && /prenot|transit|distribu|consegn|deliver|booked/i.test(value))).slice(0, 20);
      const timeline = [];
      let historyTableRows = 0;
      for (const doc of documents) {
        const tables = Array.from(doc.querySelectorAll('table'));
        const table = tables.find((item) => /evento|event/i.test(item.innerText) && /data|date/i.test(item.innerText) && /locali|location/i.test(item.innerText));
        const tableRows = table ? Array.from(table.querySelectorAll('tbody tr')).map((row) => makeRow(Array.from(row.querySelectorAll('td')).map((cell) => cell.innerText))) : [];
        if (tableRows.length) { historyTableRows += tableRows.length; timeline.push(...tableRows); continue; }
        const rows = Array.from(doc.querySelectorAll('[role="row"]')).map((row) => Array.from(row.querySelectorAll('[role="cell"], [role="gridcell"]')).map((cell) => cell.innerText));
        timeline.push(...rows.filter((cells) => cells.length >= 3 && !/evento|event/i.test(cells[0] || '')).map(makeRow));
      }
      const unique = Array.from(new Map(timeline.filter((row) => row.event || row.date).map((row) => [JSON.stringify(row), row])).values());
      return { headings, activeTexts, timeline: unique, historyTableRows, frameCount: documents.length - 1 };
    })()`;
    const response = await this.request(`/tabs/${encodeURIComponent(tabId)}/evaluate`, { method: 'POST', body: JSON.stringify({ userId: this.userId, expression }) });
    const result = response.result || {};
    return { headings: Array.isArray(result.headings) ? result.headings.slice(0, 30) : [], activeTexts: Array.isArray(result.activeTexts) ? result.activeTexts.slice(0, 20) : [], timeline: normalizeDsvTimeline(result.timeline), historyTableRows: Number(result.historyTableRows) || 0, frameCount: Number(result.frameCount) || 0 };
  }

  async expandStatusHistory(tabId, snapshot) {
    const page = await snapshot();
    const match = String(page).match(/button "(?:Storico status spedizione|Shipment status history)" \[(e\d+)\]([^\n]*)/i);
    if (!match) return { found: false, clicked: false, page };
    if (/\[expanded\]/i.test(match[2])) return { found: true, clicked: false, page };
    await this.request(`/tabs/${encodeURIComponent(tabId)}/click`, { method: 'POST', body: JSON.stringify({ userId: this.userId, ref: match[1] }) });
    await new Promise((resolve) => setTimeout(resolve, 180));
    return { found: true, clicked: true, page: '' };
  }

  async waitForTrackingResult(tabId, snapshot) {
    const deadline = Date.now() + TRACKING_POLL_TIMEOUT_MS;
    const historyGraceDeadline = Date.now() + 4500;
    const acceleratedMode = this.effectiveSpeedProfile !== 'safe';
    let best = null;
    let stableStatus = '';
    let stableReads = 0;
    let pollIndex = 0;
    let lastEvidence = { headings: [], activeTexts: [], timeline: [], frameCount: 0 };
    let historyButtonSeen = false;
    let historyTableSeen = false;
    do {
      const history = await this.expandStatusHistory(tabId, snapshot).catch(() => ({ found: false, clicked: false }));
      historyButtonSeen ||= history.found;
      const domEvidence = await this.extractDomEvidence(tabId).catch(() => lastEvidence);
      lastEvidence = domEvidence;
      historyTableSeen ||= domEvidence.historyTableRows > 0;
      const domResult = parseDsvDomEvidence(domEvidence);
      const historyReady = historyButtonSeen
        ? !history.clicked && domEvidence.historyTableRows > 0
        : Date.now() >= historyGraceDeadline;
      if (acceleratedMode && historyReady && domResult?.status !== 'Da verificare manualmente' && domResult?.confidence >= .9) {
        return { result: domResult, timeline: domEvidence.timeline };
      }
      const page = history.page || await snapshot();
      const snapshotResult = parseDsvStatusSnapshot(page);
      const deliveryEvent = domResult && DELIVERY_EVENT_OUTCOMES.has(domResult.status);
      const candidates = [snapshotResult, domResult].filter(Boolean).sort((a, b) => b.confidence - a.confidence);
      // Lo storico con evento negativo datato prevale sul riepilogo generico "In consegna".
      if (deliveryEvent && snapshotResult.status === 'In consegna' && domResult.statusAt) candidates.unshift(domResult);
      const current = candidates[0];
      if (!best || current.confidence > best.confidence) best = current;
      if (current.status !== 'Da verificare manualmente') {
        if (stableStatus === current.status) stableReads += 1;
        else { stableStatus = current.status; stableReads = 1; }
        if (historyReady && (current.confidence >= .9 || stableReads >= 2)) return { result: current, timeline: domEvidence.timeline };
      }
      if (Date.now() < deadline) {
        const pollIntervals = this.effectiveSpeedProfile === 'ultra' ? ULTRA_TRACKING_POLL_INTERVALS_MS : FAST_TRACKING_POLL_INTERVALS_MS;
        const delayMs = acceleratedMode ? pollIntervals[Math.min(pollIndex, pollIntervals.length - 1)] : TRACKING_POLL_INTERVAL_MS;
        pollIndex += 1;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    } while (Date.now() < deadline);
    if (historyButtonSeen && !historyTableSeen) {
      return { result: statusResult('Da verificare manualmente', 'La pagina DSV non ha caricato lo storico completo. Ripeti la verifica prima di usare lo stato corrente.', { evidence: 'history', confidence: 0, reasonCode: 'HISTORY_INCOMPLETE' }), timeline: lastEvidence.timeline };
    }
    const fallback = best?.status !== 'Da verificare manualmente' ? best : statusResult('Da verificare manualmente', 'Il tracking DSV non ha esposto uno stato stabile entro il tempo previsto. Puoi riprovare.', { evidence: best?.evidence || 'none', confidence: best?.confidence || 0, reasonCode: 'STATUS_TIMEOUT', rawStatus: best?.rawStatus || '' });
    return { result: fallback, timeline: lastEvidence.timeline };
  }

  async track(trackingNumber) {
    const trackingUrl = this.settings.trackingUrl.includes('TRACKINGDAINSERIRE')
      ? this.settings.trackingUrl.replaceAll('TRACKINGDAINSERIRE', encodeURIComponent(trackingNumber))
      : this.settings.trackingUrl;
    const tabId = await this.acquireTab(trackingUrl);
    const snapshot = async () => {
      const value = await this.request(`/tabs/${encodeURIComponent(tabId)}/snapshot?userId=${encodeURIComponent(this.userId)}`);
      return value.snapshot || value.data?.snapshot || value.raw || '';
    };
    const officialTrackingUrl = DEFAULT_DSV_TRACKING_URL.replaceAll('TRACKINGDAINSERIRE', encodeURIComponent(trackingNumber));
    const enrich = (statusResult, source, timeline = []) => {
      const normalizedTimeline = normalizeDsvTimeline(timeline);
      const statusEvent = findDsvStatusEvent(statusResult.status, normalizedTimeline);
      const output = { ...statusResult, statusDateRaw: statusResult.statusDateRaw || statusEvent?.statusDateRaw || '', statusAt: statusResult.statusAt || statusEvent?.statusAt || '', statusDatePrecision: statusResult.statusDatePrecision || statusEvent?.statusDatePrecision || '', source, trackingUrl: officialTrackingUrl, timeline: normalizedTimeline };
      this.noteTrackingResult(output);
      return output;
    };
    try {
      await new Promise((resolve) => setTimeout(resolve, DSV_SPEED_PROFILES[this.effectiveSpeedProfile].initialDelayMs));
      const directUrl = this.settings.trackingUrl.includes('TRACKINGDAINSERIRE');
      const shouldInspectEntryPage = this.effectiveSpeedProfile === 'safe' || !directUrl || !this.cookieConsentChecked;
      let page = '';
      if (shouldInspectEntryPage) {
        page = await snapshot();
        const necessaryOnlyRef = findRef(page, /use necessary cookies only|rifiuta tutto|solo cookie necessari|reject all/i);
        if (necessaryOnlyRef) {
          await this.request(`/tabs/${encodeURIComponent(tabId)}/click`, { method: 'POST', body: JSON.stringify({ userId: this.userId, ref: necessaryOnlyRef }) });
          await new Promise((resolve) => setTimeout(resolve, 350));
          page = await snapshot();
        }
        this.cookieConsentChecked = true;
      }

      if (directUrl) {
        const observed = await this.waitForTrackingResult(tabId, snapshot);
        return enrich(observed.result, 'Pagina di tracking pubblico DSV.', observed.timeline);
      }

      const trackingMenuRef = findRef(page, /button.*\btrack\b/i);
      if (trackingMenuRef) {
        await this.request(`/tabs/${encodeURIComponent(tabId)}/click`, { method: 'POST', body: JSON.stringify({ userId: this.userId, ref: trackingMenuRef }) });
        await new Promise((resolve) => setTimeout(resolve, 500));
        page = await snapshot();
      }

      const schenkRef = findRef(page, /track schenker shipment/i);
      if (schenkRef) {
        await this.request(`/tabs/${encodeURIComponent(tabId)}/click`, { method: 'POST', body: JSON.stringify({ userId: this.userId, ref: schenkRef }) });
        await new Promise((resolve) => setTimeout(resolve, 500));
        page = await snapshot();
      }
      const inputRef = findRef(page, /(?:textbox|input).*?(?:id number|shipment|tracking|reference)/i);
      if (!inputRef) return enrich(statusResult('Da verificare manualmente', 'Pagina DSV aperta, campo di ricerca non riconosciuto.', { evidence: 'form', confidence: 0, reasonCode: 'TRACKING_INPUT_NOT_FOUND' }), 'Pagina DSV aperta, campo di ricerca non riconosciuto.');
      await this.request(`/tabs/${encodeURIComponent(tabId)}/type`, { method: 'POST', body: JSON.stringify({ userId: this.userId, ref: inputRef, text: trackingNumber, clear: true, submit: true }) });
      const observed = await this.waitForTrackingResult(tabId, snapshot);
      return enrich(observed.result, 'Pagina pubblica DSV tramite Camofox.', observed.timeline);
    } finally {
      if (!DSV_SPEED_PROFILES[this.effectiveSpeedProfile].reuseTab || this.activeTabId !== tabId) await this.closeTab(tabId);
    }
  }
}
