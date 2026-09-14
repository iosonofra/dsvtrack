import { randomUUID } from 'node:crypto';

const DSV_HOSTS = new Set(['www.dsv.com', 'dsv.com']);
const REQUEST_TIMEOUT_MS = 20_000;
const TRACKING_POLL_TIMEOUT_MS = 18_000;
const TRACKING_POLL_INTERVAL_MS = 700;
const FAST_TRACKING_POLL_INTERVALS_MS = [250, 500, 800, 1200];
export const DSV_PARSER_VERSION = 4;
export const DEFAULT_DSV_TRACKING_URL = 'https://www.dsv.com/mydsv/tracking-public/?refNumber=TRACKINGDAINSERIRE&language_region=it-IT_IT';

export const DSV_SPEED_PROFILES = Object.freeze({
  safe: Object.freeze({ id: 'safe', reuseTab: false, initialDelayMs: 500, manualDelayMs: [2000, 3200], cronDelayMs: [4000, 6000] }),
  fast: Object.freeze({ id: 'fast', reuseTab: true, initialDelayMs: 150, manualDelayMs: [1200, 2000], cronDelayMs: [1800, 3000] }),
});

export function normalizeDsvSpeedProfile(value) {
  return value === 'fast' ? 'fast' : 'safe';
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
  if (statusesFound.size === 1) return statusResult([...statusesFound][0], 'Unico stato riconoscibile nella pagina pubblica DSV.', { evidence: 'unique-text', confidence: .72, reasonCode: 'STATUS_INFERRED', rawStatus: [...statusesFound][0] });
  return statusResult('Da verificare manualmente', text ? 'La pagina non espone ancora uno stato corrente riconoscibile.' : 'Nessun contenuto leggibile restituito dalla pagina.', { evidence: 'none', confidence: 0, reasonCode: text ? 'STATUS_NOT_READY' : 'EMPTY_PAGE' });
}

