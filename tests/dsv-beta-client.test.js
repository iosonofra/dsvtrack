import test from 'node:test';
import assert from 'node:assert/strict';
import { DSV_PARSER_VERSION, DsvBetaClient, findDsvStatusEvent, normalizeDsvTimeline, parseDsvDomEvidence, parseDsvEventDate, parseDsvStatusSnapshot } from '../src/dsv-beta-client.js';
import { buildDsvStatusCounts, matchesOperationalStatus, normalizeStoredDsvStatus } from '../src/shipment-store.js';
import { normalizeDsvStateMappings } from '../src/settings-store.js';

const states = [
  ['La tua spedizione è prenotata!', 'Prenotata'],
  ['La tua spedizione è in transito!', 'In transito'],
  ['La tua spedizione è presso il Centro di distribuzione!', 'Centro di distribuzione'],
  ['La tua spedizione è in consegna!', 'In consegna'],
  ['La tua spedizione è consegnata!', 'Consegnata'],
];

for (const [headline, expected] of states) {
  test(`riconosce lo stato DSV ${expected}`, () => {
    const snapshot = `- heading "${headline}"\n- text "Prenotata"\n- text "In transito"\n- text "presso il Centro di distribuzione"\n- text "In consegna"\n- text "Consegnata"`;
    assert.equal(parseDsvStatusSnapshot(snapshot).status, expected);
  });
}

test('usa lo step marcato come corrente quando manca il titolo', () => {
  const snapshot = '- text "Prenotata"\n- text "In transito" [current]\n- text "In consegna"';
  assert.equal(parseDsvStatusSnapshot(snapshot).status, 'In transito');
});

test('non sceglie il primo stato quando la timeline è ambigua', () => {
  const snapshot = '- text "Prenotata"\n- text "In transito"\n- text "Consegnata"';
  assert.equal(parseDsvStatusSnapshot(snapshot).status, 'Da verificare manualmente');
});

test('normalizza gli eventi dello storico DSV', () => {
  assert.deepEqual(normalizeDsvTimeline([{ event: ' Consegnato ', country: 'FR', date: '10/09/2026 11:45', location: 'Ciotat la', reason: '' }]), [{ event: 'Consegnato', country: 'FR', date: '10/09/2026 11:45', location: 'Ciotat la', reason: '' }]);
});

test('corregge data e località quando la tabella DSV le espone in ordine inverso', () => {
  assert.deepEqual(normalizeDsvTimeline([{ event: 'Consegnato', country: 'FR', date: 'Plan d orgon', location: '07/09/2026 14:36', reason: '' }]), [{ event: 'Consegnato', country: 'FR', date: '07/09/2026 14:36', location: 'Plan d orgon', reason: '' }]);
});

test('normalizza data e ora italiane senza inventare il fuso orario', () => {
  assert.deepEqual(parseDsvEventDate('3/09/2026 8:57'), { raw: '3/09/2026 8:57', local: '2026-09-03T08:57:00', precision: 'datetime' });
  assert.deepEqual(parseDsvEventDate('10/09/2026'), { raw: '10/09/2026', local: '2026-09-10', precision: 'date' });
});

test('associa allo stato corrente la data del relativo evento DSV', () => {
  const event = findDsvStatusEvent('Consegnata', [
    { event: 'Partito', date: '09/09/2026 14:08' },
    { event: 'Consegnato', date: '10/09/2026 11:45', location: 'Ciotat la' },
    { event: 'ePod disponibile', date: '10/09/2026 11:49' },
  ]);
  assert.equal(event.statusAt, '2026-09-10T11:45:00');
  assert.equal(event.statusDateRaw, '10/09/2026 11:45');
});

test('usa lo stato attivo letto direttamente dal DOM', () => {
  const result = parseDsvDomEvidence({ headings: [], activeTexts: ['In consegna'], timeline: [] });
  assert.equal(result.status, 'In consegna');
  assert.equal(result.evidence, 'dom-active-step');
  assert.ok(result.confidence >= .9);
  assert.equal(result.parserVersion, DSV_PARSER_VERSION);
});

test('usa l’ultimo evento utile della timeline senza confondere il terminal del mittente con una consegna finale', () => {
  const result = parseDsvDomEvidence({ timeline: [{ event: 'Prenotato' }, { event: 'Consegnato al Terminal dal Mittente' }] });
  assert.equal(result.status, 'Prenotata');
  assert.equal(result.evidence, 'timeline');
});

test('mappa un evento anomalo come eccezione DSV', () => {
  const result = parseDsvDomEvidence({ timeline: [{ event: 'Non consegnato', reason: 'Rifiutato dal destinatario' }] });
  assert.equal(result.status, 'Eccezione DSV');
  assert.equal(result.reasonCode, 'EXCEPTION_INFERRED');
});

test('normalizza gli stati storici prima di filtrarli', () => {
  assert.equal(normalizeStoredDsvStatus('Consegnato'), 'Consegnata');
  assert.equal(normalizeStoredDsvStatus('presso il centro di distribuzione'), 'Centro di distribuzione');
  assert.equal(normalizeStoredDsvStatus('in consegna'), 'In consegna');
});

test('il filtro aggregato Da verificare include attese e verifiche incomplete', () => {
  assert.equal(matchesOperationalStatus('In attesa di verifica DSV', 'Da verificare'), true);
  assert.equal(matchesOperationalStatus('Verifica incompleta', 'Da verificare'), true);
  assert.equal(matchesOperationalStatus('Consegnata', 'Da verificare'), false);
});

test('la barra DSV include automaticamente anche stati non mappati', () => {
  assert.deepEqual(buildDsvStatusCounts([{ dsvStatus: 'Consegnato' }, { dsvStatus: '' }, { dsvStatus: 'Fermo dogana' }, { dsvStatus: 'Fermo dogana' }]), { Consegnata: 1, 'Non verificato': 1, 'Fermo dogana': 2 });
});

test('salva solo mappature DSV e PrestaShop valide', () => {
  assert.deepEqual(normalizeDsvStateMappings({
    Consegnata: { stateId: 5, stateName: 'Consegnato' },
    'Fermo dogana': { stateId: '12', stateName: 'In attesa' },
    Invalida: { stateId: 'abc', stateName: 'Ignora' },
  }), {
    Consegnata: { stateId: '5', stateName: 'Consegnato' },
    'Fermo dogana': { stateId: '12', stateName: 'In attesa' },
  });
});

test('DsvBetaClient riutilizza la sessione condivisa e la resetta su richiesta', () => {
  const client = new DsvBetaClient({ enabled: true });
  const initialKey = client.activeSessionKey;
  assert.ok(initialKey);
  assert.equal(client.activeSessionKey, initialKey);
  client.resetSession();
  assert.notEqual(client.activeSessionKey, initialKey);
  assert.ok(client.activeSessionKey.startsWith('dsv-session-'));
});

