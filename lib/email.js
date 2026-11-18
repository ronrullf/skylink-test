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
 * Sanitiza texto para incrustarlo de forma segura en streams de PDF 1.4 sin codificación extendida.
 */
function sanitizePdfText(str) {
  if (!str) return '';
  return String(str)
    .replace(/[\\()]/g, '')
    .replace(/[áàäâ]/g, 'a').replace(/[ÁÀÄÂ]/g, 'A')
    .replace(/[éèëê]/g, 'e').replace(/[ÉÈËÊ]/g, 'E')
    .replace(/[íìïî]/g, 'i').replace(/[ÍÌÏÎ]/g, 'I')
    .replace(/[óòöô]/g, 'o').replace(/[ÓÒÖÔ]/g, 'O')
    .replace(/[úùüû]/g, 'u').replace(/[ÚÙÜÛ]/g, 'U')
    .replace(/[ñ]/g, 'n').replace(/[Ñ]/g, 'N');
}

/**
 * Genera el archivo binario PDF 1.4 estándar de la factura sin dependencias externas.
 */
function buildPdfInvoiceBuffer(order, settings = null) {
  const items = order.items || [];
  const orderNum = order.orderId || order.identifier || 'AUTO';
  const dateStr = new Date(order.paidAt || order.createdAt || Date.now()).toLocaleString('es-VE');
  const client = order.clientName || order.invoice?.name || 'Cliente';
  const email = order.clientEmail || order.invoiceEmail || order.invoice?.email || 'No registrado';
  const phone = order.clientPhone || order.invoicePhone || 'No registrado';
  const idNum = order.clientId || order.invoiceId || order.invoice?.idNumber || 'V-00000000';
  const ref = order.reference || 'SK-CONFIRMADA';
  const usd = Number(order.amount || 0).toFixed(2);
  const bs = Number(order.amountBs != null ? order.amountBs : (order.amountVes || 0)).toFixed(2);
  const storeName = (settings?.storeName || order.storeName || 'SKYPAY').trim();
  const storeRif = (settings?.storeRif || order.storeRif || 'J-50733628-0').trim();
  const storeAddress = (settings?.storeAddress || order.storeAddress || 'Caracas, Venezuela').trim();
  const footer = (settings?.invoiceFooter || order.invoiceFooter || 'Conserva este comprobante digital descargado en tu dispositivo.').trim();

  let textOps = [
    'BT',
    '/F1 18 Tf',
    '50 780 Td',
    '(' + sanitizePdfText(storeName.toUpperCase() + ' - FACTURA DIGITAL DE COMPRA') + ') Tj',
    '/F1 10 Tf',
    '0 -24 Td',
    '(' + sanitizePdfText('RIF: ' + storeRif + ' | ' + storeAddress + ' | Skylink Pay') + ') Tj',
    '0 -18 Td',
    '(' + sanitizePdfText('--------------------------------------------------------------------------------------------------') + ') Tj',
    '/F1 11 Tf',
    '0 -20 Td',
    '(' + sanitizePdfText('Orden: #' + orderNum) + ') Tj',
    '0 -16 Td',
    '(' + sanitizePdfText('Fecha: ' + dateStr) + ') Tj',
    '0 -16 Td',
    '(' + sanitizePdfText('Nombre: ' + client) + ') Tj',
    '0 -16 Td',
    '(' + sanitizePdfText('Correo: ' + email) + ') Tj',
    '0 -16 Td',
    '(' + sanitizePdfText('WhatsApp / Telefono: ' + phone) + ') Tj',
    '0 -16 Td',
    '(' + sanitizePdfText('Cedula / RIF: ' + idNum) + ') Tj',
    '0 -16 Td',
    '(' + sanitizePdfText('Referencia Bancaria: ' + ref) + ') Tj',
    '0 -20 Td',
    '(' + sanitizePdfText('--------------------------------------------------------------------------------------------------') + ') Tj',
    '/F1 11 Tf',
    '0 -18 Td',
    '(' + sanitizePdfText('DETALLE DE ARTICULOS:') + ') Tj'
  ];

  if (items.length === 0) {
    textOps.push('0 -16 Td');
    textOps.push('(' + sanitizePdfText('1x ' + (order.description || 'Compra Kiosco') + ' - Bs. ' + bs) + ') Tj');
  } else {
    items.forEach(it => {
      textOps.push('0 -16 Td');
      const p = Number(it.priceBs || (it.price ? it.price * (order.bcvRate || 37.5) : 25));
      const sub = (p * (it.qty || 1)).toFixed(2);
      textOps.push('(' + sanitizePdfText((it.qty || 1) + 'x ' + it.name + ' - Bs. ' + sub) + ') Tj');
    });
  }

  textOps.push('0 -22 Td');
  textOps.push('(' + sanitizePdfText('--------------------------------------------------------------------------------------------------') + ') Tj');
  textOps.push('/F1 14 Tf');
  textOps.push('0 -22 Td');
  textOps.push('(' + sanitizePdfText('TOTAL PAGADO: Bs. ' + bs + '  (aprox $' + usd + ' USD)') + ') Tj');
  textOps.push('/F1 9 Tf');
  textOps.push('0 -26 Td');
  textOps.push('(' + sanitizePdfText('ESTADO: PAGO VERIFICADO Y ACREDITADO POR SKYLINK PAY') + ') Tj');
  textOps.push('0 -14 Td');
  textOps.push('(' + sanitizePdfText(footer) + ') Tj');
  textOps.push('ET');

  const contentStream = textOps.join('\n');
  const streamBuf = Buffer.from(contentStream, 'utf8');

  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    '4 0 obj\n<< /Length ' + streamBuf.length + ' >>\nstream\n' + contentStream + '\nendstream\nendobj\n',
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n'
  ];

  let body = '%PDF-1.4\n';
  const offsets = [];
  offsets.push(Buffer.byteLength(body, 'utf8'));

  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(body, 'utf8'));
    body += objects[i];
  }

  const xrefOffset = Buffer.byteLength(body, 'utf8');
  let xref = 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
  for (let i = 1; i <= objects.length; i++) {
    const offStr = String(offsets[i]).padStart(10, '0');
    xref += offStr + ' 00000 n \n';
  }

  const trailer = 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xrefOffset + '\n%%EOF\n';
  return Buffer.from(body + xref + trailer, 'binary');
}

