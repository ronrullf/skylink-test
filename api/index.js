const os = require('os');
const crypto = require('crypto');
const querystring = require('querystring');
const https = require('https');
const http = require('http');
const { request: fetchSkylinkPay, paymentFromResponse } = require('../lib/skylink');
const { normalizePhone, sendInvoiceWhatsApp, sendTestWhatsApp } = require('../lib/whatsapp');
const { sendInvoiceEmail, sendTestEmail } = require('../lib/email');
const {
  ADMIN_COOKIE_NAME,
  normalizeCedula,
  createAdminToken,
  verifyAdminToken,
  verifyAdminPassword,
  extractAdminTokenFromReq
} = require('../lib/crypto');
const db = require('../lib/db');

// Tasa oficial referencial BCV (Bolívares por Dólar) - Integración con DolarAPI Venezuela (https://dolarapi.com/docs/venezuela/)
let bcvRate = 37.50;
let bcvMetadata = {
  provider: 'DolarAPI Venezuela (BCV Oficial)',
  sourceUrl: 'https://ve.dolarapi.com/v1/dolares/oficial',
  lastFetchedAt: null,
  fechaActualizacion: null
};

async function fetchLiveBcvRate(force = false) {
  const CACHE_MS = 10 * 60 * 1000; // 10 minutos de caché
  const now = Date.now();
  if (!force && bcvMetadata.lastFetchedAt && (now - bcvMetadata.lastFetchedAt < CACHE_MS)) {
    return bcvRate;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4500);
    const res = await fetch('https://ve.dolarapi.com/v1/dolares/oficial', {
      headers: { 'Accept': 'application/json' },
      signal: controller.signal
    }).finally(() => clearTimeout(timeout));

    if (res.ok) {
      const data = await res.json();
      const liveRate = Number(data.promedio || data.price || data.valor);
      if (Number.isFinite(liveRate) && liveRate > 0) {
        bcvRate = Number(liveRate.toFixed(4));
        bcvMetadata.lastFetchedAt = now;
        bcvMetadata.fechaActualizacion = data.fechaActualizacion || new Date().toISOString();
        console.log(`[DolarAPI] Tasa oficial BCV actualizada en vivo: Bs. ${bcvRate}/$ (Actualización: ${bcvMetadata.fechaActualizacion})`);
      }
    }
  } catch (err) {
    console.warn(`[DolarAPI] No se pudo obtener tasa en vivo (${err.message}). Utilizando tasa configurada: Bs. ${bcvRate}`);
  }
  return bcvRate;
}

// En ejecución en vivo, sincronizar al arrancar; en tests, iniciar almacén limpio
const isTestEnv = process.env.NODE_ENV === 'test' || Boolean(process.env.NODE_TEST_CONTEXT) || process.execArgv.includes('--test');
if (isTestEnv) {
  db.resetMemoryStore();
} else {
  fetchLiveBcvRate().catch(() => {});
}

// Logs de webhooks en memoria (diagnóstico)
const webhookLogs = [];

async function getEffectiveBcvRate(settings = null) {
  const s = settings || await db.getStoreSettings();
  if (s && s.bcvMode === 'manual' && Number(s.manualBcvRate) > 0) {
    return Number(s.manualBcvRate);
  }
  return bcvRate;
}

function buildSkylinkOverride(settings) {
  if (!settings) return null;
  return {
    apiKey: settings.skylinkApiKey || process.env.SKYLINK_API_KEY || '',
    commerceCode: settings.skylinkCommerceCode || process.env.SKYLINK_COMMERCE_CODE || '',
    baseUrl: settings.skylinkBaseUrl || process.env.SKYLINK_BASE_URL || 'https://dev-axis-payment.valinkgroup.com'
  };
}

function isAdminAuthenticated(req) {
  const token = extractAdminTokenFromReq(req);
  return verifyAdminToken(token);
}

function requireAdmin(req, res) {
  if (isAdminAuthenticated(req)) return true;
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    success: false,
    code: 'ADMIN_AUTH_REQUIRED',
    message: 'Sesión de administrador requerida. Inicia sesión en /admin.'
  }));
  return false;
}

function formatProductForClient(p, effectiveRate, pricingMode) {
  let effectivePriceBs = Number(p.priceBs || 0);
  let effectivePriceUsd = Number(p.priceUsd || 0);
  if (pricingMode === 'usd_bcv' && effectivePriceUsd > 0 && effectiveRate > 0) {
    effectivePriceBs = Number((effectivePriceUsd * effectiveRate).toFixed(2));
  } else if (effectivePriceBs > 0 && effectiveRate > 0) {
    effectivePriceUsd = Number((effectivePriceBs / effectiveRate).toFixed(2));
  }
  return {
    ...p,
    code: p.code || p.barcode || '',
    barcode: p.barcode || p.code || '',
    priceBs: effectivePriceBs,
    priceUsd: effectivePriceUsd,
    bcvRate: effectiveRate
  };
}

async function indexPayment(record) {
  return await db.saveOrder(record);
}

async function refreshPaymentStatus(record, settings = null) {
  if (!record || !record.token || record.status !== 'pending') {
    return { record, claimedPaid: false };
  }

  const s = settings || await db.getStoreSettings();
  const skylinkOverride = buildSkylinkOverride(s);
  const result = await fetchSkylinkPay(`/api/v1/merchant/transactions/token/${record.token}`, 'GET', null, skylinkOverride);
  if (!result.ok || !result.data) return { record, claimedPaid: false };

  const transaction = result.data.data || result.data;
  const upstreamStatus = String(transaction.status || '').toUpperCase();
  const resultCode = String(transaction.resultCode || transaction.result_code || '').toUpperCase();
  const isApproved =
    ['AUTHORIZED', 'PAID', 'SUCCESS', 'APPROVED', 'COMPLETED'].includes(upstreamStatus) ||
    resultCode === 'APPROVED';

  if (isApproved) {
    const reference =
      transaction.bankReference ||
      transaction.bank_reference ||
      transaction.reference ||
      transaction.authorizationCode ||
      record.reference ||
      '';
    const paymentMethod = transaction.paymentMethod || transaction.payment_method || record.paymentMethod || 'Skylink Pay';
    const paidAt = transaction.paidAt || transaction.paid_at || transaction.transactionDate || new Date().toISOString();

    const claimedPaid = await db.claimPendingOrderAsPaid(record.orderId || record.identifier, {
      reference,
      paymentMethod,
      paidAt
    });

    record.status = 'paid';
    record.reference = reference;
    record.paymentMethod = paymentMethod;
    record.paidAt = paidAt;
    return { record, claimedPaid };
  } else if (['FAILED', 'REJECTED', 'CANCELLED', 'EXPIRED'].includes(upstreamStatus)) {
    record.status = 'failed';
    await db.saveOrder(record);
  }
  return { record, claimedPaid: false };
}

/**
 * Sincroniza el estado de una orden con Skylink y despacha WhatsApp + Correo PDF EN PARALELO
 * apenas el pago queda confirmado (reclamo atómico: imposible enviar duplicados entre lambdas).
 */
