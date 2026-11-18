const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const https = require('node:https');
const fs = require('node:fs');
process.env.SKYLINK_BASE_URL = 'https://dev-axis-payment.valinkgroup.com';
process.env.SKYLINK_API_KEY = 'test-secret';
process.env.SKYLINK_COMMERCE_CODE = 'test-commerce';
const client = require('../lib/skylink');

test('HMAC changes when the timestamp or exact body changes', () => {
  // Independent fixture computed with Python hmac/hashlib.
  const expected = 'e322f901c011e7d5a0032d10b72d1a64900cf287467a227b77a6928536ee37ba';
  const sign = (body, time = '1791484181000') => client.sign('post', '/api/v1/merchant/transactions', body, time, 'test-secret');
  assert.equal(sign('{"amount":3000}'), expected);
  assert.notEqual(sign('{"amount": 3000}'), expected);
  assert.notEqual(sign('{"amount":3000}', '1791484181001'), expected);
});

test('transport signs precisely the UTF-8 bytes sent and does not send dashboard cookies', async t => {
  t.mock.method(https, 'request', (url, options, callback) => {
    const req = new EventEmitter();
    req.end = body => {
      assert.equal(body, '{"amount":3000,"buyOrder":"Prueba café"}');
      assert.equal(url.pathname, '/api/v1/merchant/transactions');
      assert.equal(options.headers.Cookie, undefined);
      assert.equal(options.headers.cookie, undefined);
      assert.equal(options.headers['Content-Length'], Buffer.byteLength(body));
      assert.equal(options.headers['Idempotency-Key'], `Prueba café-${options.headers['X-Timestamp']}`);
      assert.equal(options.headers['X-Signature'], client.sign('POST', url.pathname, body,
        options.headers['X-Timestamp'], options.headers['X-Api-Key']));
      const res = new EventEmitter(); res.statusCode = 401; res.headers = {};
      callback(res); res.emit('data', '{"success":false,"message":"Firma inválida"}'); res.emit('end');
    };
    return req;
  });
  const result = await client.request('/api/v1/merchant/transactions', 'POST', { buyOrder: 'Prueba café', amount: 3000 });
  assert.equal(result.status, 401);
  assert.throws(() => client.paymentFromResponse(result), { code: 'SKYLINK_SIGNATURE_INVALID' });
});

test('support canonical JSON sorts top-level keys, omits undefined and signs null for GET', async t => {
  assert.equal(client.canonicalJson({ sessionId: 's', amount: 2200, extra: undefined, buyOrder: 'b' }), '{"amount":2200,"buyOrder":"b","sessionId":"s"}');
  assert.equal(client.canonicalJson(null), 'null');
  assert.equal(client.sign('get', 'api/v1/merchant/transactions?page=1', 'null', '123', 'key'),
    client.sign('GET', '/api/v1/merchant/transactions', 'null', '123', 'key'));
  t.mock.method(https, 'request', (url, options, callback) => {
    const req = new EventEmitter();
    req.end = body => {
      assert.equal(body, '');
      assert.equal(options.headers['Content-Length'], undefined);
      assert.equal(options.headers['X-Signature'], client.sign('GET', url.pathname, 'null', options.headers['X-Timestamp'], options.headers['X-Api-Key']));
      const res = new EventEmitter(); res.statusCode = 200; res.headers = {};
      callback(res); res.emit('data', '{"success":true}'); res.emit('end');
    };
    return req;
  });
  assert.equal((await client.request('/api/v1/merchant/transactions?page=1', 'GET')).ok, true);
});

test('only the provider-confirmed nested token and URL produce a payment link', () => {
  const base = process.env.SKYLINK_BASE_URL || 'https://dev-axis-payment.valinkgroup.com';
  const data = { token: 'real-token', url: `${base}/pay/real-token` };
  assert.deepEqual(client.paymentFromResponse({ ok: true, status: 201, data: { success: true, data } }),
    { token: data.token, skylinkPayUrl: data.url });
  for (const result of [
    { ok: false, status: 401, data: { message: 'Firma inválida' } },
    { ok: false, status: 504 },
    { ok: true, status: 200, data: { success: false, data } },
    { ok: true, status: 200, data: { success: true, data: {} } },
    { ok: true, status: 200, data: { success: true, data: { ...data, url: 'https://example.com/pay/real-token' } } },
    { ok: true, status: 200, data: { success: true, data: { ...data, token: 'different-token' } } }
  ]) assert.throws(() => client.paymentFromResponse(result));
});

test('all four creation routes fail closed; failed orders are not saved; settings never expose the key', async t => {
  let succeed = false;
  t.mock.method(client, 'request', async () => succeed
    ? { ok: true, status: 201, data: { success: true, data: { token: 'test-token', url: `${process.env.SKYLINK_BASE_URL}/pay/test-token` } } }
    : { ok: false, status: 401, data: { success: false, message: 'Firma inválida' } });
  delete require.cache[require.resolve('../api/index')];
  const handler = require('../api/index');
  async function invoke(url, body, method = 'POST') {
    let status;
    let data;
    await handler({ url, method, body, headers: { host: 'localhost' } }, {
      setHeader() {}, writeHead(code) { status = code; }, end(text) { data = JSON.parse(text); }
    });
    return { status, data };
  }
  assert.equal((await invoke('/api/create-order-link', { amount: -2 })).status, 400);
  assert.equal((await invoke('/api/create-order-link', { amount: 0 })).status, 400);
  for (const [url, body] of [
    ['/api/create-payment', { amount: 1, invoiceName: 'María Pérez', invoiceEmail: 'delivered@resend.dev', invoicePhone: '04121234567', invoiceId: 'V-12345678' }],
    ['/api/create-order-link', { amount: 1 }],
    ['/api/agent-chat', { message: 'quiero arroz' }]
  ]) {
    const result = await invoke(url, body);
    assert.equal(result.status, 502, url);
    assert.equal(result.data.code, 'SKYLINK_SIGNATURE_INVALID', url);
    assert.equal(result.data.data, undefined);
  }
  assert.equal((await invoke('/api/orders', null, 'GET')).data.data.length, 0);
  succeed = true;
  const created = await invoke('/api/create-order-link', { amount: 1 });
  assert.equal(created.data.success, true);
  assert.equal(created.data.data.paymentUrl, `${process.env.SKYLINK_BASE_URL}/pay/test-token`);
  succeed = false;
  const retry = await invoke('/api/retry-order', { order_id: created.data.data.orderId });
  assert.equal(retry.status, 502);
  assert.equal((await invoke('/api/orders', null, 'GET')).data.data.length, 1);
  const settings = await invoke('/api/store-settings', null, 'GET');
  assert.equal(settings.data.data.skylinkApiKey, undefined);
});