/**
 * Genera el cuerpo HTML enriquecido para el correo de la factura.
 */
function buildInvoiceEmailHtml(order, invoiceUrl, settings = null) {
  const name = order.clientName || order.invoice?.name || 'Cliente';
  const id = order.orderId || order.identifier || 'AUTO';
  const idNumber = order.clientId || order.invoiceId || order.invoice?.idNumber || 'No especificada';
  const phone = order.clientPhone || order.invoicePhone || 'No registrado';
  const email = order.clientEmail || order.invoiceEmail || order.invoice?.email || 'No registrado';
  const amountBs = Number(order.amountBs != null ? order.amountBs : (order.amountVes || 0)).toFixed(2);
  const amountUsd = Number(order.amount || 0).toFixed(2);
  const ref = order.reference || 'Confirmado vía Skylink Pay';
  const storeName = (settings?.storeName || order.storeName || 'SkyPay').trim();
  const storeRif = (settings?.storeRif || order.storeRif || 'J-50733628-0').trim();
  const storeAddress = (settings?.storeAddress || order.storeAddress || 'Caracas, Venezuela').trim();
  const footer = (settings?.invoiceFooter || order.invoiceFooter || 'Comprobante Electrónico Autorizado').trim();

  let itemsHtml = '';
  if (Array.isArray(order.items) && order.items.length > 0) {
    itemsHtml = order.items.map(it => {
      const qty = it.qty || it.quantity || 1;
      const unitBs = Number(it.priceBs || (it.price ? it.price * (order.bcvRate || 37.5) : 25)).toFixed(2);
      const sub = (qty * Number(unitBs)).toFixed(2);
      return `<tr>
        <td style="padding: 8px 12px; border-bottom: 1px solid #e2e8f0;">${qty}x ${it.name}</td>
        <td style="padding: 8px 12px; border-bottom: 1px solid #e2e8f0; text-align: right;">Bs. ${unitBs}</td>
        <td style="padding: 8px 12px; border-bottom: 1px solid #e2e8f0; text-align: right; font-weight: bold;">Bs. ${sub}</td>
      </tr>`;
    }).join('');
  } else {
    itemsHtml = `<tr>
      <td colspan="2" style="padding: 8px 12px; border-bottom: 1px solid #e2e8f0;">${order.description || 'Compra en Kiosco SkyPay'}</td>
      <td style="padding: 8px 12px; border-bottom: 1px solid #e2e8f0; text-align: right; font-weight: bold;">Bs. ${amountBs}</td>
    </tr>`;
  }

  return `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8">
    <title>Comprobante de Pago SkyPay</title>
  </head>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; margin: 0; padding: 24px; color: #0f172a;">
    <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 16px; border: 1px solid #e2e8f0; padding: 32px; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
      <div style="text-align: center; margin-bottom: 24px;">
        <span style="display: inline-block; background: #dcfce7; color: #166534; font-size: 13px; font-weight: 800; padding: 6px 14px; border-radius: 20px; border: 1px solid #bbf7d0;">
          ✓ PAGO CONFIRMADO
        </span>
        <h1 style="font-size: 22px; font-weight: 800; margin: 16px 0 6px; color: #0f172a;">¡Gracias por tu compra, ${name}!</h1>
        <p style="font-size: 14px; color: #64748b; margin: 0;">Tu pago ha sido procesado y acreditado con éxito a través de Skylink Pay.</p>
      </div>

      <div style="background: #f1f5f9; border-radius: 12px; padding: 18px; margin-bottom: 24px; font-size: 13px;">
        <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
          <span style="color: #64748b;">N° de Orden:</span>
          <strong>#${id}</strong>
        </div>
        <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
          <span style="color: #64748b;">Cédula / RIF:</span>
          <strong>${idNumber}</strong>
        </div>
        <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
          <span style="color: #64748b;">WhatsApp / Teléfono:</span>
          <strong>${phone}</strong>
        </div>
        <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
          <span style="color: #64748b;">Correo Electrónico:</span>
          <strong>${email}</strong>
        </div>
        <div style="display: flex; justify-content: space-between;">
          <span style="color: #64748b;">Referencia Bancaria:</span>
          <strong style="color: #0284c7;">${ref}</strong>
        </div>
      </div>

      <h3 style="font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px; color: #475569; margin-bottom: 10px;">Detalle de Artículos</h3>
      <table style="width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 20px;">
        <thead>
          <tr style="background: #f8fafc; color: #64748b; text-align: left;">
            <th style="padding: 8px 12px; border-bottom: 1px solid #cbd5e1;">Producto</th>
            <th style="padding: 8px 12px; border-bottom: 1px solid #cbd5e1; text-align: right;">Precio</th>
            <th style="padding: 8px 12px; border-bottom: 1px solid #cbd5e1; text-align: right;">Subtotal</th>
          </tr>
        </thead>
        <tbody>
          ${itemsHtml}
        </tbody>
      </table>

      <div style="background: #ecfdf5; border: 1.5px solid #a7f3d0; border-radius: 12px; padding: 16px; margin-bottom: 24px; text-align: right;">
        <div style="font-size: 13px; color: #065f46;">Total Pagado</div>
        <div style="font-size: 22px; font-weight: 900; color: #047857;">Bs. ${amountBs} <span style="font-size: 14px; font-weight: normal; color: #065f46;">(≈ $${amountUsd} USD)</span></div>
      </div>

      <div style="text-align: center; margin-bottom: 24px;">
        <p style="font-size: 13px; color: #64748b; margin-bottom: 14px;">Hemos adjuntado tu <strong>Factura Oficial en formato PDF</strong> a este correo. También puedes verla en línea:</p>
        <a href="${invoiceUrl}" style="display: inline-block; background: #0f172a; color: #ffffff; text-decoration: none; font-weight: 700; font-size: 14px; padding: 12px 24px; border-radius: 10px;">
          Ver Factura Digital en Línea ↗
        </a>
      </div>

      <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0 16px;">
      <div style="text-align: center; font-size: 11px; color: #94a3b8;">
        ${storeName} · RIF: ${storeRif} · ${storeAddress}<br>
        ${footer}
      </div>
    </div>
  </body>
  </html>
  `;
}

