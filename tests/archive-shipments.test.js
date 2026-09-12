import test from 'node:test';
import assert from 'node:assert/strict';
import { archiveShipment, deleteShipment, getControlCenter, getShipment, syncDsvShipments, syncVerifiedShipments } from '../src/shipment-store.js';

test('archiviazione e ripristino spedizione con isolamento dalla vista principale', async () => {
  const testTracking = 'TESTARCHIVE999';

  // Popola la spedizione di test
  await syncVerifiedShipments([{
    trackingNumber: testTracking,
    orderReference: 'TEST-ARCHIVE-ORD',
    orderId: '99999',
    orderDate: '2026-09-12',
    currentState: 'In transito',
    verification: 'Pronta per aggiornamento',
    canApply: true,
  }]);

  // Assicura lo stato iniziale attivo per isolamento dei test
  await archiveShipment(testTracking, false);

  // Prima dell'archiviazione: deve comparire nella vista normale
  let activeView = await getControlCenter({ query: testTracking });
  assert.equal(activeView.records.some((r) => r.trackingNumber === testTracking), true);

  // Archivia la spedizione
  const archivedResult = await archiveShipment(testTracking, true);
  assert.equal(archivedResult.archived, true);

  const shipment = await getShipment(testTracking);
  assert.equal(shipment.archived, true);
  assert.ok(shipment.archivedAt);

  // Nella vista normale (default): la spedizione archiviata NON deve comparire
  activeView = await getControlCenter({ query: testTracking });
  assert.equal(activeView.records.some((r) => r.trackingNumber === testTracking), false);
  assert.ok(activeView.archivedCount >= 1);

  // Nella vista "Archiviate": deve comparire
  const archivedView = await getControlCenter({ query: testTracking, archived: true });
  assert.equal(archivedView.records.some((r) => r.trackingNumber === testTracking), true);

  // Anche tramite filtro dsvStatus = 'Archiviate': deve comparire
  const archivedFilterView = await getControlCenter({ query: testTracking, dsvStatus: 'Archiviate' });
  assert.equal(archivedFilterView.records.some((r) => r.trackingNumber === testTracking), true);

  // Esecuzione di una verifica forzata (syncDsvShipments): deve preservare archived: true
  await syncDsvShipments([{
    trackingNumber: testTracking,
    status: 'In consegna',
    detail: 'Aggiornamento forzato',
  }]);

  const afterForcedSync = await getShipment(testTracking);
  assert.equal(afterForcedSync.archived, true);
  assert.equal(afterForcedSync.dsvStatus, 'In consegna');

  // Ripristino della spedizione (disarchiviazione)
  const unarchivedResult = await archiveShipment(testTracking, false);
  assert.equal(unarchivedResult.archived, false);

  // Ora ricompare nella vista principale
  const restoredView = await getControlCenter({ query: testTracking });
  assert.equal(restoredView.records.some((r) => r.trackingNumber === testTracking), true);

  // Pulizia dati test
  await deleteShipment(testTracking);
});