test('kiosk and admin creation routes use the shared canonical HMAC transport', async t => {
  let requests = 0;
  t.mock.method(https, 'request', (url, options, callback) => {
    const req = new EventEmitter();
    req.end = body => {
      requests++;
      const payload = JSON.parse(body);
      assert.equal(body, client.canonicalJson(payload));
      assert.equal(payload.amount, 3750);
      assert.equal(options.headers['X-Signature'], client.sign('POST', url.pathname, body,
        options.headers['X-Timestamp'], options.headers['X-Api-Key']));
      assert.ok(options.headers['Idempotency-Key']);
      const res = new EventEmitter(); res.statusCode = 201; res.headers = {};
      callback(res);
      res.emit('data', JSON.stringify({ success: true, data: { token: `route-${requests}`,
        url: `https://dev-axis-payment.valinkgroup.com/pay/route-${requests}` } }));
      res.emit('end');
    };
    return req;
  });
  delete require.cache[require.resolve('../api/index')];
  const handler = require('../api/index');
  for (const url of ['/api/create-payment', '/api/create-order-link']) {
    let status, result;
    const body = url === '/api/create-payment'
      ? { amount: 1, invoiceName: 'María Pérez', invoiceEmail: 'delivered@resend.dev', invoicePhone: '04121234567', invoiceId: 'V-12345678' }
      : { amount: 1 };
    await handler({ url, method: 'POST', body, headers: { host: 'localhost' } }, {
      setHeader() {}, writeHead(code) { status = code; }, end(text) { result = JSON.parse(text); }
    });
    assert.equal(status, 200);
    assert.equal(result.success, true);
    assert.equal(result.data.token, `route-${requests}`);
    assert.equal(result.data.amountCentimos, 3750);
  }
  assert.equal(requests, 2);
});

test('kiosk requires invoice identity and synchronizes the provider payment status', async t => {
  t.mock.method(client, 'request', async (endpoint, method) => {
    if (method === 'GET') {
      return { ok: true, status: 200, data: { success: true, data: {
        status: 'AUTHORIZED', reference: 'BANK-001', payment_method: 'mobile_payment'
      } } };
    }
    return { ok: true, status: 201, data: { success: true, data: {
      token: 'invoice-token', url: `${process.env.SKYLINK_BASE_URL}/pay/invoice-token`
    } } };
  });
  delete require.cache[require.resolve('../api/index')];
  const handler = require('../api/index');
  async function invoke(url, body, method = 'POST') {
    let status, data;
    await handler({ url, method, body, headers: { host: 'localhost' } }, {
      setHeader() {}, writeHead(code) { status = code; }, end(text) { data = JSON.parse(text); }
    });
    return { status, data };
  }

  assert.equal((await invoke('/api/create-payment', { amount: 1 })).status, 400);
  const created = await invoke('/api/create-payment', {
    amount: 1, invoiceName: 'María Pérez', invoiceEmail: 'delivered@resend.dev', invoicePhone: '04121234567', invoiceId: 'V-12345678'
  });
  assert.equal(created.status, 200);
  const order = await invoke(`/api/order-status/${created.data.data.identifier}`, null, 'GET');
  assert.equal(order.data.data.status, 'paid');
  assert.equal(order.data.data.reference, 'BANK-001');
  assert.equal(order.data.data.invoice.name, 'María Pérez');
  assert.equal(order.data.data.invoice.idNumber, 'V-12345678');
  assert.equal(order.data.data.invoice.email, 'delivered@resend.dev');
});