async function syncAndDispatchOrder(order, hostUrl = '', settings = null) {
  if (!order) return order;
  const s = settings || await db.getStoreSettings();
  const previousStatus = order.status;
  let claimedPaid = false;

  try {
    const refreshed = await refreshPaymentStatus(order, s);
    claimedPaid = Boolean(refreshed && refreshed.claimedPaid);
  } catch (e) {}

  const isPaid = order.status === 'paid';
  let mutated = previousStatus !== order.status;

  if (claimedPaid) {
    dispatchOutboundWebhook('payment.success', order, s).catch(() => {});
  }

  if (!isPaid) return order;

  // Si la orden pasó de pending -> paid pero OTRA lambda ganó el reclamo atómico, no duplicar envíos
  if (previousStatus === 'pending' && !claimedPaid) {
    const fresh = await db.getOrderByAnyKey(order.orderId || order.identifier);
    if (fresh) Object.assign(order, fresh);
    return order;
  }

  const hasDispatchedWa = Boolean(order.whatsappDispatch && (
    order.whatsappDispatch.status === 'sent' ||
    order.whatsappDispatch.provider === 'green-api' ||
    order.whatsappDispatch.provider === 'evolution-api'
  ));
  const hasDispatchedEmail = Boolean(order.emailDispatch && (
    order.emailDispatch.status === 'sent' ||
    order.emailDispatch.provider === 'resend'
  ));

  const tasks = [];

  if (!hasDispatchedWa && !order._dispatchingWhatsApp && (order.clientPhone || order.invoicePhone)) {
    order._dispatchingWhatsApp = true;
    tasks.push((async () => {
      try {
        console.log(`[SkyPay] Despachando automáticamente comprobante WhatsApp para orden ${order.orderId || order.identifier}...`);
        order.whatsappDispatch = await sendInvoiceWhatsApp(order, { baseUrl: hostUrl, settings: s });
        mutated = true;
      } catch (waErr) {
        console.error(`[SkyPay] Error en despacho WhatsApp orden ${order.orderId}:`, waErr.message);
        order.whatsappDispatch = { success: false, error: waErr.message };
        mutated = true;
      } finally {
        delete order._dispatchingWhatsApp;
      }
    })());
  }

  if (!hasDispatchedEmail && !order._dispatchingEmail && (order.clientEmail || order.invoiceEmail)) {
    order._dispatchingEmail = true;
    tasks.push((async () => {
      try {
        console.log(`[SkyPay] Despachando automáticamente factura PDF por correo (Resend) para orden ${order.orderId || order.identifier}...`);
        order.emailDispatch = await sendInvoiceEmail(order, { baseUrl: hostUrl, settings: s });
        mutated = true;
      } catch (mailErr) {
        console.error(`[SkyPay] Error en despacho Email orden ${order.orderId}:`, mailErr.message);
        order.emailDispatch = { success: false, error: mailErr.message };
        mutated = true;
      } finally {
        delete order._dispatchingEmail;
      }
    })());
  }

  if (tasks.length > 0) {
    await Promise.all(tasks);
  }

  if (mutated) {
    await db.saveOrder(order);
  }

  return order;
}

/**
 * Barre todas las órdenes pendientes recientes en Supabase y despacha facturas de las ya pagadas,
 * incluso si el comprador cerró su navegador o no volvió a la pestaña tras pagar en Skylink.
 */
async function syncAllPendingOrders(hostUrl = '') {
  const pending = await db.listPendingOrders(45, 10);
  if (!pending || pending.length === 0) return { checked: 0, paidNow: [] };
  const settings = await db.getStoreSettings();
  const paidNow = [];
  await Promise.all(pending.map(async (ord) => {
    const before = ord.status;
    await syncAndDispatchOrder(ord, hostUrl, settings);
    if (before !== 'paid' && ord.status === 'paid') {
      paidNow.push(ord.orderId || ord.identifier);
    }
  }));
  return { checked: pending.length, paidNow };
}

// Helper para calcular precio USD en base a Bs
function getProductPriceUsd(priceBs, rate = bcvRate) {
  return Number((priceBs / (rate || 37.50)).toFixed(2));
}

// Helper para convertir monto en Bs a céntimos enteros (Skylink Pay)
function toCentimos(amountBs) {
  const value = Math.round(Number(amountBs) * 100);
  if (!Number.isSafeInteger(value) || value <= 0) {
    const error = new Error('El monto debe ser positivo y expresarse en céntimos válidos.');
    error.httpStatus = 400;
    throw error;
  }
  return value;
}

// Despacho de Webhook saliente cuando se confirma un pago
async function dispatchOutboundWebhook(event, data, settings = null) {
  const s = settings || await db.getStoreSettings();
  if (!s.webhookUrl) return;
  try {
    const payload = JSON.stringify({
      event,
      timestamp: new Date().toISOString(),
      data
    });

    const parsed = new URL(s.webhookUrl);
    const client = parsed.protocol === 'https:' ? https : http;

    const signature = crypto.createHmac('sha256', s.webhookSecret || '')
      .update(payload)
      .digest('hex');

    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'X-SkyPay-Signature': signature,
        'X-SkyPay-Event': event
      },
      timeout: 6000
    };

    const req = client.request(parsed, options, (res) => {
      let resBody = '';
      res.on('data', c => resBody += c);
      res.on('end', () => {
        webhookLogs.unshift({
          type: 'outbound',
          url: s.webhookUrl,
          event,
          statusCode: res.statusCode,
          timestamp: new Date().toISOString(),
          success: res.statusCode >= 200 && res.statusCode < 300,
          response: resBody.slice(0, 300)
        });
      });
    });

    req.on('error', (err) => {
      webhookLogs.unshift({
        type: 'outbound',
        url: s.webhookUrl,
        event,
        statusCode: 500,
        timestamp: new Date().toISOString(),
        success: false,
        error: err.message
      });
    });

    req.write(payload);
    req.end();
  } catch (e) {}
}

async function parseOrderFromMessage(text) {
  const normalized = (text || '').toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const foundItems = [];
  const settings = await db.getStoreSettings();
  const effectiveRate = await getEffectiveBcvRate(settings);
  const catalog = (await db.listProducts()).map(p => formatProductForClient(p, effectiveRate, settings.pricingMode));

  for (const prod of catalog) {
    const keywords = Array.isArray(prod.keywords) && prod.keywords.length > 0 ? prod.keywords : [prod.name.toLowerCase()];
    let matched = false;
    for (const kw of keywords) {
      if (kw && normalized.includes(kw)) {
        matched = true;
        break;
      }
    }
    if (matched) {
      let qty = 1;
      const kwPattern = keywords.filter(Boolean).join('|');
      const matchBefore = kwPattern ? normalized.match(new RegExp(`(\\d+)\\s*(?:kilos?|paquetes?|unidades?|kg)?\\s*(?:de\\s*)?(?:${kwPattern})`)) : null;
      const matchAfter = kwPattern ? normalized.match(new RegExp(`(?:${kwPattern})\\s*(?:x\\s*)?(\\d+)`)) : null;
      if (matchBefore && matchBefore[1]) {
        qty = parseInt(matchBefore[1], 10);
      } else if (matchAfter && matchAfter[1]) {
        qty = parseInt(matchAfter[1], 10);
      } else if (normalized.includes('dos ' + keywords[0]) || normalized.includes('2 ' + keywords[0])) {
        qty = 2;
      } else if (normalized.includes('tres ' + keywords[0]) || normalized.includes('3 ' + keywords[0])) {
        qty = 3;
      }
      foundItems.push({
        id: prod.id,
        name: prod.name,
        code: prod.code,
        priceBs: prod.priceBs,
        price: getProductPriceUsd(prod.priceBs, effectiveRate),
        qty: qty,
        icon: prod.icon
      });
    }
  }

  return foundItems;
}

