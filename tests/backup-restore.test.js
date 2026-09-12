import test from 'node:test';
import assert from 'node:assert/strict';
import { exportSettingsData, restoreSettingsData, normalizeDsvStateMappings } from '../src/settings-store.js';
import { exportShipmentsData, restoreShipmentsData } from '../src/shipment-store.js';

test('exportSettingsData formatta correttamente le impostazioni', () => {
  const sample = {
    baseUrl: 'https://shop.example.com',
    apiKey: 'TESTKEY123',
    dsvBeta: { enabled: true, camofoxUrl: 'http://127.0.0.1:9377' },
    dsvStateMappings: { 'Consegnata': { stateId: '5', stateName: 'Consegnato' } },
    defaultCarrierId: '12',
    defaultCarrierName: 'DSV Express',
  };

  const exported = exportSettingsData(sample);
  assert.equal(exported.baseUrl, 'https://shop.example.com');
  assert.equal(exported.apiKey, 'TESTKEY123');
  assert.equal(exported.dsvBeta.enabled, true);
  assert.equal(exported.dsvStateMappings['Consegnata'].stateId, '5');
  assert.equal(exported.defaultCarrierId, '12');
});

test('exportShipmentsData restituisce il conteggio e la mappa spedizioni', async () => {
  const exported = await exportShipmentsData();
  assert.ok(typeof exported.count === 'number');
  assert.ok(typeof exported.shipments === 'object');
  assert.ok(!Array.isArray(exported.shipments));
  assert.equal(exported.count, Object.keys(exported.shipments).length);
});

test('restoreShipmentsData rifiuta strutture non valide', async () => {
  await assert.rejects(() => restoreShipmentsData(null), /non validi/);
  await assert.rejects(() => restoreShipmentsData([1, 2, 3]), /non validi/);
  await assert.rejects(() => restoreShipmentsData('stringa'), /non validi/);
});

test('restoreSettingsData rifiuta strutture non valide', async () => {
  await assert.rejects(() => restoreSettingsData(null), /non validi/);
  await assert.rejects(() => restoreSettingsData([1, 2, 3]), /non validi/);
  await assert.rejects(() => restoreSettingsData('stringa'), /non validi/);
});

test('ciclo di export e restore preserva i dati intatti', async () => {
  // Salva stato originale
  const original = await exportShipmentsData();

  // Test restore con fixture di prova
  const testFixture = {
    ...original.shipments,
    'ITTEST00099999': {
      trackingNumber: 'ITTEST00099999',
      orderReference: 'TESTORD-999',
      dsvStatus: 'Consegnata',
      prestaStatus: 'OK',
    },
  };

  const res = await restoreShipmentsData(testFixture);
  assert.equal(res.restoredCount, Object.keys(testFixture).length);

  // Ripristina lo stato originale per non alterare i dati reali dell'utente
  const restoredBack = await restoreShipmentsData(original.shipments);
  assert.equal(restoredBack.restoredCount, original.count);
});