function buildInvoiceEmailText(order, invoiceUrl, settings = null) {
  const name = order.clientName || order.invoice?.name || 'Cliente';
  const id = order.orderId || order.identifier || 'AUTO';
  const idNumber = order.clientId || order.invoiceId || order.invoice?.idNumber || 'No especificada';
  const phone = order.clientPhone || order.invoicePhone || 'No registrado';
  const amountBs = Number(order.amountBs != null ? order.amountBs : (order.amountVes || 0)).toFixed(2);
  const amountUsd = Number(order.amount || 0).toFixed(2);
  const ref = order.reference || 'Confirmado via Skylink Pay';
  const storeName = (settings?.storeName || order.storeName || 'SkyPay').trim();
  const storeRif = (settings?.storeRif || order.storeRif || 'J-50733628-0').trim();
  const itemsText = (Array.isArray(order.items) && order.items.length > 0)
    ? order.items.map(it => {
        const qty = it.qty || it.quantity || 1;
        const unitBs = Number(it.priceBs || (it.price ? it.price * (order.bcvRate || 37.5) : 25)).toFixed(2);
        return `- ${qty}x ${it.name}: Bs. ${(qty * Number(unitBs)).toFixed(2)}`;
      }).join('\n')
    : `- 1x ${order.description || 'Compra'}: Bs. ${amountBs}`;

  return [
    `COMPROBANTE DE PAGO - ${storeName}`,
    `RIF: ${storeRif}`,
    '',
    `Hola ${name}, tu pago ha sido confirmado con exito.`,
    '',
    `Orden: #${id}`,
    `Cedula/RIF: ${idNumber}`,
    `Telefono: ${phone}`,
    `Referencia Bancaria: ${ref}`,
    '',
    'Detalle de articulos:',
    itemsText,
    '',
    `TOTAL PAGADO: Bs. ${amountBs} (aprox. $${amountUsd} USD)`,
    '',
    `Tu factura oficial en PDF esta adjunta a este correo. Tambien puedes verla en linea:`,
    invoiceUrl
  ].join('\n');
}