export function normalizeDsvTimeline(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, 60).map((row) => {
    let date = cleanSnapshot(row?.date).slice(0, 80);
    let location = cleanSnapshot(row?.location).slice(0, 160);
    if (!parseDsvEventDate(date).local && parseDsvEventDate(location).local) [date, location] = [location, date];
    return {
      event: cleanSnapshot(row?.event).slice(0, 160),
      country: cleanSnapshot(row?.country).slice(0, 40),
      date,
      location,
      reason: cleanSnapshot(row?.reason).slice(0, 300),
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

function timelineRowStatus(row) {
  const value = `${row.event} ${row.reason}`;
  if (/\bnon consegnat|non caricat|rifiutat|eccezion|exception|failed delivery/i.test(value)) return 'Eccezione DSV';
  if (/terminal dal mittente|sender terminal/i.test(value)) return 'Prenotata';
  const canonical = canonicalDsvStatus(row.event);
  if (canonical) return canonical;
  if (/fuori per la consegna|out for delivery/i.test(value)) return 'In consegna';
  if (/\b(?:partit|arrivat|departed|arrived)\b/i.test(value)) return 'In transito';
  return null;
}

export function findDsvStatusEvent(status, timeline) {
  const row = [...normalizeDsvTimeline(timeline)].reverse().find((item) => timelineRowStatus(item) === status);
  if (!row) return null;
  const parsedDate = parseDsvEventDate(row.date);
  return { ...row, statusDateRaw: parsedDate.raw, statusAt: parsedDate.local, statusDatePrecision: parsedDate.precision };
}

function statusFromTimeline(timeline) {
  for (const row of [...normalizeDsvTimeline(timeline)].reverse()) {
    const status = timelineRowStatus(row);
    if (!status) continue;
    const eventDate = parseDsvEventDate(row.date);
    const options = { evidence: 'timeline', confidence: status === 'In transito' ? .76 : status === 'Prenotata' ? .72 : .82, reasonCode: status === 'Eccezione DSV' ? 'EXCEPTION_INFERRED' : 'STATUS_INFERRED', rawStatus: row.event, statusDateRaw: eventDate.raw, statusAt: eventDate.local, statusDatePrecision: eventDate.precision };
    return statusResult(status, status === 'Eccezione DSV' ? 'Stato inferito dall’ultimo evento anomalo dello storico DSV.' : 'Stato inferito dall’ultimo evento utile dello storico DSV.', options);
  }
  return null;
}

export function parseDsvDomEvidence(evidence = {}) {
  for (const heading of evidence.headings || []) {
    const result = parseDsvStatusSnapshot(heading);
    if (result.status !== 'Da verificare manualmente') return { ...result, evidence: 'dom-headline', confidence: Math.max(result.confidence, .98) };
  }
  for (const activeText of evidence.activeTexts || []) {
    const statuses = DSV_STATUS_RULES.filter((rule) => rule.expression.test(String(activeText))).map((rule) => rule.status);
    if (statuses.length === 1) return statusResult(statuses[0], 'Stato letto dall’elemento attivo della pagina DSV.', { evidence: 'dom-active-step', confidence: .97, reasonCode: 'STATUS_CONFIRMED', rawStatus: activeText });
  }
  return statusFromTimeline(evidence.timeline);
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
    if (this.requestedSpeedProfile === 'fast') {
      this.effectiveSpeedProfile = 'safe';
      this.fallbackReason = reason;
    }
    await this.closeTab(staleTabId);
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
    if (this.effectiveSpeedProfile === 'fast' && (accessGuard || this.unstableResultCount >= 2)) {
      this.effectiveSpeedProfile = 'safe';
      this.fallbackReason = accessGuard
        ? 'Modalità affidabile attivata dopo un blocco o una verifica richiesta da DSV.'
        : 'Modalità affidabile attivata dopo due risultati consecutivi non stabili.';
    }
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
      const makeRow = (cells) => ({ event: clean(cells[0]), country: clean(cells[1]), date: clean(cells[2]), location: clean(cells[3]), reason: clean(cells[4]) });
      const documents = [document];
      for (const frame of document.querySelectorAll('iframe')) { try { if (frame.contentDocument) documents.push(frame.contentDocument); } catch {} }
      const headings = documents.flatMap((doc) => Array.from(doc.querySelectorAll('h1,h2,h3,[role="heading"]')).map((node) => clean(node.innerText || node.textContent))).filter(Boolean).slice(0, 30);
      const activeSelector = '[aria-current="true"],[aria-current="step"],[aria-selected="true"],.active,.selected,.current,[class*="active"],[class*="selected"],[class*="current"]';
      const activeTexts = documents.flatMap((doc) => Array.from(doc.querySelectorAll(activeSelector)).map((node) => clean(node.innerText || node.textContent)).filter((value) => value.length <= 120 && /prenot|transit|distribu|consegn|deliver|booked/i.test(value))).slice(0, 20);
      const timeline = [];
      for (const doc of documents) {
        const tables = Array.from(doc.querySelectorAll('table'));
        const table = tables.find((item) => /evento|event/i.test(item.innerText) && /data|date/i.test(item.innerText) && /localit|location/i.test(item.innerText));
        if (table) timeline.push(...Array.from(table.querySelectorAll('tbody tr')).map((row) => makeRow(Array.from(row.querySelectorAll('td')).map((cell) => cell.innerText))));
        const rows = Array.from(doc.querySelectorAll('[role="row"]')).map((row) => Array.from(row.querySelectorAll('[role="cell"], [role="gridcell"]')).map((cell) => cell.innerText));
        timeline.push(...rows.filter((cells) => cells.length >= 3 && !/evento|event/i.test(cells[0] || '')).map(makeRow));
      }
      return { headings, activeTexts, timeline: timeline.filter((row) => row.event || row.date), frameCount: documents.length - 1 };
    })()`;
    const response = await this.request(`/tabs/${encodeURIComponent(tabId)}/evaluate`, { method: 'POST', body: JSON.stringify({ userId: this.userId, expression }) });
    const result = response.result || {};
    return { headings: Array.isArray(result.headings) ? result.headings.slice(0, 30) : [], activeTexts: Array.isArray(result.activeTexts) ? result.activeTexts.slice(0, 20) : [], timeline: normalizeDsvTimeline(result.timeline), frameCount: Number(result.frameCount) || 0 };
  }

  async waitForTrackingResult(tabId, snapshot) {
    const deadline = Date.now() + TRACKING_POLL_TIMEOUT_MS;
    const fastMode = this.effectiveSpeedProfile === 'fast';
    let best = null;
    let stableStatus = '';
    let stableReads = 0;
    let pollIndex = 0;
    let lastEvidence = { headings: [], activeTexts: [], timeline: [], frameCount: 0 };
    do {
      const domEvidence = await this.extractDomEvidence(tabId).catch(() => lastEvidence);
      lastEvidence = domEvidence;
      const domResult = parseDsvDomEvidence(domEvidence);
      if (fastMode && domResult?.status !== 'Da verificare manualmente' && domResult?.confidence >= .9) {
        return { result: domResult, timeline: domEvidence.timeline };
      }
      const page = await snapshot();
      const candidates = [parseDsvStatusSnapshot(page), domResult].filter(Boolean).sort((a, b) => b.confidence - a.confidence);
      const current = candidates[0];
      if (!best || current.confidence > best.confidence) best = current;
      if (current.status !== 'Da verificare manualmente') {
        if (stableStatus === current.status) stableReads += 1;
        else { stableStatus = current.status; stableReads = 1; }
        if (current.confidence >= .9 || stableReads >= 2) return { result: current, timeline: domEvidence.timeline };
      }
      if (Date.now() < deadline) {
        const delayMs = fastMode
          ? FAST_TRACKING_POLL_INTERVALS_MS[Math.min(pollIndex, FAST_TRACKING_POLL_INTERVALS_MS.length - 1)]
          : TRACKING_POLL_INTERVAL_MS;
        pollIndex += 1;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    } while (Date.now() < deadline);
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
      const output = { ...statusResult, statusDateRaw: statusEvent?.statusDateRaw || statusResult.statusDateRaw || '', statusAt: statusEvent?.statusAt || statusResult.statusAt || '', statusDatePrecision: statusEvent?.statusDatePrecision || statusResult.statusDatePrecision || '', source, trackingUrl: officialTrackingUrl, timeline: normalizedTimeline };
      this.noteTrackingResult(output);
      return output;
    };
    try {
      await new Promise((resolve) => setTimeout(resolve, DSV_SPEED_PROFILES[this.effectiveSpeedProfile].initialDelayMs));
      const directUrl = this.settings.trackingUrl.includes('TRACKINGDAINSERIRE');
      const shouldInspectEntryPage = this.effectiveSpeedProfile !== 'fast' || !directUrl || !this.cookieConsentChecked;
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