test('kiosk defers Skylink until the separate invoice-data step', () => {
  const productsPage = fs.readFileSync(require.resolve('../public/autopago.html'), 'utf8');
  const invoiceDataPage = fs.readFileSync(require.resolve('../public/datos-factura.html'), 'utf8');

  assert.doesNotMatch(productsPage, /\/api\/create-payment/);
  assert.match(productsPage, /window\.location\.href = '\/datos-factura'/);
  assert.match(invoiceDataPage, /Nombre \*/);
  assert.match(invoiceDataPage, /id="invoiceEmail"[^>]*required/);
  assert.doesNotMatch(invoiceDataPage, /\(Opcional\)/);
  assert.match(invoiceDataPage, /Cédula/);
  assert.match(invoiceDataPage, /fetch\('\/api\/create-payment'/);
  assert.match(invoiceDataPage, /window\.location\.href = `\/factura\?order_id=/);
});

test('autopago integrates continuous barcode-detector with local ZXing-WASM without external CDN', () => {
  const autopagoHtml = fs.readFileSync(require.resolve('../public/autopago.html'), 'utf8');
  const wasmPath = require.resolve('../public/zxing_reader.wasm');
  const iifePath = require.resolve('../public/barcode-detector.iife.js');

  // 1. Assets exist locally
  assert.ok(fs.existsSync(wasmPath), 'zxing_reader.wasm must exist in public/');
  assert.ok(fs.existsSync(iifePath), 'barcode-detector.iife.js must exist in public/');

  // 2. Validate WASM binary magic header (\0asm)
  const wasmBytes = fs.readFileSync(wasmPath);
  assert.ok(wasmBytes.length > 500000, 'zxing_reader.wasm should be a full binary (~900KB+)');
  assert.equal(wasmBytes[0], 0x00);
  assert.equal(wasmBytes[1], 0x61); // 'a'
  assert.equal(wasmBytes[2], 0x73); // 's'
  assert.equal(wasmBytes[3], 0x6d); // 'm'

  // 3. Preload and script tag in HTML head
  assert.match(autopagoHtml, /rel="preload"\s+href="\/zxing_reader\.wasm"/);
  assert.match(autopagoHtml, /src="\/barcode-detector\.iife\.js"/);

  // 4. Barcode configuration exists and covers retail formats
  assert.match(autopagoHtml, /SCANNER_CONFIG/);
  assert.match(autopagoHtml, /ean_13/);
  assert.match(autopagoHtml, /upc_a/);
  assert.match(autopagoHtml, /code_128/);
  assert.match(autopagoHtml, /qr_code/);
  assert.match(autopagoHtml, /cooldownMs:\s*1200/);

  // 5. Local WASM override configured (no CDN requests)
  assert.match(autopagoHtml, /setZXingModuleOverrides/);
  assert.match(autopagoHtml, /locateFile/);

  // 6. Camera starts automatically and stays continuous
  assert.match(autopagoHtml, /iniciarCamaraContinuo\(\)/);
  assert.match(autopagoHtml, /wakeLock/);
  assert.match(autopagoHtml, /visibilitychange/);
});

test('autopago allows scanning to register custom products and saving them with persistent recognition', async () => {
  const autopagoHtml = fs.readFileSync(require.resolve('../public/autopago.html'), 'utf8');

  // 1. UI elements for registration mode and modal
  assert.match(autopagoHtml, /id="btnRegisterMode"/);
  assert.match(autopagoHtml, /id="modalRegistrarProducto"/);
  assert.match(autopagoHtml, /id="regProductCode"/);
  assert.match(autopagoHtml, /id="regProductName"/);
  assert.match(autopagoHtml, /id="regProductPrice"/);

  // 2. Logic functions exist
  assert.match(autopagoHtml, /function toggleModoRegistro/);
  assert.match(autopagoHtml, /function abrirModalRegistro/);
  assert.match(autopagoHtml, /function guardarProductoEscaneado/);
  assert.match(autopagoHtml, /skypay_temp_products/);

  // 3. API endpoint supports custom code creation and updates
  delete require.cache[require.resolve('../api/index')];
  const handler = require('../api/index');
  async function invoke(url, body, method = 'POST') {
    let status, data;
    await handler({ url, method, body, headers: { host: 'localhost' } }, {
      setHeader() {}, writeHead(code) { status = code; }, end(text) { data = JSON.parse(text); }
    });
    return { status, data };
  }

  const customProd = {
    name: 'Galleta de Chocolate Test',
    code: '999888777123',
    priceBs: 24.50,
    category: 'Snacks'
  };

  const resCreated = await invoke('/api/products', customProd, 'POST');
  assert.equal(resCreated.status, 201);
  assert.equal(resCreated.data.data.name, 'Galleta de Chocolate Test');
  assert.equal(resCreated.data.data.code, '999888777123');

  // Updating the same code
  const resUpdated = await invoke('/api/products', { ...customProd, priceBs: 25.00 }, 'POST');
  assert.equal(resUpdated.status, 200);
  assert.equal(resUpdated.data.data.priceBs, 25.00);
});

test('autopago phone layout: scanner and cart only, item/bulk deletion, and notifications', () => {
  const autopagoHtml = fs.readFileSync(require.resolve('../public/autopago.html'), 'utf8');

  // 1. Being able to remove individual items
  assert.match(autopagoHtml, /function eliminarProducto\(id\)/);
  assert.match(autopagoHtml, /class="btn-delete-item"/);
  assert.match(autopagoHtml, /🗑️/);

  // 2. Being able to remove everything from the cart
  assert.match(autopagoHtml, /function limpiarCarrito\(\)/);
  assert.match(autopagoHtml, /id="btnClearHeader"/);
  assert.match(autopagoHtml, /id="btnClearFooter"/);
  assert.match(autopagoHtml, /Vaciar todo/);

  // 3. Show a notification when a product is scanned, added, or removed
  assert.match(autopagoHtml, /id="kioskToastNotification"/);
  assert.match(autopagoHtml, /function mostrarNotificacion\(mensaje/);
  assert.match(autopagoHtml, /\.kiosk-toast-notification/);

  // 4. Show the cart to pay (cart list, totals in Bs/USD, proceed button)
  assert.match(autopagoHtml, /id="cartItems"/);
  assert.match(autopagoHtml, /id="cartTotalBS"/);
  assert.match(autopagoHtml, /id="cartTotalUSD"/);
  assert.match(autopagoHtml, /id="btnPay"/);
  assert.match(autopagoHtml, /id="btnStickyPay"/);

  // 5 & 6. Layout shows scanner and cart only (catalog product grid hidden / substituted)
  assert.match(autopagoHtml, /id="kioskScannedBox"/);
  assert.match(autopagoHtml, /scanned-item-card/);
  assert.match(autopagoHtml, /scanned-empty-state/);
  assert.match(autopagoHtml, /id="productsGrid"\s+style="display:none;"/);
});

test('flow: mandatory name and numbers-only phone, automatic invoice PDF download and Green API WhatsApp dispatch', async t => {
  const datosFacturaHtml = fs.readFileSync(require.resolve('../public/datos-factura.html'), 'utf8');
  const facturaHtml = fs.readFileSync(require.resolve('../public/factura.html'), 'utf8');
  const whatsapp = require('../lib/whatsapp');

  // 1. datos-factura.html form requirements: name and phone strictly required, phone is numeric only
  assert.match(datosFacturaHtml, /id="invoiceName"/);
  assert.match(datosFacturaHtml, /id="invoicePhone"/);
  assert.match(datosFacturaHtml, /inputmode="numeric"/);
  assert.match(datosFacturaHtml, /pattern="\[0-9\]\*"/);
  assert.match(datosFacturaHtml, /replace\(\/\\D\/g,\s*''\)/);
  assert.match(datosFacturaHtml, /auto_download=1/);

  // 2. factura.html: only downloads and displays when payment is confirmed, generates PDF blob
  assert.match(facturaHtml, /currentOrder\.status\s*!==\s*'paid'/);
  assert.match(facturaHtml, /descargarFacturaPDF/);
  assert.match(facturaHtml, /buildPdfInvoiceBytes/);
  assert.match(facturaHtml, /application\/pdf/);
  assert.match(facturaHtml, /id="whatsappStatusCard"/);
  assert.match(facturaHtml, /reenviarFacturaWhatsApp/);

  // 3. WhatsApp module: number normalization and message builder
  assert.equal(whatsapp.normalizePhone('04121234567'), '584121234567');
  assert.equal(whatsapp.normalizePhone('0414-987.6543'), '584149876543');
  assert.equal(whatsapp.normalizePhone('+58 (424) 111-2233'), '584241112233');

  const sampleOrder = {
    orderId: 'AUTO-TEST1',
    clientName: 'Pedro Perez',
    clientId: 'V-12345678',
    clientPhone: '04121234567',
    amountBs: 50.00,
    amount: 1.33,
    reference: 'REF-BANK-100',
    items: [
      { name: 'Harina PAN 1kg', qty: 2, priceBs: 25.00, icon: '🌽' }
    ]
  };
  const msg = whatsapp.buildInvoiceMessage(sampleOrder, 'https://skylink-test.vercel.app');
  assert.match(msg, /Pedro Perez/);
  assert.match(msg, /V-12345678/);
  assert.match(msg, /584121234567/);
  assert.match(msg, /Harina PAN 1kg/);
  assert.match(msg, /AUTO-TEST1/);
  assert.match(msg, /Bs\. 50\.00/);
  assert.match(msg, /factura\?order_id=AUTO-TEST1/);

  // 4. Backend validation: /api/create-payment enforces name, numeric phone and mandatory cédula
  t.mock.method(client, 'request', async (endpoint, method) => {
    if (method === 'GET') {
      return { ok: true, status: 200, data: { success: true, data: { status: 'AUTHORIZED', reference: 'REF-BANK-200' } } };
    }
    return { ok: true, status: 201, data: { success: true, data: { token: 'tok-flow', url: `${process.env.SKYLINK_BASE_URL}/pay/tok-flow` } } };
  });

  delete require.cache[require.resolve('../api/index')];
  const handler = require('../api/index');
  async function invoke(url, body, method = 'POST') {
    let status, data;
    await handler({ url, method, body, headers: { host: 'localhost' } }, {
      setHeader() {}, writeHead(code) { status = code; }, end(text) { data = JSON.parse(text); }
    });
    return { status, data };
  }

  // Missing name
  const resNoName = await invoke('/api/create-payment', { amount: 1, invoiceEmail: 'delivered@resend.dev', invoicePhone: '04121234567', invoiceId: 'V-12345678' });
  assert.equal(resNoName.status, 400);

  // Missing email (must fail 400 because email is mandatory)
  const resNoEmail = await invoke('/api/create-payment', {
    amount: 1,
    invoiceName: 'Carlos Gomez',
    invoicePhone: '04121234567',
    invoiceId: 'V-12345678'
  });
  assert.equal(resNoEmail.status, 400);
  assert.match(resNoEmail.data.message, /correo electrónico es obligatorio/i);

  // Invalid phone (non-numeric)
  const resBadPhone = await invoke('/api/create-payment', { amount: 1, invoiceName: 'Carlos Test', invoiceEmail: 'delivered@resend.dev', invoicePhone: 'abc123456', invoiceId: 'V-12345678' });
  assert.equal(resBadPhone.status, 400);

  // Missing cédula (must fail 400 because cédula is mandatory)
  const resNoId = await invoke('/api/create-payment', {
    amount: 1,
    invoiceName: 'Carlos Gomez',
    invoiceEmail: 'delivered@resend.dev',
    invoicePhone: '04121234567'
  });
  assert.equal(resNoId.status, 400);
  assert.match(resNoId.data.message, /cédula o RIF es obligatoria/i);

  // Valid name, mandatory email, numeric phone and valid cédula
  const resOk = await invoke('/api/create-payment', {
    amount: 1,
    invoiceName: 'Carlos Gomez',
    invoiceEmail: 'delivered@resend.dev',
    invoicePhone: '04121234567',
    invoiceId: '12345678'
  });
  assert.equal(resOk.status, 200);
  assert.equal(resOk.data.data.clientName, 'Carlos Gomez');
  assert.equal(resOk.data.data.clientPhone, '584121234567');
  assert.equal(resOk.data.data.clientId, 'V-12345678');

  // Verify polling transitions to paid and dispatches WhatsApp notification
  const orderCheck = await invoke(`/api/order-status/${resOk.data.data.identifier}`, null, 'GET');
  assert.equal(orderCheck.data.data.status, 'paid');
  assert.ok(orderCheck.data.data.whatsappDispatch, 'Order must include whatsappDispatch');
  assert.equal(orderCheck.data.data.whatsappDispatch.phone, '584121234567');
  assert.match(orderCheck.data.data.whatsappDispatch.waMeUrl, /wa\.me\/584121234567/);

  // Resend WhatsApp endpoint works
  const resendRes = await invoke('/api/resend-whatsapp', { order_id: resOk.data.data.identifier }, 'POST');
  assert.equal(resendRes.status, 200);
  assert.equal(resendRes.data.data.phone, '584121234567');
});

test('strict payment verification and iPad auto-zoom: invoice blocked unless paid, auto-zoom on distant codes and iPad camera support', async t => {
  const whatsapp = require('../lib/whatsapp');
  const facturaHtml = fs.readFileSync(require.resolve('../public/factura.html'), 'utf8');
  const autopagoHtml = fs.readFileSync(require.resolve('../public/autopago.html'), 'utf8');

  // 1. WhatsApp module STRICTLY blocks sending when order is not paid
  const pendingOrder = { orderId: 'AUTO-PENDING-1', status: 'pending', clientPhone: '04121234567', clientName: 'Ana Lopez' };
  const blockedPending = await whatsapp.sendInvoiceWhatsApp(pendingOrder);
  assert.equal(blockedPending.success, false);
  assert.equal(blockedPending.blocked, true);
  assert.match(blockedPending.error, /solo puede ser enviada cuando el pago ha sido confirmado/);

  const failedOrder = { orderId: 'AUTO-FAILED-1', status: 'failed', clientPhone: '04121234567', clientName: 'Ana Lopez' };
  const blockedFailed = await whatsapp.sendInvoiceWhatsApp(failedOrder);
  assert.equal(blockedFailed.success, false);
  assert.equal(blockedFailed.blocked, true);

  // 2. Endpoint /api/resend-whatsapp strictly refuses unpaid orders
  t.mock.method(client, 'request', async (endpoint, method) => {
    return { ok: true, status: 201, data: { success: true, data: { token: 'tok-strict', url: `${process.env.SKYLINK_BASE_URL}/pay/tok-strict` } } };
  });

  delete require.cache[require.resolve('../api/index')];
  const handler = require('../api/index');
  async function invoke(url, body, method = 'POST') {
    let status, data;
    await handler({ url, method, body, headers: { host: 'localhost' } }, {
      setHeader() {}, writeHead(code) { status = code; }, end(text) { data = JSON.parse(text); }
    });
    return { status, data };
  }

  const createdPending = await invoke('/api/create-payment', {
    amount: 1, invoiceName: 'Ana Lopez', invoiceEmail: 'delivered@resend.dev', invoicePhone: '04121234567', invoiceId: 'V-87654321'
  });
  assert.equal(createdPending.status, 200);
  assert.equal(createdPending.data.data.status, 'pending');

  const resendBlocked = await invoke('/api/resend-whatsapp', { order_id: createdPending.data.data.identifier }, 'POST');
  assert.equal(resendBlocked.status, 400);
  assert.match(resendBlocked.data.message, /el pago no ha sido confirmado/);

  // 3. factura.html strictly blocks invoice display, PDF generation and WhatsApp unless status === 'paid'
  assert.match(facturaHtml, /currentOrder\.status\s*!==\s*'paid'/);
  assert.match(facturaHtml, /Pago aún no comprobado/);
  assert.match(facturaHtml, /descargarFacturaPDF/);
  assert.match(facturaHtml, /buildPdfInvoiceBytes/);

  // 4. iPad Camera & QR detection technology optimizations
  assert.match(autopagoHtml, /src="\/barcode-detector\.iife\.js"/);
  assert.match(autopagoHtml, /src="\/zxing\.min\.js"/);
  assert.match(autopagoHtml, /getZxingFallbackReader/);
  assert.match(autopagoHtml, /playsinline/);
  assert.match(autopagoHtml, /webkit-playsinline/);
  assert.match(autopagoHtml, /qr_code/);
  assert.match(autopagoHtml, /micro_qr_code/);

  // 5. Auto-Zoom technology when QR / barcode is too far
  assert.match(autopagoHtml, /activarAutoZoom/);
  assert.match(autopagoHtml, /setCameraZoom/);
  assert.match(autopagoHtml, /detectarCodigoLejano/);
  assert.match(autopagoHtml, /resetAutoZoom/);
  assert.match(autopagoHtml, /scannerZoomBadge/);
  assert.match(autopagoHtml, /scanner-zoom-controls/);
  assert.match(autopagoHtml, /btnZoom1/);
  assert.match(autopagoHtml, /btnZoom2/);

  // 6. Android and low-resolution camera optimizations
  assert.match(autopagoHtml, /solicitarStreamCamaraRobusto/);
  assert.match(autopagoHtml, /realzarContrasteBajaResolucion/);
  assert.match(autopagoHtml, /initTapToFocus/);
  assert.match(autopagoHtml, /mostrarReticleEnfoque/);
  assert.match(autopagoHtml, /tap-focus-reticle/);
  // Ensure no hard minimum constraints that cause OverconstrainedError on Android portrait mode
  assert.doesNotMatch(autopagoHtml, /video:\s*\{[^}]*width:\s*\{\s*min:\s*640/);
});

test('DolarAPI integration, product prices 18, 19, 20, 24 Bs and random default product pricing', async t => {
  delete require.cache[require.resolve('../api/index')];
  const handler = require('../api/index');
  async function invoke(url, body, method = 'GET') {
    let status, data;
    await handler({ url, method, body, headers: { host: 'localhost' } }, {
      setHeader() {}, writeHead(code) { status = code; }, end(text) { data = JSON.parse(text); }
    });
    return { status, data };
  }

  // 1. DolarAPI endpoint /api/bcv-rate
  const bcvRes = await invoke('/api/bcv-rate?sync=1');
  assert.equal(bcvRes.status, 200);
  assert.equal(bcvRes.data.success, true);
  assert.ok(bcvRes.data.rate > 0);
  assert.match(bcvRes.data.provider, /DolarAPI/i);
  assert.equal(bcvRes.data.source, 'https://ve.dolarapi.com/v1/dolares/oficial');

  // 2. Catalogo includes exact 18, 19, 20 and 24 Bs prices
  const prodsRes = await invoke('/api/products');
  assert.equal(prodsRes.status, 200);
  const prices = prodsRes.data.data.map(p => p.priceBs);
  assert.ok(prices.includes(18), 'Must include product with price 18 Bs');
  assert.ok(prices.includes(19), 'Must include product with price 19 Bs');
  assert.ok(prices.includes(20), 'Must include product with price 20 Bs');
  assert.ok(prices.includes(24), 'Must include product with price 24 Bs');

  // 3. Adding a product with omitted price assigns random default price
  const createdNoPrice = await invoke('/api/products', { name: 'Producto Aleatorio Test' }, 'POST');
  assert.equal(createdNoPrice.status, 201);
  assert.ok(createdNoPrice.data.data.priceBs >= 15 && createdNoPrice.data.data.priceBs <= 40);
});

test('Resend Email integration: PDF invoice attachment, security guards and automated dispatch upon payment', async t => {
  const emailModule = require('../lib/email');

  // 1. PDF generator creates valid binary PDF 1.4 buffer
  const sampleOrder = {
    orderId: 'AUTO-PDF-TEST',
    clientName: 'Laura Sanchez',
    clientId: 'V-11223344',
    clientPhone: '04121234567',
    clientEmail: 'delivered@resend.dev',
    amountBs: 40.00,
    amount: 1.05,
    reference: 'SK-REF-99',
    status: 'paid',
    items: [{ name: 'Refresco Lata 355ml', qty: 2, priceBs: 20.00 }]
  };

  const pdfBuf = emailModule.buildPdfInvoiceBuffer(sampleOrder);
  assert.ok(Buffer.isBuffer(pdfBuf));
  assert.ok(pdfBuf.toString('binary').startsWith('%PDF-1.4'));
  assert.ok(pdfBuf.toString('binary').includes('%%EOF'));

  // 2. Security guard: sendInvoiceEmail strictly blocks unpaid orders
  const unpaidOrder = { ...sampleOrder, status: 'pending' };
  const blockedRes = await emailModule.sendInvoiceEmail(unpaidOrder);
  assert.equal(blockedRes.success, false);
  assert.equal(blockedRes.blocked, true);

  // 3. Automated dispatch via /api/create-payment and /api/order-status
  t.mock.method(client, 'request', async (endpoint, method) => {
    if (method === 'GET') {
      return { ok: true, status: 200, data: { success: true, data: { status: 'AUTHORIZED', reference: 'REF-BANK-RESEND' } } };
    }
    return { ok: true, status: 201, data: { success: true, data: { token: 'tok-resend', url: `${process.env.SKYLINK_BASE_URL}/pay/tok-resend` } } };
  });

  delete require.cache[require.resolve('../api/index')];
  const handler = require('../api/index');
  async function invoke(url, body, method = 'POST') {
    let status, data;
    await handler({ url, method, body, headers: { host: 'localhost' } }, {
      setHeader() {}, writeHead(code) { status = code; }, end(text) { data = JSON.parse(text); }
    });
    return { status, data };
  }

  const created = await invoke('/api/create-payment', {
    amount: 1,
    invoiceName: 'Laura Sanchez',
    invoicePhone: '04121234567',
    invoiceId: 'V-11223344',
    invoiceEmail: 'delivered@resend.dev'
  });
  assert.equal(created.status, 200);
  assert.equal(created.data.data.clientEmail, 'delivered@resend.dev');

  // Verify transition to paid dispatches both WhatsApp and Resend email with PDF
  const orderCheck = await invoke(`/api/order-status/${created.data.data.identifier}`, null, 'GET');
  assert.equal(orderCheck.data.data.status, 'paid');
  assert.ok(orderCheck.data.data.emailDispatch, 'Order must include emailDispatch');
  assert.equal(orderCheck.data.data.emailDispatch.recipient, 'delivered@resend.dev');
  assert.equal(orderCheck.data.data.emailDispatch.provider, 'resend');
  assert.equal(orderCheck.data.data.emailDispatch.success, true);
});

test('Commercial MVP: crypto encryption, Admin Auth, Cédula Express CRM, Evolution API, dynamic branding, and product scanner CRUD', async t => {
  const cryptoLib = require('../lib/crypto');
  const whatsapp = require('../lib/whatsapp');
  const email = require('../lib/email');
  const datosFacturaHtml = fs.readFileSync(require.resolve('../public/datos-factura.html'), 'utf8');
  const adminHtml = fs.readFileSync(require.resolve('../public/admin.html'), 'utf8');
  const schemaSql = fs.readFileSync(require.resolve('../supabase/schema.sql'), 'utf8');

  // 1. Crypto AES-256-GCM + Cedula normalization + Secret masking
  const secret = 're_test_super_secret_key_9988';
  const encrypted = cryptoLib.encryptSecret(secret);
  assert.ok(encrypted.startsWith('enc:v1:'));
  assert.notEqual(encrypted, secret);
  assert.equal(cryptoLib.decryptSecret(encrypted), secret);
  assert.equal(cryptoLib.maskSecret(secret), '••••••••9988');
  assert.equal(cryptoLib.normalizeCedula('12.345.678'), 'V-12345678');
  assert.equal(cryptoLib.normalizeCedula('e-9876543'), 'E-9876543');

  // 2. Supabase schema contains all 4 required tables
  assert.match(schemaSql, /CREATE TABLE IF NOT EXISTS public\.store_settings/);
  assert.match(schemaSql, /CREATE TABLE IF NOT EXISTS public\.customers/);
  assert.match(schemaSql, /CREATE TABLE IF NOT EXISTS public\.products/);
  assert.match(schemaSql, /CREATE TABLE IF NOT EXISTS public\.orders/);

  // 3. New 3-view sequential Cédula-first flow in datos-factura.html (with zero manual verify button & active server watcher)
  assert.match(datosFacturaHtml, /id="cedulaStep"/);
  assert.match(datosFacturaHtml, /id="returningStep"/);
  assert.match(datosFacturaHtml, /id="invoiceStep"/);
  assert.match(datosFacturaHtml, /\/api\/customers\/by-cedula\//);
  assert.match(datosFacturaHtml, /id="returningPayButton"/);
  assert.doesNotMatch(datosFacturaHtml, /btnVerifyNow/);
  assert.match(datosFacturaHtml, /\/api\/watch-payment\//);

  // 4. Admin panel includes local scanner without external CDN, Evolution API, Resend, Skylink, and Company settings
  assert.match(adminHtml, /src="\/barcode-detector\.iife\.js"/);
  assert.match(adminHtml, /src="\/zxing\.min\.js"/);
  assert.match(adminHtml, /src="\/scanner-engine\.js"/);
  assert.doesNotMatch(adminHtml, /https:\/\/(cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com)/);
  assert.match(adminHtml, /iniciarReescaneoProducto/);
  assert.match(adminHtml, /evolution_api/);
  assert.match(adminHtml, /cfgResendKey/);
  assert.match(adminHtml, /cfgSkylinkKey/);
  assert.match(adminHtml, /cfgStoreRif/);

  // 5. Mock Skylink & reload handler
  t.mock.method(client, 'request', async (endpoint, method) => {
    return { ok: true, status: 201, data: { success: true, data: { token: 'tok-mvp', url: `${process.env.SKYLINK_BASE_URL}/pay/tok-mvp` } } };
  });

  delete require.cache[require.resolve('../api/index')];
  const handler = require('../api/index');
  async function invoke(url, body = null, method = 'GET', headers = {}) {
    let status, data;
    const resHeaders = {};
    await handler({ url, method, body, headers: { host: 'localhost', ...headers } }, {
      setHeader(k, v) { resHeaders[k.toLowerCase()] = v; },
      writeHead(code) { status = code; },
      end(text) { data = text ? JSON.parse(text) : {}; }
    });
    return { status, data, headers: resHeaders };
  }

  // 6. Admin auth blocks unauthenticated requests with 401
  assert.equal((await invoke('/api/admin/settings')).status, 401);
  assert.equal((await invoke('/api/admin/customers')).status, 401);
  assert.equal((await invoke('/api/products/1', { name: 'Hack' }, 'PUT')).status, 401);
  assert.equal((await invoke('/api/products/1', null, 'DELETE')).status, 401);

  // Wrong password rejected; valid password returns token
  const badLogin = await invoke('/api/admin/login', { password: 'wrong-password' }, 'POST');
  assert.equal(badLogin.status, 401);
  const okLogin = await invoke('/api/admin/login', { password: cryptoLib.getAdminPassword() }, 'POST');
  assert.equal(okLogin.status, 200);
  assert.ok(okLogin.data.token);
  const authHeader = { authorization: `Bearer ${okLogin.data.token}` };

  // 7. Cédula Express: unknown first -> create payment saves customer -> second lookup auto-recognizes!
  const beforeLookup = await invoke('/api/customers/by-cedula/20123456');
  assert.equal(beforeLookup.status, 200);
  assert.equal(beforeLookup.data.found, false);

  const firstPayment = await invoke('/api/create-payment', {
    amount: 2,
    invoiceName: 'Andres Bello',
    invoiceEmail: 'andres@example.com',
    invoicePhone: '04141234567',
    invoiceId: '20123456'
  }, 'POST');
  assert.equal(firstPayment.status, 200);

  const afterLookup = await invoke('/api/customers/by-cedula/V-20123456');
  assert.equal(afterLookup.status, 200);
  assert.equal(afterLookup.data.found, true);
  assert.equal(afterLookup.data.customer.fullName, 'Andres Bello');
  assert.equal(afterLookup.data.customer.email, 'andres@example.com');
  assert.equal(afterLookup.data.customer.phone, '584141234567');
  assert.equal(afterLookup.data.customer.ordersCount, 1);

  const crmList = await invoke('/api/admin/customers', null, 'GET', authHeader);
  assert.equal(crmList.status, 200);
  assert.equal(crmList.data.data.length, 1);

  // 8. Admin updates company, Evolution API, Resend, and Skylink settings (secrets stay masked!)
  const updatedCfg = await invoke('/api/admin/settings', {
    storeName: 'Bodegon Los Palos Grandes C.A.',
    storeRif: 'J-40998877-1',
    storeAddress: 'Av. Andres Bello, Caracas',
    invoiceFooter: 'Conserve su factura fiscal.',
    whatsappProvider: 'evolution_api',
    evolutionApiUrl: 'https://evo.example.com',
    evolutionInstanceName: 'bodegon_main',
    evolutionApiKey: 'evo-secret-12345',
    resendFromEmail: 'Bodegon <facturas@bodegon.com>',
    resendApiKey: 're_live_secret_9876',
    skylinkCommerceCode: '999888777666',
    skylinkApiKey: 'skylink-secret-5555'
  }, 'PUT', authHeader);
  assert.equal(updatedCfg.status, 200);
  assert.equal(updatedCfg.data.data.storeName, 'Bodegon Los Palos Grandes C.A.');
  assert.equal(updatedCfg.data.data.storeRif, 'J-40998877-1');
  assert.equal(updatedCfg.data.data.whatsappProvider, 'evolution_api');
  assert.equal(updatedCfg.data.data.evolutionApiKeyMasked, '••••••••2345');
  assert.equal(updatedCfg.data.data.resendApiKeyMasked, '••••••••9876');
  assert.equal(updatedCfg.data.data.skylinkApiKeyMasked, '••••••••5555');
  // Never expose raw secrets in public-config
  const pubCfg = await invoke('/api/public-config');
  assert.equal(pubCfg.data.data.storeName, 'Bodegon Los Palos Grandes C.A.');
  assert.equal(pubCfg.data.data.storeRif, 'J-40998877-1');
  assert.equal(pubCfg.data.data.skylinkApiKey, undefined);
  assert.equal(pubCfg.data.data.resendApiKey, undefined);

  // 9. Evolution API dispatch + dynamic store branding in WhatsApp & Email PDF
  let capturedEvoCall = null;
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    capturedEvoCall = { url, opts, body: JSON.parse(opts.body) };
    return { ok: true, status: 201, json: async () => ({ key: { id: 'EVO-MSG-001' } }) };
  };
  try {
    const evoResult = await whatsapp.sendInvoiceWhatsApp({
      orderId: 'AUTO-EVO-1',
      status: 'paid',
      clientName: 'Andres Bello',
      clientId: 'V-20123456',
      clientPhone: '04141234567',
      amountBs: 100,
      amount: 2.5
    }, {
      settings: {
        storeName: 'Bodegon Los Palos Grandes C.A.',
        storeRif: 'J-40998877-1',
        whatsappProvider: 'evolution_api',
        evolutionApiUrl: 'https://evo.example.com',
        evolutionInstanceName: 'bodegon_main',
        evolutionApiKey: 'evo-secret-12345'
      }
    });
    assert.equal(evoResult.status, 'sent');
    assert.equal(evoResult.provider, 'evolution-api');
    assert.equal(capturedEvoCall.url, 'https://evo.example.com/message/sendText/bodegon_main');
    assert.equal(capturedEvoCall.opts.headers.apikey, 'evo-secret-12345');
    assert.match(capturedEvoCall.body.text, /BODEGON LOS PALOS GRANDES C\.A\./);
    assert.match(capturedEvoCall.body.text, /J-40998877-1/);
  } finally {
    global.fetch = origFetch;
  }

  const dynamicPdf = email.buildPdfInvoiceBuffer({
    orderId: 'AUTO-PDF-1',
    clientName: 'Andres Bello',
    clientEmail: 'andres@example.com',
    amountBs: 100,
    amount: 2.5
  }, {
    storeName: 'Bodegon Los Palos Grandes C.A.',
    storeRif: 'J-40998877-1',
    invoiceFooter: 'Conserve su factura fiscal.'
  }).toString('utf8');
  assert.match(dynamicPdf, /BODEGON LOS PALOS GRANDES C\.A\./);
  assert.match(dynamicPdf, /J-40998877-1/);
  assert.match(dynamicPdf, /Conserve su factura fiscal\./);

  // 10. Admin Product CRUD + Re-scan barcode + Bulk CSV Import + Delete
  const createdProd = await invoke('/api/products', {
    name: 'Agua Mineral 1.5L',
    code: '759888001',
    priceBs: 20.00,
    category: 'Bebidas'
  }, 'POST');
  assert.equal(createdProd.status, 201);
  const prodId = createdProd.data.data.id;

  const rescanned = await invoke(`/api/products/${prodId}`, {
    name: 'Agua Mineral 2L',
    priceBs: 25.00,
    barcode: '759888999'
  }, 'PUT', authHeader);
  assert.equal(rescanned.status, 200);
  assert.equal(rescanned.data.data.name, 'Agua Mineral 2L');
  assert.equal(rescanned.data.data.priceBs, 25.00);
  assert.equal(rescanned.data.data.code, '759888999');

  const bulk = await invoke('/api/products/import', {
    items: [
      { barcode: '7599901', name: 'Jugo de Naranja 1L', priceBs: 30, category: 'Bebidas' },
      { barcode: '7599902', name: 'Pan de Molde', priceBs: 28, category: 'Víveres' }
    ]
  }, 'POST', authHeader);
  assert.equal(bulk.status, 200);
  assert.equal(bulk.data.count, 2);

  const deleted = await invoke(`/api/products/${prodId}`, null, 'DELETE', authHeader);
  assert.equal(deleted.status, 200);
});

test('tablet front & rear camera switching, unsharp mask sharpening filter, center-zoom crop, and CSS preview mirroring', async () => {
  const fs = require('fs');
  const path = require('path');

  // 1. Verificar soporte de cámara frontal y filtro Laplaciano en scanner-engine.js
  const engineSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'scanner-engine.js'), 'utf8');
  assert.match(engineSource, /realzarNitidezLaplaciana/, 'Debe incluir función de realce de nitidez Laplaciana');
  assert.match(engineSource, /switchCamera\s*\(/, 'Debe incluir método switchCamera');
  assert.match(engineSource, /this\.facingMode\s*=\s*options\.facingMode/, 'Debe inicializar facingMode');
  assert.match(engineSource, /camera-mirrored/, 'Debe aplicar clase camera-mirrored al usar cámara frontal');
  assert.match(engineSource, /scaleX\(-1\)/, 'Debe invertir el eje X en vista previa para efecto espejo');
  assert.match(engineSource, /realzarContrasteBajaResolucion/, 'Debe retener realce de contraste');

  // 2. Verificar que el algoritmo Laplaciano 3x3 aumenta la diferencia de bordes (foco fijo de tablets)
  const mockCtx = {
    getImageData: () => ({
      data: new Uint8ClampedArray([
        // 3x3 simulación de borde borroso
        100, 100, 100, 255,   110, 110, 110, 255,   120, 120, 120, 255,
        100, 100, 100, 255,   160, 160, 160, 255,   120, 120, 120, 255,
        100, 100, 100, 255,   110, 110, 110, 255,   120, 120, 120, 255
      ])
    }),
    putImageData: (imgData) => {
      // El píxel central (160) tras convolución 5*160 - 110 - 110 - 100 - 120 = 800 - 440 = 360 -> clamped a 255
      assert.ok(imgData.data[16] >= 200, 'El píxel central debe haberse acentuado por encima del umbral borroso');
    }
  };
  const mockWindow = {};
  const fn = new Function('window', 'global', engineSource + '; return window.SkyPayScannerUtils;');
  const utils = fn(mockWindow, mockWindow);
  assert.ok(typeof utils.realzarNitidezLaplaciana === 'function', 'Utils debe exportar realzarNitidezLaplaciana');
  const resSharp = utils.realzarNitidezLaplaciana(mockCtx, 3, 3);
  assert.equal(resSharp, true, 'El filtro debe ejecutarse con éxito');

  // 3. Verificar controles de cambio de cámara y efecto espejo en autopago.html
  const autopagoHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'autopago.html'), 'utf8');
  assert.match(autopagoHtml, /id="btnFlipCamera"/, 'AutoPago debe contener botón btnFlipCamera');
  assert.match(autopagoHtml, /toggleFacingCamera\(\)/, 'AutoPago debe invocar toggleFacingCamera');
  assert.match(autopagoHtml, /currentFacingMode/, 'AutoPago debe gestionar estado currentFacingMode');
  assert.match(autopagoHtml, /realzarNitidezLaplaciana/, 'AutoPago debe aplicar nitidez Laplaciana en el ciclo de escaneo');
  assert.match(autopagoHtml, /\.camera-mirrored/, 'AutoPago debe definir estilo .camera-mirrored');
  assert.match(autopagoHtml, /transform:\s*scaleX\(-1\)/, 'AutoPago debe invertir el video frontal');

  // 4. Verificar controles de cambio de cámara en admin.html
  const adminHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
  assert.match(adminHtml, /id="btnAdminSwitchCam"/, 'Admin debe contener botón btnAdminSwitchCam');
  assert.match(adminHtml, /switchAdminCamera\(\)/, 'Admin debe invocar switchAdminCamera');
  assert.match(adminHtml, /camera-mirrored/, 'Admin debe definir regla espejo para cámara frontal');
});