/**
 * Despacha la factura por correo electrónico mediante la API de Resend adjuntando el PDF oficial.
 * SEGURIDAD ESTRICTA: La factura SOLO se envía si el pago ha sido confirmado (status: 'paid').
 */
async function sendInvoiceEmail(order, options = {}) {
  // SEGURIDAD ESTRICTA
  if (!order || order.status !== 'paid') {
    return {
      success: false,
      blocked: true,
      error: `Envío de correo bloqueado: La factura solo puede ser enviada cuando el pago ha sido confirmado (status actual: ${order?.status || 'desconocido'})`
    };
  }

  const settings = options.settings || null;
  if (settings && settings.resendEnabled === false) {
    return {
      success: false,
      skipped: true,
      reason: 'El envío automático por correo está desactivado en la configuración de la tienda.'
    };
  }

  const apiKey = (settings?.resendApiKey || process.env.RESEND_API_KEY || '').trim();
  const fromEmail = (settings?.resendFromEmail || process.env.RESEND_FROM_EMAIL || 'SkyPay <onboarding@resend.dev>').trim();
  const storeName = (settings?.storeName || order.storeName || 'SkyPay').trim();
  const recipientEmail = (order.clientEmail || order.invoiceEmail || order.shippingData?.recipientEmail || '').trim();

  if (!apiKey) {
    console.warn('[Resend] Envío omitido: RESEND_API_KEY no configurado.');
    return {
      success: false,
      skipped: true,
      reason: 'RESEND_API_KEY no configurado'
    };
  }

  if (!recipientEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
    console.log('[Resend] Orden sin correo electrónico registrado o con formato inválido:', recipientEmail);
    return {
      success: false,
      skipped: true,
      reason: 'No se especificó un correo electrónico válido para el envío'
    };
  }

  const id = order.orderId || order.identifier || 'AUTO';
  const baseUrl = (options.baseUrl || order.hostUrl || process.env.BASE_URL || 'https://skylink-test.vercel.app').replace(/\/$/, '');
  const invoiceUrl = `${baseUrl}/factura?order_id=${encodeURIComponent(id)}`;

  console.log(`[Resend] Generando PDF y enviando factura #${id} desde ${fromEmail} a ${recipientEmail}...`);

  try {
    const pdfBuffer = buildPdfInvoiceBuffer(order, settings);
    const pdfBase64 = pdfBuffer.toString('base64');
    const htmlBody = buildInvoiceEmailHtml(order, invoiceUrl, settings);
    const textBody = buildInvoiceEmailText(order, invoiceUrl, settings);

    const payload = {
      from: fromEmail,
      to: [recipientEmail],
      subject: `Factura #${id} - ${storeName}`,
      text: textBody,
      html: htmlBody,
      attachments: [
        {
          filename: `Factura-${id}.pdf`,
          content: pdfBase64,
          content_type: 'application/pdf'
        }
      ]
    };

    const maxAttempts = 2;
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      }).finally(() => clearTimeout(timeout));

      const data = await response.json().catch(() => ({}));

      if (response.ok) {
        console.log(`[Resend] Correo enviado exitosamente a ${recipientEmail}. ID: ${data.id}`);
        return {
          success: true,
          provider: 'resend',
          emailId: data.id,
          from: fromEmail,
          recipient: recipientEmail,
          sentAt: new Date().toISOString()
        };
      }

      lastError = { status: response.status, message: data.message || `Error HTTP ${response.status} de Resend`, details: data };
      console.error(`[Resend] Intento ${attempt}/${maxAttempts} falló (HTTP ${response.status}) para ${recipientEmail}:`, data);
      if (attempt < maxAttempts && (response.status === 429 || response.status >= 500)) {
        await new Promise(resolve => setTimeout(resolve, 1200));
        continue;
      }
      break;
    }

    return {
      success: false,
      status: lastError?.status,
      from: fromEmail,
      recipient: recipientEmail,
      error: lastError?.message || 'No se pudo enviar el correo vía Resend',
      details: lastError?.details
    };
  } catch (err) {
    console.error(`[Resend] Excepción al despachar correo a ${recipientEmail}:`, err.message);
    return {
      success: false,
      from: fromEmail,
      recipient: recipientEmail,
      error: err.message
    };
  }
}

