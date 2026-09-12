import test from 'node:test';
import assert from 'node:assert/strict';
import { getExistingShipmentsIndex } from '../src/shipment-store.js';

test('getExistingShipmentsIndex indicizza tracking e riferimenti ordine', async () => {
  const index = await getExistingShipmentsIndex();
  assert.ok(index.byTracking instanceof Map);
  assert.ok(index.byReference instanceof Map);
});

test('salto delle spedizioni già presenti nel file Excel', () => {
  const byTracking = new Map([['ITB0Y12345678', { trackingNumber: 'ITB0Y12345678', orderReference: 'ORD-001', currentState: 'In transito' }]]);
  const byReference = new Map([['ORD-002', { trackingNumber: 'ITB0Y87654321', orderReference: 'ORD-002', currentState: 'Consegnata' }]]);

  const rawRows = [
    { sourceRow: 2, trackingNumber: 'ITB0Y12345678', orderReference: 'ORD-001', validation: 'Pronta per la verifica' },
    { sourceRow: 3, trackingNumber: 'ITB0Y99999999', orderReference: 'ORD-002', validation: 'Pronta per la verifica' },
    { sourceRow: 4, trackingNumber: 'ITB0YNEWNEW01', orderReference: 'ORD-NEW', validation: 'Pronta per la verifica' },
  ];

  const processed = rawRows.map((row) => {
    if (row.validation !== 'Pronta per la verifica') return row;
    const existing = (row.trackingNumber && byTracking.get(row.trackingNumber))
      || (row.orderReference && byReference.get(row.orderReference));
    if (existing) {
      return {
        ...row,
        validation: 'Già importata (saltata)',
        alreadyImported: true,
        canApply: false,
        existingTracking: existing.trackingNumber,
      };
    }
    return row;
  });

  assert.equal(processed[0].alreadyImported, true);
  assert.equal(processed[0].validation, 'Già importata (saltata)');
  assert.equal(processed[1].alreadyImported, true);
  assert.equal(processed[1].validation, 'Già importata (saltata)');
  assert.equal(processed[2].alreadyImported, undefined);
  assert.equal(processed[2].validation, 'Pronta per la verifica');
});
