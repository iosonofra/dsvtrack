import test from 'node:test';
import assert from 'node:assert/strict';
import { PrestaShopClient } from '../src/prestashop-client.js';
import { deleteShipment, syncShipmentPrestaShopShipping, getShipment, syncVerifiedShipments } from '../src/shipment-store.js';

class MockPrestaShopClient extends PrestaShopClient {
  constructor(data = {}) {
    super({ baseUrl: 'https://shop.example.com', apiKey: 'test_key' });
    this.mockData = data;
    this.sentXml = [];
  }

  async request(resource) {
    if (resource.startsWith('orders/101')) return { order: { id: '101', reference: 'REF101', id_carrier: '3' } };
    if (resource.includes('filter[reference]=[REF101]')) return { orders: [{ id: '101', reference: 'REF101', id_carrier: '3' }] };
    if (resource.includes('order_carriers?filter[id_order]=[101]')) {
      return {
        order_carriers: [{
          id: '55',
          id_order: '101',
          id_carrier: this.mockData.carrierId || '3',
          tracking_number: this.mockData.trackingNumber || '',
        }],
      };
    }
    if (resource === 'carriers?display=full') {
      return {
        carriers: [
          { id: '3', name: 'Corriere Standard' },
          { id: '7', name: 'DSV Express' },
        ],
      };
    }
    return {};
  }

  async sendXml(resource, method, xml, query) {
    this.sentXml.push({ resource, method, xml, query });
    return '<prestashop></prestashop>';
  }
}

test('getOrderLiveShippingInfo legge tracking e corriere live da PrestaShop', async () => {
  const client = new MockPrestaShopClient({ trackingNumber: 'ITMIL999', carrierId: '7' });
  const live = await client.getOrderLiveShippingInfo({ orderId: '101', orderReference: 'REF101' });

  assert.equal(live.status, 'ok');
  assert.equal(live.orderId, '101');
  assert.equal(live.trackingNumber, 'ITMIL999');
  assert.equal(live.trackingPresent, true);
  assert.equal(live.carrierId, '7');
  assert.equal(live.carrierName, 'DSV Express');
});

test('applyOrderCarrierOnly blocca la sovrascrittura di un tracking diverso se overwrite è false', async () => {
  const client = new MockPrestaShopClient({ trackingNumber: 'TRACKING_VECCHIO', carrierId: '3' });

  await assert.rejects(
    async () => {
      await client.applyOrderCarrierOnly({
        orderId: '101',
        trackingNumber: 'ITMIL_NUOVO',
        carrierId: '7',
        overwrite: false,
      });
    },
    /Un tracking diverso \(TRACKING_VECCHIO\) è già presente su PrestaShop\./,
  );
});

test('applyOrderCarrierOnly consente la sovrascrittura se overwrite è true', async () => {
  const client = new MockPrestaShopClient({ trackingNumber: 'TRACKING_VECCHIO', carrierId: '3' });

  const outcome = await client.applyOrderCarrierOnly({
    orderId: '101',
    trackingNumber: 'ITMIL_NUOVO',
    carrierId: '7',
    overwrite: true,
  });

  assert.equal(outcome.success, true);
  assert.equal(outcome.overwritten, true);
  assert.equal(outcome.trackingNumber, 'ITMIL_NUOVO');
  assert.equal(outcome.carrierId, '7');
  assert.equal(client.sentXml.length, 1);
  assert.match(client.sentXml[0].xml, /<tracking_number><!\[CDATA\[ITMIL_NUOVO\]\]><\/tracking_number>/);
  assert.match(client.sentXml[0].xml, /<id_carrier><!\[CDATA\[7\]\]><\/id_carrier>/);
});

test('syncShipmentPrestaShopShipping aggiorna il record locale e traccia l\'evento', async () => {
  const trackingNumber = 'TEST_SYNC_PRESTA_' + Date.now();
  await syncVerifiedShipments([{
    sourceRow: 1,
    orderReference: 'REF_SYNC',
    orderDate: '2026-09-12',
    trackingNumber,
    orderId: '9999',
    currentState: 'In preparazione',
    prestaStateId: '3',
    prestaStatus: 'Pronta',
    carrierId: '3',
  }]);

  const updated = await syncShipmentPrestaShopShipping(trackingNumber, {
    orderId: '9999',
    orderReference: 'REF_SYNC',
    carrierId: '7',
    carrierName: 'DSV Express',
    overwritten: false,
  });

  assert.equal(updated.prestaCarrierId, '7');
  assert.equal(updated.prestaCarrierName, 'DSV Express');
  assert.equal(updated.prestaTrackingSynced, true);

  const shipment = await getShipment(trackingNumber);
  const lastEvent = shipment.events.at(-1);
  assert.equal(lastEvent.type, 'prestashop');
  assert.equal(lastEvent.label, 'Tracking e corriere sincronizzati');
  assert.match(lastEvent.detail, /DSV Express/);

  await deleteShipment(trackingNumber);
});
