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
 * Construye el formato de comprobante oficial de pago para WhatsApp.
 * Incluye: Nombre, Cédula, Teléfono, Productos con monto en Bs, Total en Bs,
 * Referencia bancaria, N° de orden y enlace a la factura digital.
 */
function buildInvoiceMessage(order, baseUrl = '') {
  const name = (order.clientName || order.invoice?.name || 'Cliente').trim();
  const idNumber = (order.clientId || order.invoiceId || order.invoice?.idNumber || 'No especificada').trim();
  const rawPhone = order.clientPhone || order.invoicePhone || order.invoice?.phone || '';
  const cleanPhone = normalizePhone(rawPhone);
  const id = order.orderId || order.identifier || 'AUTO';
  const amountBs = Number(order.amountBs != null ? order.amountBs : (order.amountVes || 0)).toFixed(2);
  const amountUsd = Number(order.amount || 0).toFixed(2);
  const ref = order.reference || 'Confirmado vía Skylink Pay';
  const host = (baseUrl || process.env.BASE_URL || 'https://skylink-test.vercel.app').replace(/\/$/, '');
  const invoiceUrl = `${host}/factura?order_id=${encodeURIComponent(id)}`;

  // Desglose de productos con monto en Bs
  let itemsList = '';
  if (Array.isArray(order.items) && order.items.length > 0) {
    itemsList = order.items.map(item => {
      const qty = item.qty || item.quantity || 1;
      const unitBs = Number(item.priceBs || (item.price ? item.price * (order.bcvRate || 37.50) : 25.00)).toFixed(2);
      const subtotalBs = (qty * Number(unitBs)).toFixed(2);
      const icon = item.icon || '🛍️';
      return `  ${icon} *${qty}x ${item.name}* — Bs. ${subtotalBs} (Bs. ${unitBs} c/u)`;
    }).join('\n');
  } else {
    itemsList = `  🛍️ *1x ${order.description || 'Compra en Kiosco SkyPay'}* — Bs. ${amountBs}`;
  }

  return `🧾 *COMPROBANTE DE PAGO · SKYPAY* 🧾\n\n` +
    `¡Hola *${name}*! Tu compra en *SkyPay* ha sido confirmada con éxito.\n\n` +
    `📋 *DATOS DEL CLIENTE:*\n` +
    `👤 *Nombre:* ${name}\n` +
    `🆔 *Cédula/RIF:* ${idNumber}\n` +
    `📱 *Teléfono:* ${cleanPhone ? '+' + cleanPhone : 'Registrado'}\n\n` +
    `🛒 *PRODUCTO(S) COMPRADO(S):*\n` +
    `${itemsList}\n\n` +
    `💵 *MONTO TOTAL:* *Bs. ${amountBs}* (≈ $${amountUsd} USD)\n` +
    `📌 *N° de Orden:* #${id}\n` +
    `💳 *Ref. Bancaria:* ${ref}\n\n` +
    `📄 *Tu Factura Digital y Comprobante Oficial (PDF):*\n` +
    `${invoiceUrl}\n\n` +
    `¡Muchas gracias por tu compra! 🙌`;
}

/**
 * Realiza una petición HTTP a Green API con timeout controlado.
 */
async function callGreenApiEndpoint(endpoint, payload, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, data };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Envía un mensaje mediante Green API con reintentos automáticos y diagnóstico detallado.
 */
async function sendGreenApiMessage(phone, messageText) {
  const instanceId = process.env.GREEN_API_INSTANCE_ID?.trim();
  const token = process.env.GREEN_API_TOKEN?.trim();
  const apiHost = (process.env.GREEN_API_HOST || 'https://api.green-api.com').replace(/\/$/, '');

  if (!instanceId || !token) {
    console.warn('[GreenAPI] Envío omitido: GREEN_API_INSTANCE_ID o GREEN_API_TOKEN no configurados en .env');
    return {
      success: false,
      skipped: true,
      reason: 'GREEN_API_INSTANCE_ID o GREEN_API_TOKEN no configurados en .env'
    };
  }

  const cleanPhone = normalizePhone(phone);
  if (!cleanPhone || cleanPhone.length < 8) {
    console.error('[GreenAPI] Teléfono inválido:', phone);
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

  console.log(`[GreenAPI] Despachando mensaje a ${cleanPhone} (instancia: ${instanceId})...`);

  let lastResult = null;
  const maxAttempts = 2; // Intento inicial + 1 reintento automático si hay rate-limit o glitch

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await callGreenApiEndpoint(endpoint, payload, 10000);
      lastResult = res;

      if (res.ok && res.data && res.data.idMessage) {
        console.log(`[GreenAPI] Mensaje enviado exitosamente a ${cleanPhone}. idMessage: ${res.data.idMessage}`);
        return {
          success: true,
          provider: 'green-api',
          messageId: res.data.idMessage,
          chatId: payload.chatId,
          timestamp: new Date().toISOString()
        };
      }

      console.warn(`[GreenAPI] Intento ${attempt}/${maxAttempts} falló. HTTP ${res.status}:`, res.data);

      // Si el error es de cuota del plan gratuito Developer (máx 3 chats por mes)
      if (res.status === 466 || (res.data && /quota|limit|tariff/i.test(JSON.stringify(res.data)))) {
        const quotaMsg = 'Límite de contactos del plan gratuito Green API alcanzado (máximo 3 chats permitidos en plan Developer).';
        console.error(`[GreenAPI] ${quotaMsg}`);
        return {
          success: false,
          status: res.status,
          error: quotaMsg,
          details: res.data
        };
      }

      // Si es un error transitorio o rate-limit (429, 500, 502, 503, 504), esperar y reintentar
      if (attempt < maxAttempts && (res.status === 429 || res.status >= 500)) {
        console.log(`[GreenAPI] Esperando 1500ms antes del reintento ${attempt + 1}...`);
        await new Promise(resolve => setTimeout(resolve, 1500));
        continue;
      }

      return {
        success: false,
        status: res.status,
        error: res.data?.message || `Error HTTP ${res.status} de Green API`,
        details: res.data
      };
    } catch (err) {
      console.error(`[GreenAPI] Excepción en intento ${attempt}/${maxAttempts}:`, err.message);
      lastResult = { error: err.message };

      if (attempt < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
    }
  }

  return {
    success: false,
    error: lastResult?.error || 'No se pudo enviar el mensaje a través de Green API tras varios intentos.'
  };
}

/**
 * Despacha la notificación de factura para una orden vía Green API con fallback a wa.me.
 * SEGURIDAD ESTRICTA: La factura SOLO se envía si el pago ha sido confirmado (status: 'paid').
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
    dispatchRecord.messageId = apiResult.messageId;
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
