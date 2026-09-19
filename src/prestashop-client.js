function trimSlash(value) {
  return value.replace(/\/$/, '');
}

const REQUEST_INTERVAL_MS = 800;
const WRITE_CONFIRMATION_ATTEMPTS = 4;
const WRITE_CONFIRMATION_DELAY_MS = 650;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

class RequestGate {
  constructor(intervalMs) {
    this.intervalMs = intervalMs;
    this.nextAvailableAt = 0;
    this.chain = Promise.resolve();
  }

  run(work) {
    const scheduled = this.chain.then(async () => {
      const waitMs = Math.max(0, this.nextAvailableAt - Date.now());
      if (waitMs) await delay(waitMs);
      this.nextAvailableAt = Date.now() + this.intervalMs;
      return work();
    });
    this.chain = scheduled.catch(() => {});
    return scheduled;
  }
}

const requestGate = new RequestGate(REQUEST_INTERVAL_MS);
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class PrestaShopClient {
  constructor({ baseUrl, apiKey }) {
    this.baseUrl = trimSlash(baseUrl);
    this.apiKey = apiKey;
  }

  async request(resource, options = {}) {
    const url = new URL(`${this.baseUrl}/api/${resource}`);
    url.searchParams.set('output_format', 'JSON');
    const authorization = `Basic ${Buffer.from(`${this.apiKey}:`).toString('base64')}`;
    const response = await this.fetchWithRetry(url, {
      ...options, headers: { Authorization: authorization, Accept: 'application/json', ...options.headers },
    });
    if (!response.ok) throw new Error(`PrestaShop ha risposto ${response.status}: ${await response.text()}`);
    return response.json();
  }

  async fetchWithRetry(url, options) {
    const method = String(options?.method || 'GET').toUpperCase();
    const maxAttempts = RETRYABLE_METHODS.has(method) ? 3 : 1;
    let lastError;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const response = await requestGate.run(() => fetch(url, options));
        if (!RETRYABLE_STATUSES.has(response.status) || attempt === maxAttempts - 1) return response;
        lastError = new Error(`PrestaShop ha risposto ${response.status}`);
      } catch (error) {
        lastError = error;
        if (attempt === maxAttempts - 1) throw error;
      }
      await delay(1000 * (attempt + 1));
    }
    throw lastError;
  }

  async requestStatus(resource, options = {}) {
    const url = new URL(`${this.baseUrl}/api/${resource}`);
    const authorization = `Basic ${Buffer.from(`${this.apiKey}:`).toString('base64')}`;
    try {
      const response = await this.fetchWithRetry(url, {
        ...options,
        headers: { Authorization: authorization, ...options.headers },
      });
      return { status: response.status, body: await response.text() };
    } catch (error) {
      throw new Error(`Impossibile raggiungere ${url.hostname}: ${error.cause?.message ?? error.message}`);
    }
  }

  async testConnection() {
    const reads = [
      ['orders', 'Lettura ordini'],
      ['order_states', 'Lettura stati ordine'],
      ['carriers', 'Lettura corrieri'],
      ['order_carriers', 'Lettura spedizioni'],
    ];
    const results = [];
    for (const [resource, label] of reads) {
      const check = await this.requestStatus(`${resource}?limit=1&display=[id]`);
      results.push(permissionResult(label, 'GET', check.status));
    }

    // Both probes address an impossible/newly-invalid payload: no order or shipment
    // can be changed. An authorization failure is 401/403; any validation/not-found
    // answer proves that the key reached the write handler.
    const invalidXml = '<?xml version="1.0" encoding="UTF-8"?><prestashop><order_history></order_history></prestashop>';
    const history = await this.requestStatus('order_histories', {
      method: 'POST', headers: { 'Content-Type': 'application/xml' }, body: invalidXml,
    });
    results.push(permissionResult('Cambio stato ordine', 'POST', history.status, true));

    const shipment = await this.requestStatus('order_carriers/0', {
      method: 'PUT', headers: { 'Content-Type': 'application/xml' }, body: invalidXml,
    });
    results.push(permissionResult('Aggiornamento tracking e corriere', 'PUT', shipment.status, true));
    return results;
  }

  async sendXml(resource, method, xml, query = {}) {
    const url = new URL(`${this.baseUrl}/api/${resource}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const authorization = `Basic ${Buffer.from(`${this.apiKey}:`).toString('base64')}`;
    const response = await this.fetchWithRetry(url, {
      method,
      headers: { Authorization: authorization, 'Content-Type': 'application/xml', Accept: 'application/xml' },
      body: xml,
    });
    if (!response.ok) throw new Error(`PrestaShop ha risposto ${response.status}: ${await response.text()}`);
    return response.text();
  }

  async listOrderStates() {
    const payload = await this.request('order_states?display=full');
    return (payload.order_states ?? []).map((state) => ({
      id: String(state.id),
      name: Array.isArray(state.name) ? state.name[0]?.value : state.name,
      color: state.color,
    }));
  }

  async listCarriers() {
    const payload = await this.request('carriers?display=full');
    return (payload.carriers ?? [])
      .filter((carrier) => String(carrier.deleted ?? '0') !== '1')
      .map((carrier) => ({ id: String(carrier.id), name: carrier.name }));
  }

  async findOrdersByReference(reference) {
    const payload = await this.request(`orders?filter[reference]=[${reference}]&display=full`);
    return payload.orders ?? [];
  }

  async findOrdersByReferences(references) {
    if (!references.length) return [];
    const payload = await this.request(`orders?filter[reference]=[${references.join('|')}]&display=full`);
    return payload.orders ?? [];
  }

  async findOrderCarriers(orderId) {
    const payload = await this.request(`order_carriers?filter[id_order]=[${orderId}]&display=full`);
    return payload.order_carriers ?? [];
  }

  async findOrderCarriersByOrderIds(orderIds) {
    if (!orderIds.length) return [];
    const payload = await this.request(`order_carriers?filter[id_order]=[${orderIds.join('|')}]&display=full`);
    return payload.order_carriers ?? [];
  }

  async inspectOrdersByReferences(references, stateNames = new Map()) {
    const orders = await this.findOrdersByReferences(references);
    const ordersByReference = groupBy(orders, (order) => String(order.reference));
    const shipments = await this.findOrderCarriersByOrderIds(orders.map((order) => String(order.id)));
    const shipmentsByOrderId = groupBy(shipments, (shipment) => String(shipment.id_order));

    return references.map((reference) => {
      const matchingOrders = ordersByReference.get(reference) ?? [];
      if (matchingOrders.length !== 1) {
        return { reference, status: matchingOrders.length ? 'Riferimento ambiguo su PrestaShop' : 'Ordine non trovato su PrestaShop' };
      }
      const order = matchingOrders[0];
      const orderShipments = shipmentsByOrderId.get(String(order.id)) ?? [];
      if (orderShipments.length !== 1) {
        return orderDetails({ reference, status: orderShipments.length ? 'Ordine con più spedizioni' : 'Nessuna spedizione associata', order }, stateNames);
      }
      const existingTracking = String(orderShipments[0].tracking_number ?? '').trim();
      if (existingTracking) return orderDetails({ reference, status: 'Tracking già presente', order, existingTracking }, stateNames);
      return orderDetails({ reference, status: 'Pronta per aggiornamento', order }, stateNames);
    });
  }

  async inspectOrderByReference(reference) {
    const orders = await this.findOrdersByReference(reference);
    if (orders.length !== 1) {
      return { status: orders.length ? 'Riferimento ambiguo su PrestaShop' : 'Ordine non trovato su PrestaShop' };
    }
    const shipments = await this.findOrderCarriers(orders[0].id);
    if (shipments.length !== 1) {
      return { status: shipments.length ? 'Ordine con più spedizioni' : 'Nessuna spedizione associata', orderId: orders[0].id };
    }
    const existingTracking = String(shipments[0].tracking_number ?? '').trim();
    if (existingTracking) {
      return { status: 'Tracking già presente', orderId: orders[0].id, existingTracking };
    }
    return { status: 'Pronta per aggiornamento', orderId: orders[0].id };
  }

  async applyOrderUpdate({ orderId, trackingNumber, carrierId, stateId, updateTracking, updateState }) {
    let trackingSkipped = false;
    let carrierUpdateOutcome = null;
    if (updateTracking) {
      const carriers = await this.findOrderCarriers(orderId);
      if (carriers.length !== 1) throw new Error(carriers.length ? 'L’ordine ha più spedizioni: aggiornamento manuale richiesto.' : 'Nessuna spedizione associata all’ordine.');
      const shipment = carriers[0];
      const existingTracking = String(shipment.tracking_number ?? '').trim();
      const requestedTracking = String(trackingNumber ?? '').trim();
      const carrierAlreadyAligned = String(shipment.id_carrier ?? '').trim() === String(carrierId ?? '').trim();
      if (existingTracking && existingTracking !== requestedTracking) {
        if (!updateState) throw new Error(`Tracking già presente (${shipment.tracking_number}): riga saltata.`);
        trackingSkipped = true;
      } else if (existingTracking && carrierAlreadyAligned) {
        trackingSkipped = true;
      } else {
        // Mantiene importazione singola e massiva sullo stesso percorso di
        // aggiornamento. Se il tracking esiste già ma il corriere è diverso,
        // riallinea comunque il corriere invece di saltare la riga.
        carrierUpdateOutcome = await this.applyOrderCarrierOnly({
          orderId,
          trackingNumber,
          carrierId,
          overwrite: false,
          shipment,
        });
      }
    }
    if (updateState) await this.sendXml('order_histories', 'POST', resourceXml('order_history', { id_order: orderId, id_order_state: stateId }), { sendemail: '0' });
    return {
      trackingSkipped,
      recoveredAfterError: Boolean(carrierUpdateOutcome?.recoveredAfterError),
      carrierUpdateOutcome,
    };
  }

  async getOrderCurrentState(orderId) {
    const payload = await this.request(`orders/${encodeURIComponent(orderId)}`);
    const stateId = String(payload?.order?.current_state ?? '').trim();
    if (!stateId) throw new Error(`PrestaShop non ha restituito lo stato corrente dell’ordine ${orderId}.`);
    return stateId;
  }

  async applyOrderStateSafely({ orderId, stateId }) {
    const targetStateId = String(stateId || '').trim();
    if (!targetStateId) throw new Error('Stato PrestaShop di destinazione mancante.');

    const currentStateId = await this.getOrderCurrentState(orderId);
    if (currentStateId === targetStateId) return { alreadyApplied: true, recoveredAfterError: false };

    try {
      await this.applyOrderUpdate({ orderId, stateId: targetStateId, updateState: true, updateTracking: false });
      return { alreadyApplied: false, recoveredAfterError: false };
    } catch (error) {
      try {
        const stateAfterError = await this.getOrderCurrentState(orderId);
        if (stateAfterError === targetStateId) return { alreadyApplied: false, recoveredAfterError: true };
      } catch {
        // Conserva l'errore originale: una seconda POST automatica potrebbe duplicare lo storico.
      }
      throw error;
    }
  }

  async getOrderLiveShippingInfo({ orderId, orderReference }) {
    let order = null;
    if (orderId) {
      try {
        const payload = await this.request(`orders/${encodeURIComponent(orderId)}`);
        order = payload?.order || null;
      } catch {
        // Fallback to orderReference search
      }
    }
    if (!order && orderReference) {
      const orders = await this.findOrdersByReference(orderReference);
      if (orders.length === 1) {
        order = orders[0];
      } else if (orders.length > 1) {
        return {
          status: 'error',
          error: 'Riferimento ordine ambiguo su PrestaShop.',
          orderReference,
        };
      }
    }
    if (!order) {
      return {
        status: 'not_found',
        error: 'Ordine non trovato su PrestaShop.',
        orderReference,
        orderId,
      };
    }

    const resolvedOrderId = String(order.id);
    const shipments = await this.findOrderCarriers(resolvedOrderId);
    if (!shipments.length) {
      return {
        status: 'no_shipments',
        error: 'Nessuna spedizione (order_carrier) associata all’ordine su PrestaShop.',
        orderId: resolvedOrderId,
        orderReference: String(order.reference || orderReference || ''),
      };
    }
    if (shipments.length > 1) {
      return {
        status: 'multiple_shipments',
        error: 'L’ordine ha più spedizioni registrate su PrestaShop.',
        orderId: resolvedOrderId,
        orderReference: String(order.reference || orderReference || ''),
        shipmentsCount: shipments.length,
      };
    }

    const shipment = shipments[0];
    const carriers = await this.listCarriers().catch(() => []);
    const carrierId = String(shipment.id_carrier ?? order.id_carrier ?? '').trim();
    const carrierObj = carriers.find((c) => String(c.id) === carrierId);
    const carrierName = carrierObj ? carrierObj.name : (carrierId ? `Corriere #${carrierId}` : 'Non assegnato');
    const trackingNumber = String(shipment.tracking_number ?? '').trim();

    return {
      status: 'ok',
      orderId: resolvedOrderId,
      orderReference: String(order.reference || orderReference || ''),
      orderDate: String(order.date_add || ''),
      currentStateId: String(order.current_state || ''),
      orderCarrierId: String(shipment.id),
      trackingNumber,
      trackingPresent: Boolean(trackingNumber),
      carrierId,
      carrierName,
    };
  }

  async applyOrderCarrierOnly({ orderId, trackingNumber, carrierId, overwrite = false, shipment: suppliedShipment = null }) {
    const carriers = suppliedShipment ? [suppliedShipment] : await this.findOrderCarriers(orderId);
    if (carriers.length !== 1) {
      throw new Error(carriers.length ? 'L’ordine ha più spedizioni: aggiornamento manuale richiesto.' : 'Nessuna spedizione associata all’ordine.');
    }
    const shipment = carriers[0];
    const existingTracking = String(shipment.tracking_number ?? '').trim();
    if (existingTracking && existingTracking !== trackingNumber && !overwrite) {
      throw new Error(`Un tracking diverso (${existingTracking}) è già presente su PrestaShop.`);
    }

    const finalCarrierId = carrierId ? String(carrierId).trim() : String(shipment.id_carrier ?? '').trim();
    if (!/^\d+$/.test(finalCarrierId) || Number(finalCarrierId) < 1) {
      throw new Error(`ID corriere PrestaShop non valido (${finalCarrierId || 'vuoto'}). Ricarica il catalogo corrieri.`);
    }
    const finalTrackingNumber = String(trackingNumber || existingTracking).trim();
    let recoveredAfterError = false;
    let fallbackUsed = false;
    try {
      const outcome = await this.writeOrderCarrierAndConfirm({
        orderId,
        shipment,
        carrierId: finalCarrierId,
        trackingNumber: finalTrackingNumber,
      });
      recoveredAfterError = outcome.recoveredAfterError;
    } catch (error) {
      if (!isOrderCarrierIdValidationError(error) || String(shipment.id_carrier ?? '').trim() === finalCarrierId) throw error;

      // Alcuni override PrestaShop rifiutano l'aggiornamento combinato verso un
      // corriere disattivato, mentre accettano le stesse modifiche separate.
      // Il fallback usa solo PUT idempotenti: prima salva il tracking con il
      // corriere storico, poi rilegge e applica il corriere richiesto.
      fallbackUsed = true;
      let [freshShipment] = await this.findOrderCarriers(orderId);
      if (!freshShipment) throw error;
      if (String(freshShipment.tracking_number ?? '').trim() !== finalTrackingNumber) {
        await this.writeOrderCarrierAndConfirm({
          orderId,
          shipment: freshShipment,
          carrierId: String(freshShipment.id_carrier ?? '').trim(),
          trackingNumber: finalTrackingNumber,
        });
      }
      [freshShipment] = await this.findOrderCarriers(orderId);
      if (!freshShipment) throw error;
      const carrierOutcome = await this.writeOrderCarrierAndConfirm({
        orderId,
        shipment: freshShipment,
        carrierId: finalCarrierId,
        trackingNumber: finalTrackingNumber,
      });
      recoveredAfterError = carrierOutcome.recoveredAfterError;
    }
    return {
      success: true,
      orderCarrierId: shipment.id,
      trackingNumber: finalTrackingNumber,
      carrierId: finalCarrierId,
      overwritten: Boolean(existingTracking && existingTracking !== trackingNumber),
      recoveredAfterError,
      fallbackUsed,
    };
  }

  async writeOrderCarrierAndConfirm({ orderId, shipment, carrierId, trackingNumber }) {
    const fields = orderCarrierFields({ orderId, shipment, carrierId, trackingNumber });
    try {
      await this.sendXml(`order_carriers/${shipment.id}`, 'PUT', resourceXml('order_carrier', fields), { sendemail: '0' });
      return { recoveredAfterError: false };
    } catch (error) {
      // PrestaShop può salvare la risorsa e rispondere comunque 400. Non
      // ripetiamo qui la PUT: attendiamo che API/cache espongano il dato.
      for (let attempt = 0; attempt < WRITE_CONFIRMATION_ATTEMPTS; attempt += 1) {
        if (attempt) await delay(WRITE_CONFIRMATION_DELAY_MS);
        try {
          const refreshedShipments = await this.findOrderCarriers(orderId);
          const refreshed = refreshedShipments.find((candidate) => String(candidate.id) === String(shipment.id));
          const trackingMatches = String(refreshed?.tracking_number ?? '').trim() === String(trackingNumber).trim();
          const carrierMatches = String(refreshed?.id_carrier ?? '').trim() === String(carrierId).trim();
          if (trackingMatches && carrierMatches) return { recoveredAfterError: true };
        } catch {
          // Conserva l'errore di scrittura se tutte le conferme falliscono.
        }
      }
      throw error;
    }
  }
}