/**
 * Envía un correo de prueba desde el panel /admin para validar la API Key y el remitente de Resend.
 */
async function sendTestEmail(toEmail, settings = {}) {
  const apiKey = (settings.resendApiKey || process.env.RESEND_API_KEY || '').trim();
  const fromEmail = (settings.resendFromEmail || process.env.RESEND_FROM_EMAIL || 'SkyPay <onboarding@resend.dev>').trim();
  const storeName = (settings.storeName || 'SkyPay').trim();

  if (!apiKey) return { success: false, error: 'Falta configurar RESEND_API_KEY.' };
  if (!toEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toEmail)) {
    return { success: false, error: 'Ingresa un correo de destino válido.' };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [toEmail.trim()],
        subject: `✅ Correo de Prueba — ${storeName}`,
        html: `<div style="font-family:sans-serif;padding:24px;max-width:520px;margin:0 auto;border:1px solid #e2e8f0;border-radius:12px;">
          <h2 style="color:#047857;margin-top:0;">✅ ¡Resend conectado correctamente!</h2>
          <p>Tu tienda <strong>${storeName}</strong> está lista para enviar facturas oficiales en PDF automáticamente.</p>
          <p style="font-size:12px;color:#64748b;">Remitente configurado: ${fromEmail}</p>
        </div>`
      }),
      signal: controller.signal
    }).finally(() => clearTimeout(timeout));
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { success: false, status: response.status, error: data.message || `Error HTTP ${response.status} de Resend` };
    }
    return { success: true, emailId: data.id, recipient: toEmail.trim() };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = {
  buildPdfInvoiceBuffer,
  buildInvoiceEmailHtml,
  sendInvoiceEmail,
  sendTestEmail
};