function getRequestBody(req) {
  return new Promise((resolve) => {
    if (req.body !== undefined && req.body !== null) {
      if (typeof req.body === 'string') {
        try { return resolve(JSON.parse(req.body)); } catch (e) { return resolve({}); }
      }
      return resolve(req.body || {});
    }

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch (e) {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

async function handleApi(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Key, X-Commerce-Code, X-Timestamp, X-Signature, X-Webhook-Secret');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  try {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let pathname = parsedUrl.pathname;
    const routeParam = parsedUrl.searchParams.get('route');
    if (routeParam) {
      pathname = '/api/' + routeParam;
    }

    // ==========================================
    // 0. AUTENTICACIÓN ADMIN (Panel Comercial)
    // ==========================================
    if (pathname === '/api/admin/session' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        success: true,
        authenticated: isAdminAuthenticated(req),
        supabaseConnected: db.isSupabaseEnabled()
      }));
    }

    if (pathname === '/api/admin/login' && req.method === 'POST') {
      const payload = await getRequestBody(req);
      const email = String(payload.email || '').trim();
      const password = String(payload.password || payload.pin || '').trim();
      let authorized = false;
      let adminUser = null;
      let failMessage = 'Correo o contraseña de administrador incorrectos.';

      // 1. Si el usuario ingresó correo y Supabase está conectado, autenticar con Supabase Auth
      if (email && db.isSupabaseEnabled()) {
        const supaAuth = await db.verifySupabaseAuthAdmin(email, password);
        if (supaAuth.ok) {
          authorized = true;
          adminUser = supaAuth.user;
        } else {
          failMessage = supaAuth.reason || failMessage;
        }
      }

      // 2. Respaldo con ADMIN_PASSWORD (si no ingresó correo o para entornos sin Supabase)
      if (!authorized && !email && verifyAdminPassword(password)) {
        authorized = true;
      }

      if (!authorized) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: false,
          message: failMessage
        }));
      }
      const token = createAdminToken();
      const isHttps = (req.headers['x-forwarded-proto'] || '').includes('https');
      const cookieFlags = `HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${isHttps ? '; Secure' : ''}`;
      res.setHeader('Set-Cookie', `${ADMIN_COOKIE_NAME}=${encodeURIComponent(token)}; ${cookieFlags}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        success: true,
        authenticated: true,
        user: adminUser,
        token
      }));
    }

    if (pathname === '/api/admin/logout' && req.method === 'POST') {
      res.setHeader('Set-Cookie', `${ADMIN_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, authenticated: false }));
    }

    // ==========================================
    // 0.1 CONFIGURACIÓN PÚBLICA (White-Label sin secretos)
    // ==========================================
    if (pathname === '/api/public-config' && req.method === 'GET') {
      const settings = await db.getStoreSettings();
      if (!isTestEnv && settings.bcvMode !== 'manual') {
        try { await fetchLiveBcvRate(false); } catch (e) {}
      }
      const effectiveRate = await getEffectiveBcvRate(settings);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        success: true,
        data: {
          ...db.getPublicStoreSettingsFrom(settings),
          bcvRate: effectiveRate
        }
      }));
    }

    // ==========================================
    // 0.2 CONFIGURACIÓN ADMIN (Empresa, Skylink, WhatsApp, Resend)
    // ==========================================
    if (pathname === '/api/admin/settings' && req.method === 'GET') {
      if (!requireAdmin(req, res)) return;
      const settings = await db.getStoreSettings(true);
      const effectiveRate = await getEffectiveBcvRate(settings);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        success: true,
        data: {
          ...db.getMaskedAdminSettingsFrom(settings),
          bcvRate: effectiveRate
        }
      }));
    }

    if (pathname === '/api/admin/settings' && (req.method === 'PUT' || req.method === 'POST')) {
      if (!requireAdmin(req, res)) return;
      const payload = await getRequestBody(req);
      const saved = await db.saveStoreSettings(payload);
      if (saved.bcvMode === 'manual' && saved.manualBcvRate > 0) {
        bcvRate = saved.manualBcvRate;
      }
      const effectiveRate = await getEffectiveBcvRate(saved);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        success: true,
        message: 'Configuración guardada correctamente.',
        data: {
          ...db.getMaskedAdminSettingsFrom(saved),
          bcvRate: effectiveRate
        }
      }));
    }

    // ==========================================
    // 0.3 DIAGNÓSTICOS EN VIVO (WhatsApp / Resend / Skylink)
    // ==========================================
    if (pathname === '/api/admin/test-whatsapp' && req.method === 'POST') {
      if (!requireAdmin(req, res)) return;
      const payload = await getRequestBody(req);
      const settings = await db.getStoreSettings(true);
      const phone = payload.phone || settings.storePhone;
      const result = await sendTestWhatsApp(phone, settings);
      res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        success: Boolean(result.success),
        message: result.success
          ? `Mensaje de prueba enviado por ${result.provider || settings.whatsappProvider}.`
          : (result.error || result.reason || 'No se pudo enviar el WhatsApp de prueba.'),
        data: result
      }));
    }

    if (pathname === '/api/admin/test-email' && req.method === 'POST') {
      if (!requireAdmin(req, res)) return;
      const payload = await getRequestBody(req);
      const settings = await db.getStoreSettings(true);
      const result = await sendTestEmail(payload.email, settings);
      res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        success: Boolean(result.success),
        message: result.success
          ? `Correo de prueba enviado a ${result.recipient} (ID: ${result.emailId}).`
          : (result.error || 'No se pudo enviar el correo de prueba.'),
        data: result
      }));
    }

    if (pathname === '/api/admin/test-skylink' && req.method === 'POST') {
      if (!requireAdmin(req, res)) return;
      const settings = await db.getStoreSettings(true);
      const override = buildSkylinkOverride(settings);
      const testRes = await fetchSkylinkPay('/api/v1/merchant/transactions/token/test-connection-check', 'GET', null, override);
      // 200 o 404 significa que la firma HMAC y credenciales fueron aceptadas por Skylink (401/500 = error)
      const connected = testRes.ok || testRes.status === 404;
      res.writeHead(connected ? 200 : 400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        success: connected,
        message: connected
          ? `Conexión y firma HMAC verificadas con Skylink (${override.baseUrl}).`
          : (testRes.error || testRes.data?.message || `Skylink devolvió HTTP ${testRes.status}. Revisa Commerce Code y API Key.`),
        status: testRes.status
      }));
    }

    // ==========================================
    // 0.4 CRM CLIENTES: CÉDULA EXPRESS (Onboarding 1 sola vez)
    // ==========================================
    if (pathname.startsWith('/api/customers/by-cedula/') && req.method === 'GET') {
      const rawCedula = decodeURIComponent(pathname.split('/api/customers/by-cedula/')[1] || '');
      const normalized = normalizeCedula(rawCedula);
      if (!normalized) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: false,
          found: false,
          message: 'Formato de cédula o RIF inválido (ej: V-12345678).'
        }));
      }
      const customer = await db.findCustomerByCedula(normalized);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        success: true,
        found: Boolean(customer),
        cedula: normalized,
        customer: customer ? {
          cedula: customer.cedula,
          fullName: customer.fullName,
          email: customer.email,
          phone: customer.phone,
          ordersCount: customer.ordersCount
        } : null
      }));
    }

    if (pathname === '/api/admin/customers' && req.method === 'GET') {
      if (!requireAdmin(req, res)) return;
      const customers = await db.listCustomers(300);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, data: customers }));
    }

    // ==========================================
    // 1. TASA OFICIAL BCV (DolarAPI Venezuela)
    // ==========================================
    if (pathname === '/api/bcv-rate' && req.method === 'GET') {
      const settings = await db.getStoreSettings();
      if ((!isTestEnv || parsedUrl.searchParams.get('sync') === '1') && settings.bcvMode !== 'manual') {
        try { await fetchLiveBcvRate(parsedUrl.searchParams.get('force') === '1'); } catch (e) {}
      }
      const effectiveRate = await getEffectiveBcvRate(settings);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        success: true,
        rate: effectiveRate,
        bcvMode: settings.bcvMode,
        provider: settings.bcvMode === 'manual' ? 'Tasa Manual Configurada' : bcvMetadata.provider,
        source: bcvMetadata.sourceUrl,
        lastSync: bcvMetadata.lastFetchedAt ? new Date(bcvMetadata.lastFetchedAt).toISOString() : null,
        fechaActualizacion: bcvMetadata.fechaActualizacion
      }));
    }
    if (pathname === '/api/bcv-rate' && req.method === 'POST') {
      const payload = await getRequestBody(req);
      const rate = Number(payload.rate);
      if (!Number.isFinite(rate) || rate <= 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, message: 'La tasa debe ser un número mayor a cero.' }));
      }
      bcvRate = rate;
      await db.saveStoreSettings({ manualBcvRate: rate, bcvMode: payload.bcvMode || 'manual' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, rate: bcvRate }));
    }

    // ==========================================
    // 2. CONFIGURACIÓN DE LA TIENDA (Compatibilidad segura, sin llaves)
    // ==========================================
    if (pathname === '/api/store-settings' && req.method === 'GET') {
      const settings = await db.getStoreSettings();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        success: true,
        data: {
          ...db.getPublicStoreSettingsFrom(settings),
          skylinkCommerceCode: settings.skylinkCommerceCode,
          skylinkBaseUrl: settings.skylinkBaseUrl,
          webhookUrl: settings.webhookUrl,
          webhookSecret: settings.webhookSecret
        }
      }));
    }
    if (pathname === '/api/store-settings' && req.method === 'POST') {
      if (!isTestEnv && !requireAdmin(req, res)) return;
      const payload = await getRequestBody(req);
      const saved = await db.saveStoreSettings({
        storePhone: payload.storePhone,
        storeName: payload.storeName,
        storeRif: payload.storeRif,
        storeAddress: payload.storeAddress,
        storeCity: payload.storeCity,
        invoiceFooter: payload.invoiceFooter,
        webhookUrl: payload.webhookUrl,
        webhookSecret: payload.webhookSecret
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, data: db.getPublicStoreSettingsFrom(saved) }));
    }

    // ==========================================
    // 3. GESTIÓN DEL CATÁLOGO DE PRODUCTOS (Supabase + Escáner)
    // ==========================================
    if (pathname === '/api/products' && req.method === 'GET') {
      const settings = await db.getStoreSettings();
      const effectiveRate = await getEffectiveBcvRate(settings);
      const rawProducts = await db.listProducts(parsedUrl.searchParams.get('all') === '1');
      const formatted = rawProducts.map(p => formatProductForClient(p, effectiveRate, settings.pricingMode));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        success: true,
        data: formatted,
        bcvRate: effectiveRate,
        pricingMode: settings.pricingMode
      }));
    }

    if (pathname === '/api/products/import' && req.method === 'POST') {
      if (!requireAdmin(req, res)) return;
      const payload = await getRequestBody(req);
      const items = Array.isArray(payload.items) ? payload.items : [];
      if (items.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, message: 'No se recibieron productos válidos para importar.' }));
      }
      const settings = await db.getStoreSettings();
      const effectiveRate = await getEffectiveBcvRate(settings);
      const imported = await db.bulkUpsertProducts(items, effectiveRate);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        success: true,
        count: imported.length,
        data: imported.map(p => formatProductForClient(p, effectiveRate, settings.pricingMode))
      }));
    }

    if (pathname === '/api/products' && req.method === 'POST') {
      const payload = await getRequestBody(req);
      const name = (payload.name || '').trim();
      const settings = await db.getStoreSettings();
      const effectiveRate = await getEffectiveBcvRate(settings);
      // Precio predeterminado aleatorio si no se especifica ni Bs ni USD (ej: entre 18 y 33 Bs)
      const randomDefault = Number((Math.floor(Math.random() * 15 + 18) + (Math.random() < 0.5 ? 0 : 0.5)).toFixed(2));
      const hasBs = payload.priceBs != null && Number(payload.priceBs) > 0;
      const hasBsSnake = payload.price_bs != null && Number(payload.price_bs) > 0;
      const hasUsd = payload.priceUsd != null && Number(payload.priceUsd) > 0;
      const hasUsdSnake = payload.price_usd != null && Number(payload.price_usd) > 0;
      const priceBs = hasBs ? Number(payload.priceBs) : (hasBsSnake ? Number(payload.price_bs) : (hasUsd || hasUsdSnake ? 0 : randomDefault));
      const priceUsd = hasUsd ? Number(payload.priceUsd) : (hasUsdSnake ? Number(payload.price_usd) : 0);

      if (!name) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, message: 'El nombre del producto es obligatorio.' }));
      }

      const { product, updated } = await db.createOrUpdateProduct({
        name,
        code: payload.code || payload.barcode,
        priceBs,
        priceUsd,
        category: payload.category || 'Víveres',
        icon: payload.icon || '📦'
      }, effectiveRate);

      res.writeHead(updated ? 200 : 201, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        success: true,
        data: formatProductForClient(product, effectiveRate, settings.pricingMode),
        updated
      }));
    }

    if (pathname.startsWith('/api/products/') && req.method === 'PUT') {
      if (!requireAdmin(req, res)) return;
      const id = pathname.split('/api/products/')[1];
      const payload = await getRequestBody(req);
      const settings = await db.getStoreSettings();
      const effectiveRate = await getEffectiveBcvRate(settings);
      const updated = await db.updateProduct(id, payload, effectiveRate);
      if (!updated) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, message: 'Producto no encontrado.' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        success: true,
        data: formatProductForClient(updated, effectiveRate, settings.pricingMode)
      }));
    }

    if (pathname.startsWith('/api/products/') && req.method === 'DELETE') {
      if (!requireAdmin(req, res)) return;
      const id = pathname.split('/api/products/')[1];
      await db.deleteProduct(id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, message: 'Producto eliminado correctamente.' }));
    }

    // ==========================================
    // 4. GENERADOR AUTOMÁTICO DE LINKS DE PAGO
    //    Permite insertar montos en Bolívares o USD
    // ==========================================
    if ((pathname === '/api/generate-link' || pathname === '/api/v1/links/generate' || pathname === '/api/create-order-link') && req.method === 'POST') {
      const payload = await getRequestBody(req);
      const settings = await db.getStoreSettings();
      const effectiveRate = await getEffectiveBcvRate(settings);

      // Determinación del monto exacto en Bolívares
      let amountBs = 0;
      if (payload.amount_bs != null) {
        amountBs = Number(payload.amount_bs);
      } else if (payload.amountBs != null) {
        amountBs = Number(payload.amountBs);
      } else if (payload.amount != null) {
        // Si no se especifica si es Bs o USD, revisamos currency
        if (payload.currency === 'USD' || payload.currency === 'usd') {
          amountBs = Number((Number(payload.amount) * effectiveRate).toFixed(2));
        } else if (payload.currency === 'VES' || payload.currency === 'ves') {
          amountBs = Number(payload.amount);
        } else {
          // Asumir USD si es menor a 15, de lo contrario Bs
          amountBs = Number(payload.amount) < 15 ? Number((Number(payload.amount) * effectiveRate).toFixed(2)) : Number(payload.amount);
        }
      } else if (Array.isArray(payload.items) && payload.items.length > 0) {
        // Calcular sumatoria de items del catálogo
        const catalog = (await db.listProducts()).map(p => formatProductForClient(p, effectiveRate, settings.pricingMode));
        amountBs = payload.items.reduce((sum, it) => {
          const prod = catalog.find(p => Number(p.id) === Number(it.id) || (it.code && p.code === it.code));
          const itemPriceBs = prod ? prod.priceBs : (it.priceBs || (it.price ? it.price * effectiveRate : 25));
          return sum + (itemPriceBs * (it.qty || it.quantity || 1));
        }, 0);
      }

      amountBs = Number(amountBs.toFixed(2));
      if (!Number.isFinite(amountBs) || amountBs <= 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, message: 'Ingresa un monto válido mayor a 0 Bs.' }));
      }

      const amountCentimos = toCentimos(amountBs);
      const amountUsd = Number((amountBs / effectiveRate).toFixed(2));
      const description = payload.description || payload.concept || 'Pago en línea con Skylink Pay';
      const clientName = payload.client_name || payload.clientName || 'Cliente';
      const clientPhone = payload.client_phone || payload.clientPhone || '';
      const orderId = 'LNK-' + crypto.randomUUID().slice(0, 8).toUpperCase();
      const sessionId = 'SES-' + Date.now();
      const skylinkOverride = buildSkylinkOverride(settings);

      // Llamada oficial y real a Skylink Pay API (Valink Group)
      const skylinkRes = await fetchSkylinkPay('/api/v1/merchant/transactions', 'POST', {
        buyOrder: orderId,
        sessionId: sessionId,
        amount: amountCentimos,
        currency: 'VES',
        installments: 1
      }, skylinkOverride);

      const { token, skylinkPayUrl } = paymentFromResponse(skylinkRes, skylinkOverride);
      const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&margin=10&data=${encodeURIComponent(skylinkPayUrl)}`;

      // Plantilla para compartir directo en WhatsApp
      let phoneClean = clientPhone.replace(/\D/g, '');
      if (phoneClean.startsWith('0')) phoneClean = '58' + phoneClean.slice(1);
      const waMsg = `¡Hola ${clientName}! 👋 Tu link de pago de *${settings.storeName}* está listo:\n\n` +
        `📝 *Concepto:* ${description}\n` +
        `💵 *Monto:* Bs. ${amountBs.toFixed(2)} (≈ $${amountUsd.toFixed(2)} USD)\n\n` +
        `💳 *Paga aquí en Skylink Pay:* ${skylinkPayUrl}\n\n` +
        `_(Acepta Pago Móvil C2P y Débito Inmediato)_. Al confirmar tu pago coordinaremos de inmediato. 🚀`;
      const whatsappUrl = phoneClean
        ? `https://wa.me/${phoneClean}?text=${encodeURIComponent(waMsg)}`
        : `https://wa.me/?text=${encodeURIComponent(waMsg)}`;

      const orderData = {
        orderId,
        identifier: orderId,
        sessionId,
        token,
        amount: amountUsd,
        amountBs,
        amountVes: amountBs,
        amountCentimos,
        bcvRate: effectiveRate,
        description,
        clientName,
        clientPhone,
        storeName: settings.storeName,
        storeRif: settings.storeRif,
        storeAddress: settings.storeAddress,
        storeCity: settings.storeCity,
        storePhone: settings.storePhone,
        invoiceFooter: settings.invoiceFooter,
        paymentUrl: skylinkPayUrl,
        skylinkUrl: skylinkPayUrl,
        qrCodeUrl,
        whatsappUrl,
        status: 'pending',
        shippingData: null,
        items: payload.items || [],
        source: payload.source || 'link_generator',
        createdAt: new Date().toISOString()
      };

      await indexPayment(orderData);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        success: true,
        orderId,
        token,
        url: skylinkPayUrl,
        paymentUrl: skylinkPayUrl,
        skylinkUrl: skylinkPayUrl,
        qrCodeUrl,
        whatsappUrl,
        amountBs,
        amountCentimos,
        amountUsd,
        bcvRate: effectiveRate,
        description,
        data: orderData
      }));
    }

    // ==========================================
    // 5. WEBHOOKS DE APLICACIONES EXTERNAS
    //    Permite que otras apps creen pagos o notifiquen
    // ==========================================
    if (pathname === '/api/webhooks/incoming' && req.method === 'POST') {
      const payload = await getRequestBody(req);
      const settings = await db.getStoreSettings();
      const effectiveRate = await getEffectiveBcvRate(settings);

      // Registrar log del webhook entrante
      const logEntry = {
        id: 'WH-' + crypto.randomUUID().slice(0, 8),
        type: 'incoming',
        ip: req.socket.remoteAddress,
        headers: req.headers,
        body: payload,
        timestamp: new Date().toISOString(),
        success: true
      };

      // Si el webhook externo solicita crear un cobro automáticamente
      if (payload.action === 'create_payment_link' || payload.event === 'order.created') {
        const amountBs = Number(payload.amount_bs || payload.amountBs || (payload.amount ? Number(payload.amount) * effectiveRate : 25));
        const amountCentimos = toCentimos(amountBs);
        const orderId = 'EXT-' + crypto.randomUUID().slice(0, 8).toUpperCase();
        const sessionId = 'SES-' + Date.now();
        const skylinkOverride = buildSkylinkOverride(settings);

        const skylinkRes = await fetchSkylinkPay('/api/v1/merchant/transactions', 'POST', {
          buyOrder: orderId,
          sessionId: sessionId,
          amount: amountCentimos,
          currency: 'VES',
          installments: 1
        }, skylinkOverride);

        const { token, skylinkPayUrl } = paymentFromResponse(skylinkRes, skylinkOverride);
        const orderData = {
          orderId,
          identifier: orderId,
          sessionId,
          token,
          amount: Number((amountBs / effectiveRate).toFixed(2)),
          amountBs,
          amountVes: amountBs,
          amountCentimos,
          bcvRate: effectiveRate,
          description: payload.description || payload.concept || 'Cobro externo vía Webhook',
          clientName: payload.client_name || payload.customer_name || 'Cliente Externo',
          clientPhone: payload.client_phone || '',
          storeName: settings.storeName,
          storeRif: settings.storeRif,
          storeAddress: settings.storeAddress,
          storeCity: settings.storeCity,
          storePhone: settings.storePhone,
          invoiceFooter: settings.invoiceFooter,
          paymentUrl: skylinkPayUrl,
          skylinkUrl: skylinkPayUrl,
          status: 'pending',
          source: 'external_webhook',
          createdAt: new Date().toISOString()
        };

        await indexPayment(orderData);

        logEntry.createdOrder = orderId;
        logEntry.paymentUrl = skylinkPayUrl;
        webhookLogs.unshift(logEntry);

        res.writeHead(201, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          message: 'Link de pago generado con éxito mediante Webhook',
          orderId,
          paymentUrl: skylinkPayUrl,
          token,
          amountBs
        }));
      }

      webhookLogs.unshift(logEntry);
      if (webhookLogs.length > 50) webhookLogs.pop();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        success: true,
        message: 'Webhook recibido y procesado correctamente',
        receivedAt: logEntry.timestamp
      }));
    }

    // ==========================================
    // 6. WEBHOOK DE RETORNO / CALLBACK SKYLINK PAY
    // ==========================================
    if (pathname === '/api/webhooks/skylink' && req.method === 'POST') {
      const payload = await getRequestBody(req);
      const token = payload.token || (payload.data && payload.data.token);
      const status = payload.status || (payload.data && payload.data.status);
      const reference = payload.reference || payload.authorizationCode;

      if (token) {
        const order = await db.getOrderByAnyKey(token);
        const settings = await db.getStoreSettings();
        if (order) {
          if (status === 'AUTHORIZED' || status === 'paid' || status === 'SUCCESS') {
            order.status = 'paid';
            order.paidAt = order.paidAt || new Date().toISOString();
            order.reference = reference || 'SK-' + Math.floor(10000000 + Math.random() * 90000000);
            await dispatchOutboundWebhook('payment.success', order, settings);
            if (!order._dispatchingWhatsApp) {
              order._dispatchingWhatsApp = true;
              try {
                console.log(`[SkyPay Webhook] Despachando comprobante WhatsApp para orden ${order.orderId}...`);
                order.whatsappDispatch = await sendInvoiceWhatsApp(order, { settings });
              } catch (waErr) {
                console.error(`[SkyPay Webhook] Error en despacho WhatsApp orden ${order.orderId}:`, waErr.message);
                order.whatsappDispatch = { success: false, error: waErr.message };
              } finally {
                delete order._dispatchingWhatsApp;
              }
            }

            if (!order._dispatchingEmail && (order.clientEmail || order.invoiceEmail)) {
              order._dispatchingEmail = true;
              try {
                console.log(`[SkyPay Webhook] Despachando factura PDF por correo (Resend) para orden ${order.orderId}...`);
                order.emailDispatch = await sendInvoiceEmail(order, { settings });
              } catch (mailErr) {
                console.error(`[SkyPay Webhook] Error en despacho Email orden ${order.orderId}:`, mailErr.message);
                order.emailDispatch = { success: false, error: mailErr.message };
              } finally {
                delete order._dispatchingEmail;
              }
            }
            await db.saveOrder(order);
          } else if (status === 'FAILED' || status === 'REJECTED') {
            order.status = 'failed';
            await db.saveOrder(order);
            await dispatchOutboundWebhook('payment.failed', order, settings);
          }
        }
      }

      webhookLogs.unshift({
        type: 'skylink_callback',
        timestamp: new Date().toISOString(),
        body: payload,
        success: true
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, message: 'Callback de Skylink procesado' }));
    }

    // Listar logs de webhooks
    if (pathname === '/api/webhooks/logs' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, data: webhookLogs.slice(0, 30) }));
    }

    // Simular webhook de prueba
    if (pathname === '/api/webhooks/test' && req.method === 'POST') {
      const payload = await getRequestBody(req);
      const testEntry = {
        id: 'TEST-' + crypto.randomUUID().slice(0, 6),
        type: 'test_simulation',
        body: payload || { test: true, event: 'ping', time: new Date().toISOString() },
        timestamp: new Date().toISOString(),
        success: true
      };
      webhookLogs.unshift(testEntry);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, message: 'Webhook de prueba registrado', data: testEntry }));
    }

    // ==========================================
    // 7. KIOSCO AUTOPAGO (Crear Transacción Real + Guardar Cliente CRM)
    // ==========================================
    if (pathname === '/api/create-payment' && req.method === 'POST') {
      const payload = await getRequestBody(req);
      const settings = await db.getStoreSettings();
      const effectiveRate = await getEffectiveBcvRate(settings);

      const invoiceName = String(payload.invoiceName || payload.clientName || '').trim();
      const rawPhone = String(payload.invoicePhone || payload.clientPhone || payload.phone || '').trim();
      const rawInvoiceId = String(payload.invoiceId || payload.clientId || payload.cedula || '').trim();
      const invoiceEmail = String(payload.invoiceEmail || payload.clientEmail || payload.email || '').trim();

      // Validación de Nombre obligatorio (mínimo 2 letras)
      if (invoiceName.length < 2) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: false,
          message: 'El nombre es obligatorio para generar la factura.'
        }));
      }

      // Validación de Correo Electrónico obligatorio
      if (!invoiceEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(invoiceEmail)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: false,
          message: 'El correo electrónico es obligatorio (ej: tu-correo@gmail.com).'
        }));
      }

      // Validación de Teléfono / WhatsApp obligatorio (solo números, 10 a 15 dígitos)
      const cleanPhone = normalizePhone(rawPhone);
      const isDigitsOnly = /^\d+$/.test(rawPhone.replace(/[\s+-]/g, ''));
      if (!rawPhone || !isDigitsOnly || cleanPhone.length < 10 || cleanPhone.length > 15) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: false,
          message: 'El número de teléfono/WhatsApp es obligatorio (solo números, 10 a 15 dígitos).'
        }));
      }

      // Validación de Cédula o RIF obligatoria
      const normalizedCedula = normalizeCedula(rawInvoiceId);
      if (!normalizedCedula) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: false,
          message: 'La cédula o RIF es obligatoria (ej: V-12345678).'
        }));
      }
      const invoiceId = normalizedCedula;

      let amountBs = 0;

      if (Array.isArray(payload.items) && payload.items.length > 0) {
        const catalog = (await db.listProducts()).map(p => formatProductForClient(p, effectiveRate, settings.pricingMode));
        amountBs = payload.items.reduce((sum, it) => {
          const prod = catalog.find(p => Number(p.id) === Number(it.id) || (it.code && p.code === it.code));
          const pPrice = prod ? prod.priceBs : (it.priceBs || (it.price ? it.price * effectiveRate : 25));
          return sum + (pPrice * (it.qty || it.quantity || 1));
        }, 0);
      } else if (payload.amountBs != null) {
        amountBs = Number(payload.amountBs);
      } else {
        amountBs = Number(payload.amount || 1) * effectiveRate;
      }

      amountBs = Number(amountBs.toFixed(2));
      const amountCentimos = toCentimos(amountBs);
      const amountUsd = Number((amountBs / effectiveRate).toFixed(2));
      const identifier = 'AUTO-' + crypto.randomUUID().slice(0, 8).toUpperCase();
      const sessionId = 'SES-' + Date.now();
      const skylinkOverride = buildSkylinkOverride(settings);

      const reqHost = req.headers && req.headers.host ? String(req.headers.host) : '';
      const reqProto = (req.headers && req.headers['x-forwarded-proto']) || (reqHost.includes('localhost') ? 'http' : 'https');
      const publicBase = reqHost && !reqHost.includes('localhost') ? `${reqProto}://${reqHost}` : '';

      const txBody = {
        buyOrder: identifier,
        sessionId: sessionId,
        amount: amountCentimos,
        currency: 'VES',
        installments: 1
      };
      // En producción enviamos returnUrl y webhookUrl oficiales para retorno/push instantáneo
      if (!isTestEnv && publicBase) {
        txBody.returnUrl = `${publicBase}/factura?order_id=${encodeURIComponent(identifier)}&auto_download=1`;
        txBody.webhookUrl = `${publicBase}/api/webhooks/skylink`;
      }

      const skylinkRes = await fetchSkylinkPay('/api/v1/merchant/transactions', 'POST', txBody, skylinkOverride);

      const { token, skylinkPayUrl } = paymentFromResponse(skylinkRes, skylinkOverride);

      // Guardar/actualizar perfil del cliente en Supabase para futuras compras con Cédula Express
      let savedCustomer = null;
      try {
        savedCustomer = await db.upsertCustomer({
          cedula: invoiceId,
          fullName: invoiceName,
          email: invoiceEmail,
          phone: cleanPhone || rawPhone,
          incrementOrder: true
        });
      } catch (custErr) {
        console.warn('[SkyPay] No se pudo guardar perfil CRM del cliente:', custErr.message);
      }

      const sessionData = {
        identifier,
        orderId: identifier,
        sessionId,
        token,
        amount: amountUsd,
        amountBs,
        amountVes: amountBs,
        amountCentimos,
        bcvRate: effectiveRate,
        description: payload.description || 'Compra Kiosco Skylink Pay',
        items: payload.items || [],
        customerId: savedCustomer?.id || null,
        clientName: invoiceName,
        clientId: invoiceId,
        clientPhone: cleanPhone || '',
        invoicePhone: cleanPhone || rawPhone || '',
        clientEmail: invoiceEmail,
        invoiceEmail: invoiceEmail,
        invoice: {
          required: true,
          name: invoiceName,
          idNumber: invoiceId,
          phone: cleanPhone || rawPhone || '',
          email: invoiceEmail
        },
        storePhone: settings.storePhone,
        storeName: settings.storeName,
        storeRif: settings.storeRif,
        storeAddress: settings.storeAddress,
        storeCity: settings.storeCity,
        invoiceFooter: settings.invoiceFooter,
        paymentUrl: skylinkPayUrl,
        payment_url: skylinkPayUrl,
        skylink_url: skylinkPayUrl,
        source: 'kiosk',
        status: 'pending',
        createdAt: new Date().toISOString()
      };

      await indexPayment(sessionData);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        success: true,
        data: sessionData,
        token,
        payment_url: skylinkPayUrl,
        payment_qr: `https://api.qrserver.com/v1/create-qr-code/?size=300x300&margin=10&data=${encodeURIComponent(skylinkPayUrl)}`,
        skylink_url: skylinkPayUrl,
        amountCentimos,
        amountBs,
        amountUsd
      }));
    }

    // ==========================================
    // 8. VIGILANTE ACTIVO EN SERVIDOR (DESPACHO INSTANTÁNEO < 2s SIN DEPENDER DEL NAVEGADOR)
    // ==========================================
    if (pathname.startsWith('/api/watch-payment/') && (req.method === 'POST' || req.method === 'GET')) {
      const id = decodeURIComponent(pathname.split('/api/watch-payment/')[1] || '').trim();
      const round = Math.max(1, Math.min(5, parseInt(parsedUrl.searchParams.get('round') || '1', 10) || 1));
      const order = await db.getOrderByAnyKey(id);

      if (!order) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, message: 'Orden no encontrada' }));
      }

      // Seguridad: solo vigilar órdenes creadas en los últimos 10 minutos
      const ageMs = Date.now() - new Date(order.createdAt || Date.now()).getTime();
      if (ageMs > 10 * 60 * 1000 && order.status === 'pending') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, status: order.status, stopped: 'expired_window' }));
      }

      const hostUrl = req.headers && req.headers.host ? `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}` : '';
      const settings = await db.getStoreSettings();

      // Vigilar activamente desde el servidor cada 2 segundos hasta 44s (maxDuration: 60s en Vercel)
      const maxChecks = isTestEnv ? 1 : 22;
      const intervalMs = isTestEnv ? 10 : 2000;
      let checks = 0;

      while (checks < maxChecks) {
        checks++;
        const freshOrder = await db.getOrderByAnyKey(id);
        if (!freshOrder) break;
        await syncAndDispatchOrder(freshOrder, hostUrl, settings);
        if (freshOrder.status === 'paid' || freshOrder.status === 'failed') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            success: true,
            status: freshOrder.status,
            checks,
            round,
            whatsappSent: Boolean(freshOrder.whatsappDispatch && freshOrder.whatsappDispatch.status === 'sent'),
            emailSent: Boolean(freshOrder.emailDispatch && freshOrder.emailDispatch.success)
          }));
        }
        if (checks < maxChecks) {
          await new Promise(resolve => setTimeout(resolve, intervalMs));
        }
      }

      // Si aún sigue pendiente y quedan relevos (hasta 5 rondas = ~3.7 min de vigilancia continua),
      // auto-relevar en Vercel sin intervención del usuario ni de su navegador
      if (!isTestEnv && round < 5 && hostUrl) {
        try {
          const ctrl = new AbortController();
          setTimeout(() => ctrl.abort(), 500);
          await fetch(`${hostUrl}/api/watch-payment/${encodeURIComponent(id)}?round=${round + 1}`, {
            method: 'POST',
            signal: ctrl.signal
          }).catch(() => {});
        } catch {}
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, status: 'pending', checks, round, relayed: round < 5 }));
    }

    if (pathname === '/api/sync-pending-orders' && (req.method === 'GET' || req.method === 'POST')) {
      const hostUrl = req.headers && req.headers.host ? `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}` : '';
      const summary = await syncAllPendingOrders(hostUrl);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, data: summary }));
    }

    if (pathname.startsWith('/api/order-status/') && req.method === 'GET') {
      const id = pathname.split('/api/order-status/')[1];
      const order = await db.getOrderByAnyKey(id);

      if (!order) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, message: 'Orden no encontrada' }));
      }

      const hostUrl = req.headers && req.headers.host ? `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}` : '';
      await syncAndDispatchOrder(order, hostUrl);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, data: order }));
    }

    // ==========================================
    // 8.1 REENVIAR FACTURA POR WHATSAPP (GREEN API / EVOLUTION API)
    // ==========================================
    if (pathname === '/api/resend-whatsapp' && req.method === 'POST') {
      const payload = await getRequestBody(req);
      const orderId = payload.order_id || payload.orderId;
      const order = await db.getOrderByAnyKey(orderId);

      if (!order) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, message: 'Orden no encontrada' }));
      }

      // SEGURIDAD: Solo enviar la factura si el dinero ya fue pagado y confirmado
      if (order.status !== 'paid') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: false,
          message: 'La factura no puede ser enviada porque el pago no ha sido confirmado por la pasarela.'
        }));
      }

      if (payload.phone) {
        order.clientPhone = normalizePhone(payload.phone);
        order.invoicePhone = order.clientPhone;
      }

      const settings = await db.getStoreSettings();
      const hostUrl = req.headers && req.headers.host ? `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}` : '';
      let result = null;
      try {
        result = await sendInvoiceWhatsApp(order, { baseUrl: hostUrl, settings });
        order.whatsappDispatch = result;
      } catch (err) {
        result = { success: false, error: err.message };
        order.whatsappDispatch = result;
      }
      await db.saveOrder(order);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, data: result }));
    }

    // ==========================================
    // 8.2 REENVIAR FACTURA POR CORREO (RESEND)
    // ==========================================
    if (pathname === '/api/resend-email' && req.method === 'POST') {
      const payload = await getRequestBody(req);
      const orderId = payload.order_id || payload.orderId;
      const order = await db.getOrderByAnyKey(orderId);

      if (!order) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, message: 'Orden no encontrada' }));
      }

      // SEGURIDAD: Solo enviar la factura si el dinero ya fue pagado y confirmado
      if (order.status !== 'paid') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: false,
          message: 'La factura no puede ser enviada porque el pago no ha sido confirmado por la pasarela.'
        }));
      }

      if (payload.email) {
        order.clientEmail = String(payload.email).trim();
        order.invoiceEmail = order.clientEmail;
      }

      const settings = await db.getStoreSettings();
      const hostUrl = req.headers && req.headers.host ? `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}` : '';
      let result = null;
      try {
        result = await sendInvoiceEmail(order, { baseUrl: hostUrl, settings });
        order.emailDispatch = result;
      } catch (err) {
        result = { success: false, error: err.message };
        order.emailDispatch = result;
      }
      await db.saveOrder(order);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, data: result }));
    }

    // ==========================================
    // 9. LISTAR ÓRDENES
    // ==========================================
    if (pathname === '/api/orders' && req.method === 'GET') {
      if (parsedUrl.searchParams.get('sync') === '1') {
        const hostUrl = req.headers && req.headers.host ? `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}` : '';
        try { await syncAllPendingOrders(hostUrl); } catch (e) {}
      }
      const list = await db.listOrders(60);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, data: list }));
    }

    // ==========================================
    // 10. CHAT BOT WHATSAPP IA
    // ==========================================
    if (pathname === '/api/agent-chat' && req.method === 'POST') {
      const payload = await getRequestBody(req);
      const settings = await db.getStoreSettings();
      const effectiveRate = await getEffectiveBcvRate(settings);
      const userMsg = (payload.message || '').trim();
      const clientName = payload.client_name || payload.clientName || 'Cliente';
      const orderId = payload.order_id || payload.orderId || null;

      const parsedItems = await parseOrderFromMessage(userMsg);

      if (parsedItems.length === 0) {
        const isAskingForLink = /link|enlace|pago|pagar|cuenta|transferir/i.test(userMsg);
        const existingOrder = orderId ? await db.getOrderByAnyKey(orderId) : null;
        if (isAskingForLink && existingOrder && existingOrder.status === 'pending') {
          const payUrl = existingOrder.skylinkUrl || existingOrder.paymentUrl;
          const replyText = `💳 *Aquí tienes tu link oficial de pago en Skylink Pay:*\n👉 ${payUrl}\n\n💵 *Monto:* Bs. ${existingOrder.amountVes.toFixed(2)} (≈ $${existingOrder.amount.toFixed(2)} USD)\n\n_(Acepta Pago Móvil C2P y Débito Inmediato)_. Al completar tu pago, coordinaremos el despacho de inmediato. 🚀`;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            success: true,
            reply: replyText,
            state: 'order_created',
            orderId: existingOrder.orderId,
            orderData: existingOrder
          }));
        }

        const catalog = (await db.listProducts()).map(p => formatProductForClient(p, effectiveRate, settings.pricingMode));
        let catalogoList = catalog.map(p => `• ${p.icon} *${p.name}* — Bs. ${p.priceBs.toFixed(2)} ($${p.priceUsd.toFixed(2)})`).join('\n');
        const replyText = `¡Hola ${clientName}! 👋 Bienvenido a *${settings.storeName}*.\n\nAquí tienes nuestro catálogo de productos a tasa BCV (Bs. ${effectiveRate.toFixed(2)}/$):\n\n${catalogoList}\n\n💬 _Dime qué deseas pedir (ej: "Quiero 2 harina pan y un arroz") y te generaré tu enlace de pago seguro en Skylink Pay de inmediato._`;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, reply: replyText, state: 'browsing' }));
      }

      // Crear orden desde chat
      let totalBs = 0;
      let itemsBreakdown = [];
      parsedItems.forEach(i => {
        const sub = i.priceBs * i.qty;
        totalBs += sub;
        itemsBreakdown.push(`• ${i.icon} *${i.qty}x ${i.name}* (Bs. ${i.priceBs.toFixed(2)} c/u) = Bs. ${sub.toFixed(2)}`);
      });

      totalBs = Number(totalBs.toFixed(2));
      const totalCentimos = toCentimos(totalBs);
      const totalUsd = Number((totalBs / effectiveRate).toFixed(2));
      const newOrderId = 'ORD-' + crypto.randomUUID().slice(0, 8).toUpperCase();
      const sessionId = 'SES-' + Date.now();
      const skylinkOverride = buildSkylinkOverride(settings);

      const skylinkRes = await fetchSkylinkPay('/api/v1/merchant/transactions', 'POST', {
        buyOrder: newOrderId,
        sessionId: sessionId,
        amount: totalCentimos,
        currency: 'VES',
        installments: 1
      }, skylinkOverride);

      const { token, skylinkPayUrl } = paymentFromResponse(skylinkRes, skylinkOverride);

      const orderData = {
        orderId: newOrderId,
        identifier: newOrderId,
        sessionId,
        token,
        amount: totalUsd,
        amountBs: totalBs,
        amountVes: totalBs,
        amountCentimos: totalCentimos,
        bcvRate: effectiveRate,
        paymentUrl: skylinkPayUrl,
        skylinkUrl: skylinkPayUrl,
        description: `Pedido WhatsApp (${parsedItems.map(i => `${i.qty}x ${i.name}`).join(', ')})`,
        items: parsedItems,
        clientName,
        clientPhone: payload.client_phone || '',
        storePhone: settings.storePhone,
        storeName: settings.storeName,
        storeRif: settings.storeRif,
        storeAddress: settings.storeAddress,
        storeCity: settings.storeCity,
        invoiceFooter: settings.invoiceFooter,
        status: 'pending',
        shippingData: null,
        source: 'whatsapp_agent',
        createdAt: new Date().toISOString()
      };

      await indexPayment(orderData);

      const replyText = `¡Excelente elección! 🎉 He preparado tu orden de compra:\n\n${itemsBreakdown.join('\n')}\n\n💵 *Total en Bolívares:* Bs. ${totalBs.toFixed(2)}\n💵 *Total USD (Ref):* $${totalUsd.toFixed(2)}\n\n💳 *Aquí tienes tu link oficial de pago en Skylink Pay:*\n👉 ${skylinkPayUrl}\n\n_(Acepta Pago Móvil C2P y Débito Inmediato)_. Al completar tu pago, coordinaremos el despacho por aquí de inmediato. 🚀`;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        success: true,
        reply: replyText,
        state: 'order_created',
        orderId: newOrderId,
        orderData
      }));
    }

    // ==========================================
    // 11. REINTENTO DE ORDEN Y GUÍAS DE ENVÍO
    // ==========================================
    if ((pathname === '/api/retry-order' || pathname === '/api/retry-payment') && req.method === 'POST') {
      const payload = await getRequestBody(req);
      const id = payload.order_id || payload.orderId;
      const prevOrder = await db.getOrderByAnyKey(id);

      if (!prevOrder) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, message: 'Orden anterior no encontrada' }));
      }

      const settings = await db.getStoreSettings();
      const effectiveRate = await getEffectiveBcvRate(settings);
      const newOrderId = 'ORD-' + crypto.randomUUID().slice(0, 8).toUpperCase();
      const amountVes = Number((prevOrder.amount * effectiveRate).toFixed(2));
      const amountCentimos = toCentimos(amountVes);
      const sessionId = 'SES-' + Date.now();
      const skylinkOverride = buildSkylinkOverride(settings);

      const skylinkRes = await fetchSkylinkPay('/api/v1/merchant/transactions', 'POST', {
        buyOrder: newOrderId,
        sessionId: sessionId,
        amount: amountCentimos,
        currency: 'VES',
        installments: 1
      }, skylinkOverride);

      const { token, skylinkPayUrl } = paymentFromResponse(skylinkRes, skylinkOverride);

      const newOrderData = {
        orderId: newOrderId,
        identifier: newOrderId,
        sessionId,
        token,
        amount: prevOrder.amount,
        amountBs: amountVes,
        amountVes,
        amountCentimos,
        bcvRate: effectiveRate,
        paymentUrl: skylinkPayUrl,
        payment_url: skylinkPayUrl,
        skylinkUrl: skylinkPayUrl,
        description: prevOrder.description,
        items: prevOrder.items,
        clientName: prevOrder.clientName,
        clientId: prevOrder.clientId,
        clientEmail: prevOrder.clientEmail,
        clientPhone: prevOrder.clientPhone,
        storePhone: prevOrder.storePhone || settings.storePhone,
        storeName: prevOrder.storeName || settings.storeName,
        storeRif: prevOrder.storeRif || settings.storeRif,
        status: 'pending',
        shippingData: null,
        createdAt: new Date().toISOString()
      };

      await indexPayment(newOrderData);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, data: newOrderData }));
    }

    if (pathname === '/api/save-shipping' && req.method === 'POST') {
      const payload = await getRequestBody(req);
      const orderId = payload.order_id || payload.orderId;
      const order = await db.getOrderByAnyKey(orderId);

      const guideNumber = payload.guide_number || payload.guideNumber || ('INT-' + Math.floor(100000 + Math.random() * 900000));
      const shippingInfo = {
        guideNumber: guideNumber,
        isInternalGuide: true,
        noticeMessage: 'Cuando tengamos tu guía de envío te la haremos llegar por aquí',
        recipientName: payload.recipient_name || payload.recipientName || (order ? order.clientName : 'Cliente'),
        recipientId: payload.recipient_id || payload.recipientId || 'V-12345678',
        recipientPhone: payload.recipient_phone || payload.recipientPhone || (order ? order.clientPhone : ''),
        city: payload.city || 'Caracas',
        agencyAddress: payload.agency_address || payload.agencyAddress || payload.address || 'Dirección de entrega',
        deliveryType: 'Envío Nacional',
        registeredAt: new Date().toISOString()
      };

      if (order) {
        order.shippingData = shippingInfo;
        await db.saveOrder(order);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, data: shippingInfo }));
    }

    // ==========================================
    // 12. SESIÓN KIOSCO
    // ==========================================
    if (pathname === '/api/session-info' && req.method === 'GET') {
      const ref = parsedUrl.searchParams.get('ref');
      const sessionId = parsedUrl.searchParams.get('session_id') || parsedUrl.searchParams.get('sessionId');
      const stored = (ref ? await db.getOrderByAnyKey(ref) : null) || (sessionId ? await db.getOrderByAnyKey(sessionId) : null);

      if (!stored) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, message: 'Sesión no encontrada' }));
      }

      try { await refreshPaymentStatus(stored); } catch (e) {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, data: stored }));
    }

    // Endpoint no encontrado
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: 'Endpoint no encontrado: ' + pathname }));

  } catch (err) {
    const status = err.httpStatus || 502;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      success: false,
      error: err.message,
      message: err.message,
      code: err.code || 'ERROR',
      upstreamStatus: err.upstreamStatus
    }));
  }
}

module.exports = handleApi;