function groupBy(items, selector) {
  return items.reduce((groups, item) => {
    const key = selector(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
    return groups;
  }, new Map());
}

function orderDetails(result, stateNames) {
  const { order, ...details } = result;
  return {
    ...details,
    orderId: order.id,
    orderDate: order.date_add ?? '',
    prestaStateId: String(order.current_state ?? ''),
    currentState: stateNames.get(String(order.current_state)) ?? `Stato ${order.current_state ?? '—'}`,
  };
}

function xmlValue(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function resourceXml(resource, fields) {
  const body = Object.entries(fields).map(([key, value]) => `<${key}><![CDATA[${xmlValue(value)}]]></${key}>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><prestashop xmlns:xlink="http://www.w3.org/1999/xlink"><${resource}>${body}</${resource}></prestashop>`;
}

function orderCarrierFields({ orderId, shipment, carrierId, trackingNumber }) {
  return {
    id: shipment.id,
    id_order: orderId,
    id_carrier: carrierId,
    id_order_invoice: shipment.id_order_invoice ?? '',
    weight: shipment.weight ?? '0',
    shipping_cost_tax_excl: shipment.shipping_cost_tax_excl ?? '0',
    shipping_cost_tax_incl: shipment.shipping_cost_tax_incl ?? '0',
    tracking_number: trackingNumber,
    date_add: shipment.date_add ?? '',
  };
}

function isOrderCarrierIdValidationError(error) {
  return /OrderCarrier-&gt;id_carrier|OrderCarrier->id_carrier|id_carrier non (?:(?:è|e) )?valid/i.test(String(error?.message || ''));
}

function permissionResult(label, method, status, isSafeWriteProbe = false) {
  const authorized = isSafeWriteProbe ? ![401, 403].includes(status) : status >= 200 && status < 300;
  return {
    label, method, status,
    authorized,
    detail: authorized
      ? (isSafeWriteProbe ? 'Autorizzazione verificata senza modificare dati.' : 'Autorizzazione disponibile.')
      : 'Autorizzazione assente o chiave non valida.',
  };
}
