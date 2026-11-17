const path = require('node:path');

// Cargar variables de entorno en desarrollo local si existen
try {
  process.loadEnvFile(path.join(__dirname, '..', '.env'));
} catch (error) {
  if (error && error.code !== 'ENOENT') {
    // Ignorar si el archivo no existe
  }
}

/**
 * Normaliza un número telefónico a formato internacional (E.164 sin signo +).
 * Diseñado especialmente para números de Venezuela (0412, 0414, 0424, 0416, 0426)
 * e internacionales.
 */
function normalizePhone(raw) {
  if (!raw) return '';
  let digits = String(raw).replace(/\D/g, '');
  if (!digits) return '';

  // Formato nacional venezolano: 04121234567 (11 dígitos) -> 584121234567
  if (digits.length === 11 && digits.startsWith('0')) {
    digits = '58' + digits.slice(1);
  } else if (digits.length === 10 && (
    digits.startsWith('412') || digits.startsWith('414') ||
    digits.startsWith('424') || digits.startsWith('416') || digits.startsWith('426')
  )) {
    digits = '58' + digits;
  }

  return digits;
}

/**
 * Construye el mensaje oficial de la factura para enviar por WhatsApp.
 */
function buildInvoiceMessage(order, baseUrl = '') {
  const name = order.clientName || order.invoice?.name || 'Cliente';
  const id = order.orderId || order.identifier || 'AUTO';
  const amountBs = Number(order.amountBs != null ? order.amountBs : (order.amountVes || 0)).toFixed(2);
  const amountUsd = Number(order.amount || 0).toFixed(2);
  const ref = order.reference || 'Acreditado vía Skylink Pay';
  const host = baseUrl || process.env.BASE_URL || 'https://skylink-test.vercel.app';
  const invoiceUrl = `${host.replace(/\/$/, '')}/factura?order_id=${encodeURIComponent(id)}`;

  return `🧾 *¡Hola ${name}!* Tu compra en *SkyPay* ha sido confirmada con éxito.\n\n` +
    `📌 *N° de Orden:* #${id}\n` +
    `💳 *Ref. Bancaria:* ${ref}\n` +
    `💵 *Monto Total:* Bs. ${amountBs} (≈ $${amountUsd} USD)\n\n` +
    `📄 *Tu Factura Digital y Comprobante Oficial:* \n${invoiceUrl}\n\n` +
    `¡Muchas gracias por tu compra! 🙌`;
}

/**
 * Envía un mensaje mediante Green API (Instancia Developer o Comercial).
 */
async function sendGreenApiMessage(phone, messageText) {
  const instanceId = process.env.GREEN_API_INSTANCE_ID?.trim();
  const token = process.env.GREEN_API_TOKEN?.trim();
  const apiHost = (process.env.GREEN_API_HOST || 'https://api.green-api.com').replace(/\/$/, '');

  if (!instanceId || !token) {
    return {
      success: false,
      skipped: true,
      reason: 'GREEN_API_INSTANCE_ID o GREEN_API_TOKEN no configurados en .env'
    };
  }

  const cleanPhone = normalizePhone(phone);
  if (!cleanPhone || cleanPhone.length < 8) {
    return {
      success: false,
      error: 'Número de teléfono inválido para Green API: ' + phone
    };
  }

  const endpoint = `${apiHost}/waInstance${instanceId}/sendMessage/${token}`;
  const payload = {
    chatId: `${cleanPhone}@c.us`,
    message: messageText
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    return {
      success: false,
      status: response.status,
      error: data.message || `Error HTTP ${response.status} de Green API`
    };
  }

  return {
    success: true,
    provider: 'green-api',
    messageId: data.idMessage,
    chatId: payload.chatId,
    timestamp: new Date().toISOString()
  };
}

/**
 * Despacha la notificación de factura para una orden vía Green API con fallback a wa.me.
 */
async function sendInvoiceWhatsApp(order, options = {}) {
  // SEGURIDAD ESTRICTA: La factura SOLO se envía si el pago ha sido confirmado (status: 'paid')
  if (!order || order.status !== 'paid') {
    return {
      success: false,
      blocked: true,
      error: `Envío bloqueado: La factura solo puede ser enviada cuando el pago ha sido confirmado (status actual: ${order?.status || 'desconocido'})`
    };
  }

  const rawPhone = order.clientPhone || order.invoicePhone || order.shippingData?.recipientPhone || '';
  const phone = normalizePhone(rawPhone);
  const baseUrl = options.baseUrl || order.hostUrl || '';
  const message = buildInvoiceMessage(order, baseUrl);
  const waMeUrl = phone ? `https://wa.me/${phone}?text=${encodeURIComponent(message)}` : '';

  if (!phone) {
    return {
      success: false,
      error: 'La orden no tiene número de teléfono registrado',
      waMeUrl
    };
  }

  // Intentar envío por Green API si está configurado
  let apiResult = null;
  try {
    apiResult = await sendGreenApiMessage(phone, message);
  } catch (err) {
    apiResult = {
      success: false,
      error: err.message
    };
  }

  const dispatchRecord = {
    phone,
    rawPhone,
    message,
    waMeUrl,
    sentAt: new Date().toISOString(),
    apiResult
  };

  if (apiResult && apiResult.success) {
    dispatchRecord.status = 'sent';
    dispatchRecord.provider = 'green-api';
  } else if (apiResult && apiResult.skipped) {
    dispatchRecord.status = 'ready_fallback';
    dispatchRecord.provider = 'wa.me';
    dispatchRecord.note = apiResult.reason;
  } else {
    dispatchRecord.status = 'fallback';
    dispatchRecord.provider = 'wa.me';
    dispatchRecord.error = apiResult?.error;
  }

  return dispatchRecord;
}

module.exports = {
  normalizePhone,
  buildInvoiceMessage,
  sendGreenApiMessage,
  sendInvoiceWhatsApp
};
