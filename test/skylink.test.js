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
    ['/api/create-payment', { amount: 1, invoiceName: 'María Pérez', invoiceId: 'V-12345678' }],
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
      ? { amount: 1, invoiceName: 'María Pérez', invoiceId: 'V-12345678' }
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
    amount: 1, invoiceName: 'María Pérez', invoiceId: 'V-12345678'
  });
  assert.equal(created.status, 200);
  const order = await invoke(`/api/order-status/${created.data.data.identifier}`, null, 'GET');
  assert.equal(order.data.data.status, 'paid');
  assert.equal(order.data.data.reference, 'BANK-001');
  assert.equal(order.data.data.invoice.name, 'María Pérez');
  assert.equal(order.data.data.invoice.idNumber, 'V-12345678');
});

test('kiosk defers Skylink until the separate invoice-data step', () => {
  const productsPage = fs.readFileSync(require.resolve('../public/autopago.html'), 'utf8');
  const invoiceDataPage = fs.readFileSync(require.resolve('../public/datos-factura.html'), 'utf8');

  assert.doesNotMatch(productsPage, /\/api\/create-payment/);
  assert.match(productsPage, /window\.location\.href = '\/datos-factura'/);
  assert.match(invoiceDataPage, /Nombre y apellido/);
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
