import nodemailer from 'nodemailer';

export class NotificationService {
  constructor({ getSettings, logger = console, fetchFn = globalThis.fetch } = {}) {
    this.getSettings = getSettings || (() => ({}));
    this.logger = logger;
    this.fetchFn = fetchFn;
  }

  get config() {
    return this.getSettings()?.notifications || {};
  }

  async sendTelegram({ text, parseMode = 'HTML', config = this.config.telegram }) {
    if (!config?.enabled) return { ok: false, skipped: true, reason: 'Telegram disabilitato' };
    if (!config.botToken || !config.chatId) {
      throw new Error('Configurazione Telegram incompleta: specificare Bot Token e Chat ID.');
    }

    const url = `https://api.telegram.org/bot${encodeURIComponent(config.botToken)}/sendMessage`;
    const response = await this.fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.chatId,
        text,
        parse_mode: parseMode,
        disable_web_page_preview: true,
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      const detail = data.description || `HTTP ${response.status}`;
      throw new Error(`Errore invio Telegram: ${detail}`);
    }

    return { ok: true, result: data.result };
  }

  async sendEmail({ subject, html, text, config = this.config.email }) {
    if (!config?.enabled) return { ok: false, skipped: true, reason: 'Email disabilitata' };
    if (!config.host || !config.to) {
      throw new Error('Configurazione Email incompleta: specificare Host SMTP e destinatario.');
    }

    const transportOptions = {
      host: config.host,
      port: Number(config.port) || 587,
      secure: Boolean(config.secure),
      connectionTimeout: 8000,
    };

    if (config.user) {
      transportOptions.auth = {
        user: config.user,
        pass: config.pass || '',
      };
    }

    const transporter = nodemailer.createTransport(transportOptions);
    const fromAddress = config.from || config.user || 'dsv-tracking@localhost';

    const info = await transporter.sendMail({
      from: fromAddress,
      to: config.to,
      subject,
      text: text || html?.replace(/<[^>]+>/g, ' '),
      html,
    });

    return { ok: true, messageId: info.messageId };
  }

  async testTelegram(config) {
    const message = `🤖 <b>DSV Tracking Center</b>\n\n✅ <i>Connessione Bot Telegram riuscita!</i>\nLe notifiche operative per le spedizioni verranno recapitate in questa chat.`;
    return this.sendTelegram({ text: message, config: { ...config, enabled: true } });
  }

  async testEmail(config) {
    const subject = `[DSV Tracking Center] Test Notifica Email`;
    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 540px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 8px;">
        <h2 style="color: #0b1528; margin-top: 0;">DSV Tracking Center</h2>
        <p style="color: #10b981; font-weight: bold; font-size: 16px;">✓ Connessione SMTP configurata con successo</p>
        <p style="color: #475569; font-size: 14px; line-height: 1.5;">Questo messaggio conferma che i parametri del server di posta sono corretti. Riceverai qui gli avvisi e i report configurati.</p>
        <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 20px 0;" />
        <small style="color: #94a3b8; font-size: 12px;">Inviato da DSV Tracking Center il ${new Date().toLocaleString('it-IT')}</small>
      </div>
    `;
    return this.sendEmail({ subject, html, config: { ...config, enabled: true } });
  }

  async notifyException(shipment, dsvOutcome = {}) {
    if (!this.config.triggers?.exceptions) return { skipped: true };

    const tracking = shipment.trackingNumber;
    const orderRef = shipment.orderReference || shipment.orderId || 'N/D';
    const status = dsvOutcome.status || shipment.dsvStatus || 'Eccezione';
    const detail = dsvOutcome.detail || shipment.lastSeenDetail || 'Verificare sul portale DSV';

    const textTelegram = [
      `🚨 <b>DSV Alert · Eccezione Spedizione</b>`,
      ``,
      `📦 <b>Tracking:</b> <code>${tracking}</code>`,
      `🛒 <b>Ordine PrestaShop:</b> <b>${orderRef}</b>`,
      `⚠️ <b>Stato DSV:</b> <b>${status}</b>`,
      `📍 <b>Dettaglio:</b> ${detail}`,
      `🕒 <i>Rilevato il: ${new Date().toLocaleString('it-IT')}</i>`,
    ].join('\n');

    const subjectEmail = `[DSV Alert] Eccezione spedizione ${tracking} (Ordine ${orderRef})`;
    const htmlEmail = `
      <div style="font-family: sans-serif; max-width: 560px; padding: 20px; border: 1px solid #fee2e2; border-radius: 8px; background: #fffaf0;">
        <h3 style="color: #b91c1c; margin-top: 0;">⚠️ Eccezione DSV Rilevata</h3>
        <p>Una spedizione attiva richiede attenzione operativa:</p>
        <ul style="line-height: 1.6; color: #334155;">
          <li><strong>Tracking:</strong> <code>${tracking}</code></li>
          <li><strong>Riferimento Ordine:</strong> <strong>${orderRef}</strong></li>
          <li><strong>Stato DSV:</strong> <span style="color: #b91c1c; font-weight: bold;">${status}</span></li>
          <li><strong>Dettaglio:</strong> ${detail}</li>
          <li><strong>Data evento:</strong> ${new Date().toLocaleString('it-IT')}</li>
        </ul>
      </div>
    `;

    return this.dispatchBoth({ telegramText: textTelegram, emailSubject: subjectEmail, emailHtml: htmlEmail });
  }

  async notifyAutoSyncSuccess(shipment, targetStateName) {
    if (!this.config.triggers?.autoSyncSuccess) return { skipped: true };

    const tracking = shipment.trackingNumber;
    const orderRef = shipment.orderReference || shipment.orderId || 'N/D';

    const textTelegram = [
      `⚡ <b>DSV Cron · Ordine PrestaShop Allineato</b>`,
      ``,
      `📦 <b>Tracking:</b> <code>${tracking}</code>`,
      `🛒 <b>Ordine:</b> <b>${orderRef}</b>`,
      `🔄 <b>Nuovo Stato:</b> <b>${targetStateName}</b>`,
      `🛡️ <i>Nessuna email inviata al cliente</i>`,
      `🕒 <i>${new Date().toLocaleString('it-IT')}</i>`,
    ].join('\n');

    const subjectEmail = `[DSV Auto-Sync] Ordine ${orderRef} aggiornato a ${targetStateName}`;
    const htmlEmail = `
      <div style="font-family: sans-serif; max-width: 560px; padding: 20px; border: 1px solid #d1fae5; border-radius: 8px; background: #f0fdf4;">
        <h3 style="color: #047857; margin-top: 0;">✓ Ordine Allineato su PrestaShop</h3>
        <p>Il cron ha sincronizzato lo stato in background:</p>
        <ul style="line-height: 1.6; color: #334155;">
          <li><strong>Spedizione:</strong> <code>${tracking}</code></li>
          <li><strong>Rif. Ordine:</strong> <strong>${orderRef}</strong></li>
          <li><strong>Nuovo Stato:</strong> <strong>${targetStateName}</strong></li>
          <li><strong>Notifica cliente:</strong> Disattivata (zero email)</li>
        </ul>
      </div>
    `;

    return this.dispatchBoth({ telegramText: textTelegram, emailSubject: subjectEmail, emailHtml: htmlEmail });
  }

  async notifySlaBreach(delayedShipments = []) {
    if (!this.config.triggers?.sla48h || !delayedShipments.length) return { skipped: true };

    const count = delayedShipments.length;
    const itemsListTelegram = delayedShipments.slice(0, 8).map((s) => 
      `• <code>${s.trackingNumber}</code> (${s.orderReference || s.orderId || 'N/D'}) - ${s.dsvStatus || 'In attesa'}`
    ).join('\n');

    const textTelegram = [
      `⏳ <b>DSV Alert · ${count} Spedizion${count === 1 ? 'e ferma' : 'i ferme'} da oltre 48h</b>`,
      ``,
      `Le seguenti spedizioni non registrano aggiornamenti recenti:`,
      itemsListTelegram,
      count > 8 ? `<i>...e altre ${count - 8} spedizioni</i>` : '',
      ``,
      `<i>Verifica il Centro di Controllo per gestire i ticket.</i>`,
    ].filter(Boolean).join('\n');

    const subjectEmail = `[DSV SLA Alert] ${count} spedizioni ferme da oltre 48 ore`;
    const htmlEmail = `
      <div style="font-family: sans-serif; max-width: 560px; padding: 20px; border: 1px solid #fed7aa; border-radius: 8px; background: #fffaf0;">
        <h3 style="color: #c2410c; margin-top: 0;">⏳ Allarme SLA: Spedizioni Ferme da > 48h</h3>
        <p>Sono state rilevate <strong>${count}</strong> spedizioni non consegnate senza aggiornamenti nelle ultime 48 ore:</p>
        <ul style="line-height: 1.6; color: #334155;">
          ${delayedShipments.slice(0, 10).map((s) => `<li><code>${s.trackingNumber}</code> (Ordine: <strong>${s.orderReference || s.orderId || 'N/D'}</strong>) — ${s.dsvStatus || 'In movimento'}</li>`).join('')}
        </ul>
        ${count > 10 ? `<p><em>...più altre ${count - 10} spedizioni nel Centro di Controllo.</em></p>` : ''}
      </div>
    `;

    return this.dispatchBoth({ telegramText: textTelegram, emailSubject: subjectEmail, emailHtml: htmlEmail });
  }

  async sendDailyDigest(summary = {}) {
    if (!this.config.triggers?.dailyDigest) return { skipped: true };

    const { totalActive = 0, deliveredToday = 0, exceptions = 0, delayed = 0 } = summary;

    const textTelegram = [
      `📊 <b>DSV Tracking Center · Digest Mattutino</b>`,
      ``,
      `📦 Spedizioni attive in monitoraggio: <b>${totalActive}</b>`,
      `✅ Consegnate nelle ultime 24h: <b>${deliveredToday}</b>`,
      `⚠️ Eccezioni aperte da verificare: <b>${exceptions}</b>`,
      `⏳ Spedizioni ferme > 48h: <b>${delayed}</b>`,
      ``,
      `<i>Buon lavoro dal tuo centro di controllo logistico!</i>`,
    ].join('\n');

    const subjectEmail = `[DSV Daily Digest] Riepilogo Spedizioni del ${new Date().toLocaleDateString('it-IT')}`;
    const htmlEmail = `
      <div style="font-family: sans-serif; max-width: 560px; padding: 24px; border: 1px solid #e2e8f0; border-radius: 8px;">
        <h3 style="color: #0b1528; margin-top: 0;">📊 Riepilogo Giornaliero Spedizioni DSV</h3>
        <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
          <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px 0;">Spedizioni attive:</td><td style="text-align: right; font-weight: bold;">${totalActive}</td></tr>
          <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px 0; color: #10b981;">Consegnate oggi:</td><td style="text-align: right; font-weight: bold; color: #10b981;">${deliveredToday}</td></tr>
          <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px 0; color: #ef4444;">Eccezioni aperte:</td><td style="text-align: right; font-weight: bold; color: #ef4444;">${exceptions}</td></tr>
          <tr><td style="padding: 8px 0; color: #f59e0b;">Ferme da > 48h:</td><td style="text-align: right; font-weight: bold; color: #f59e0b;">${delayed}</td></tr>
        </table>
        <small style="color: #94a3b8;">Generato alle ${new Date().toLocaleTimeString('it-IT')}</small>
      </div>
    `;

    return this.dispatchBoth({ telegramText: textTelegram, emailSubject: subjectEmail, emailHtml: htmlEmail });
  }

  async dispatchBoth({ telegramText, emailSubject, emailHtml }) {
    const results = {};
    if (this.config.telegram?.enabled) {
      try {
        results.telegram = await this.sendTelegram({ text: telegramText });
      } catch (err) {
        this.logger.error('[NOTIFICATIONS] Errore invio Telegram:', err.message);
        results.telegram = { ok: false, error: err.message };
      }
    }
    if (this.config.email?.enabled) {
      try {
        results.email = await this.sendEmail({ subject: emailSubject, html: emailHtml });
      } catch (err) {
        this.logger.error('[NOTIFICATIONS] Errore invio Email:', err.message);
        results.email = { ok: false, error: err.message };
      }
    }
    return results;
  }
}
