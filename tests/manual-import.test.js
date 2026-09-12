import test from 'node:test';
import assert from 'node:assert/strict';
import { getExistingShipmentsIndex } from '../src/shipment-store.js';

test('validazione inserimento manuale riconosce tracking o riferimento mancanti', () => {
  const validateInput = (tracking, reference) => {
    const trackingNumber = String(tracking || '').trim();
    const orderReference = String(reference || '').trim();
    if (!trackingNumber && !orderReference) return 'Campi mancanti';
    if (!trackingNumber) return 'Numero tracking mancante';
    if (!orderReference) return 'Riferimento ordine mancante';
    return null;
  };

  assert.equal(validateInput('', ''), 'Campi mancanti');
  assert.equal(validateInput('', 'ORD-123'), 'Numero tracking mancante');
  assert.equal(validateInput('TRK-123', ''), 'Riferimento ordine mancante');
  assert.equal(validateInput('TRK-123', 'ORD-123'), null);
});

test('inserimento manuale salta record già presenti nell’indice', async () => {
  const byTracking = new Map([
    ['ITMIL019430668', { trackingNumber: 'ITMIL019430668', orderReference: 'HLGRURSNX', currentState: 'Consegnato' }]
  ]);
  const byReference = new Map([
    ['REF-EXISTING', { trackingNumber: 'TRK-999', orderReference: 'REF-EXISTING', currentState: 'Spedito' }]
  ]);

  const processManualRow = (trackingNumber, orderReference, sourceRow = 1) => {
    const existing = byTracking.get(trackingNumber) || byReference.get(orderReference);
    if (existing) {
      return {
        sourceRow,
        trackingNumber,
        orderReference,
        validation: 'Già importata (saltata)',
        alreadyImported: true,
        canApply: false,
        existingTracking: existing.trackingNumber,
        currentState: existing.currentState || '—',
        dsvStatus: existing.dsvStatus || '—',
      };
    }
    return {
      sourceRow,
      trackingNumber,
      orderReference,
      validation: 'Pronta per la verifica',
      alreadyImported: false,
      canApply: true,
      currentState: '—',
      dsvStatus: '—',
    };
  };

  // Tracking già presente
  const row1 = processManualRow('ITMIL019430668', 'OTHER-REF', 1);
  assert.equal(row1.alreadyImported, true);
  assert.equal(row1.validation, 'Già importata (saltata)');
  assert.equal(row1.existingTracking, 'ITMIL019430668');
  assert.equal(row1.canApply, false);

  // Riferimento ordine già presente con tracking diverso
  const row2 = processManualRow('TRK-BRAND-NEW', 'REF-EXISTING', 2);
  assert.equal(row2.alreadyImported, true);
  assert.equal(row2.validation, 'Già importata (saltata)');
  assert.equal(row2.existingTracking, 'TRK-999');
  assert.equal(row2.canApply, false);

  // Spedizione nuova
  const row3 = processManualRow('TRK-BRAND-NEW', 'REF-BRAND-NEW', 3);
  assert.equal(row3.alreadyImported, false);
  assert.equal(row3.validation, 'Pronta per la verifica');
  assert.equal(row3.canApply, true);
});
