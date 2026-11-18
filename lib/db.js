const crypto = require('node:crypto');
const path = require('node:path');
const { encryptSecret, decryptSecret, maskSecret, normalizeCedula } = require('./crypto');
const { normalizePhone } = require('./whatsapp');

try {
  process.loadEnvFile(path.join(__dirname, '..', '.env'));
} catch (error) {
  if (error && error.code !== 'ENOENT') {
    // Ignore missing .env in serverless environments
  }
}

const DEFAULT_CATALOG_SEED = [
  { id: 1, name: 'Harina PAN 1kg', code: '7591001', priceBs: 25.00, category: 'Víveres', icon: '🌽', keywords: ['harina pan', 'harina', 'pan'] },
  { id: 2, name: 'Café Molido 100g', code: '7591002', priceBs: 24.50, category: 'Bebidas', icon: '☕', keywords: ['cafe', 'café', 'molido'] },
  { id: 3, name: 'Arroz Blanco 1kg', code: '7591473005492', priceBs: 23.50, category: 'Víveres', icon: '🍚', keywords: ['arroz blanco', 'arroz'] },
  { id: 4, name: 'Pasta Spaghetti 500g', code: '7591003', priceBs: 19.00, category: 'Víveres', icon: '🍝', keywords: ['pasta', 'spaghetti', 'fideos'] },
  { id: 5, name: 'Azúcar Refinada 1kg', code: '7591005', priceBs: 22.00, category: 'Víveres', icon: '🧂', keywords: ['azucar', 'azúcar'] },
  { id: 6, name: 'Aceite Vegetal 500ml', code: '7591006', priceBs: 25.00, category: 'Víveres', icon: '🍳', keywords: ['aceite vegetal', 'aceite'] },
  { id: 7, name: 'Margarina con Sal 250g', code: '7591007', priceBs: 23.00, category: 'Lácteos', icon: '🧈', keywords: ['margarina', 'mavesa', 'mantequilla'] },
  { id: 8, name: 'Leche en Polvo 125g', code: '7591008', priceBs: 24.00, category: 'Lácteos', icon: '🥛', keywords: ['leche', 'leche en polvo'] },
  { id: 9, name: 'Galletas de Vainilla 150g', code: '7591009', priceBs: 18.00, category: 'Snacks', icon: '🍪', keywords: ['galletas', 'maria', 'vainilla'] },
  { id: 10, name: 'Salsa de Tomate 397g', code: '7591010', priceBs: 22.50, category: 'Salsas', icon: '🍅', keywords: ['salsa de tomate', 'ketchup'] },
  { id: 11, name: 'Mayonesa Tradicional 175g', code: '7591011', priceBs: 24.00, category: 'Salsas', icon: '🥣', keywords: ['mayonesa', 'mavesa'] },
  { id: 12, name: 'Refresco Lata 355ml', code: '7591012', priceBs: 20.00, category: 'Bebidas', icon: '🥤', keywords: ['refresco', 'soda', 'lata'] },
  { id: 13, name: 'Atún en Aceite 140g', code: '7591013', priceBs: 25.00, category: 'Víveres', icon: '🐟', keywords: ['atun', 'atún'] },
  { id: 14, name: 'Caraotas Negras 500g', code: '7591014', priceBs: 22.00, category: 'Víveres', icon: '🫘', keywords: ['caraotas', 'frijoles'] }
];

const isTestEnv = process.env.NODE_ENV === 'test' || Boolean(process.env.NODE_TEST_CONTEXT) || process.execArgv.includes('--test');

function getSupabaseConfig() {
  if (isTestEnv && process.env.ALLOW_SUPABASE_IN_TESTS !== '1') {
    return { url: '', key: '', enabled: false };
  }
  const url = (process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const enabled = Boolean(url && key);
  return { url, key, enabled };
}

function isSupabaseEnabled() {
  return getSupabaseConfig().enabled;
}

/**
 * Autentica un usuario administrador directamente contra Supabase Auth (email + password).
 */
async function verifySupabaseAuthAdmin(email, password) {
  const { url, key, enabled } = getSupabaseConfig();
  if (!enabled) return { ok: false, reason: 'Supabase no configurado.' };
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanPass = String(password || '');
  if (!cleanEmail || !cleanPass) return { ok: false, reason: 'Ingresa correo y contraseña.' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({ email: cleanEmail, password: cleanPass }),
      signal: controller.signal
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data && data.access_token && data.user) {
      return { ok: true, user: { id: data.user.id, email: data.user.email } };
    }
    return { ok: false, reason: data?.error_description || data?.msg || 'Credenciales de Supabase Auth inválidas.' };
  } catch (err) {
    return { ok: false, reason: err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function supabaseFetch(tablePath, options = {}) {
  const { url, key, enabled } = getSupabaseConfig();
  if (!enabled) {
    return { ok: false, skipped: true, status: 0, data: null };
  }

  const endpoint = `${url}/rest/v1/${tablePath}`;
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    Accept: 'application/json',
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.prefer ? { Prefer: options.prefer } : {}),
    ...(options.headers || {})
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 8000);

  try {
    const res = await fetch(endpoint, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      console.warn(`[Supabase] ${options.method || 'GET'} ${tablePath} -> HTTP ${res.status}:`, data);
    }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    console.warn(`[Supabase] Error de red en ${tablePath}:`, err.message);
    return { ok: false, status: 0, error: err.message, data: null };
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================================
// Estado fallback en memoria (para tests unitarios y uso sin Supabase)
// ============================================================================
function buildEnvDefaultSettings() {
  return {
    id: 'default',
    storeName: process.env.STORE_NAME || 'Mi Tienda C.A.',
    storeRif: process.env.STORE_RIF || 'J-50733628-0',
    storeAddress: process.env.STORE_ADDRESS || 'Caracas, Venezuela',
    storeCity: process.env.STORE_CITY || 'Caracas',
    storePhone: process.env.STORE_PHONE || '584121234567',
    storeLogoUrl: process.env.STORE_LOGO_URL || '',
    invoiceFooter: process.env.INVOICE_FOOTER || 'Gracias por su compra. Comprobante electrónico autorizado.',
    pricingMode: process.env.PRICING_MODE === 'usd_bcv' ? 'usd_bcv' : 'fixed_bs',
    bcvMode: process.env.BCV_MODE === 'manual' ? 'manual' : 'auto',
    manualBcvRate: Number(process.env.MANUAL_BCV_RATE || 37.50),

    skylinkBaseUrl: (process.env.SKYLINK_BASE_URL || 'https://dev-axis-payment.valinkgroup.com').trim(),
    skylinkCommerceCode: (process.env.SKYLINK_COMMERCE_CODE || '754947900700').trim(),
    skylinkApiKey: (process.env.SKYLINK_API_KEY || '').trim(),

    whatsappProvider: (process.env.WHATSAPP_PROVIDER || 'green_api').trim(),
    greenApiInstanceId: (process.env.GREEN_API_INSTANCE_ID || '').trim(),
    greenApiToken: (process.env.GREEN_API_TOKEN || '').trim(),
    greenApiHost: (process.env.GREEN_API_HOST || 'https://api.green-api.com').trim(),
    evolutionApiUrl: (process.env.EVOLUTION_API_URL || '').trim(),
    evolutionApiKey: (process.env.EVOLUTION_API_KEY || '').trim(),
    evolutionInstanceName: (process.env.EVOLUTION_INSTANCE_NAME || '').trim(),

    resendEnabled: process.env.RESEND_ENABLED !== 'false',
    resendApiKey: (process.env.RESEND_API_KEY || '').trim(),
    resendFromEmail: (process.env.RESEND_FROM_EMAIL || 'SkyPay <onboarding@resend.dev>').trim(),

    webhookUrl: (process.env.WEBHOOK_URL || '').trim(),
    webhookSecret: (process.env.WEBHOOK_SECRET || ('skypay_secret_' + crypto.randomBytes(8).toString('hex'))).trim(),
    updatedAt: new Date().toISOString()
  };
}

let memorySettings = buildEnvDefaultSettings();
let settingsCache = { value: null, expiresAt: 0 };
const memoryCustomers = new Map(); // normalized cedula -> customer
let memoryProducts = DEFAULT_CATALOG_SEED.map(p => ({ ...p, priceUsd: 0, active: true }));
let nextMemoryProductId = 15;
const memoryOrders = new Map(); // id / token / sessionId -> order

function resetMemoryStore() {
  memorySettings = buildEnvDefaultSettings();
  settingsCache = { value: null, expiresAt: 0 };
  memoryCustomers.clear();
  memoryProducts = DEFAULT_CATALOG_SEED.map(p => ({ ...p, priceUsd: 0, active: true }));
  nextMemoryProductId = 15;
  memoryOrders.clear();
}

// ============================================================================
// 1. STORE SETTINGS (White-Label + APIs cifradas)
// ============================================================================
function rowToSettings(row) {
  const envDef = buildEnvDefaultSettings();
  if (!row || typeof row !== 'object') return envDef;

  const decryptedSkylinkKey = decryptSecret(row.skylink_api_key_enc) || envDef.skylinkApiKey;
  const decryptedGreenToken = decryptSecret(row.green_api_token_enc) || envDef.greenApiToken;
  const decryptedEvolutionKey = decryptSecret(row.evolution_api_key_enc) || envDef.evolutionApiKey;
  const decryptedResendKey = decryptSecret(row.resend_api_key_enc) || envDef.resendApiKey;

  return {
    id: row.id || 'default',
    storeName: row.store_name || envDef.storeName,
    storeRif: row.store_rif || envDef.storeRif,
    storeAddress: row.store_address || envDef.storeAddress,
    storeCity: row.store_city || envDef.storeCity,
    storePhone: row.store_phone || envDef.storePhone,
    storeLogoUrl: row.store_logo_url || '',
    invoiceFooter: row.invoice_footer || envDef.invoiceFooter,
    pricingMode: row.pricing_mode === 'usd_bcv' ? 'usd_bcv' : 'fixed_bs',
    bcvMode: row.bcv_mode === 'manual' ? 'manual' : 'auto',
    manualBcvRate: Number(row.manual_bcv_rate || envDef.manualBcvRate),

    skylinkBaseUrl: (row.skylink_base_url || envDef.skylinkBaseUrl).trim(),
    skylinkCommerceCode: (row.skylink_commerce_code || envDef.skylinkCommerceCode).trim(),
    skylinkApiKey: decryptedSkylinkKey,

    whatsappProvider: ['green_api', 'evolution_api', 'disabled'].includes(row.whatsapp_provider)
      ? row.whatsapp_provider
      : envDef.whatsappProvider,
    greenApiInstanceId: (row.green_api_instance_id || envDef.greenApiInstanceId).trim(),
    greenApiToken: decryptedGreenToken,
    greenApiHost: (row.green_api_host || envDef.greenApiHost).trim(),
    evolutionApiUrl: (row.evolution_api_url || envDef.evolutionApiUrl).trim(),
    evolutionApiKey: decryptedEvolutionKey,
    evolutionInstanceName: (row.evolution_instance_name || envDef.evolutionInstanceName).trim(),

    resendEnabled: row.resend_enabled !== undefined ? Boolean(row.resend_enabled) : true,
    resendApiKey: decryptedResendKey,
    resendFromEmail: (row.resend_from_email || envDef.resendFromEmail).trim(),

    webhookUrl: row.webhook_url || '',
    webhookSecret: row.webhook_secret || envDef.webhookSecret,
    updatedAt: row.updated_at || new Date().toISOString()
  };
}

async function getStoreSettings(forceRefresh = false) {
  if (!isSupabaseEnabled()) {
    // Re-sincronizar fallbacks desde process.env si fueron modificados en tiempo de ejecución
    return {
      ...memorySettings,
      skylinkApiKey: memorySettings.skylinkApiKey || (process.env.SKYLINK_API_KEY || '').trim(),
      skylinkCommerceCode: memorySettings.skylinkCommerceCode || (process.env.SKYLINK_COMMERCE_CODE || '754947900700').trim(),
      skylinkBaseUrl: memorySettings.skylinkBaseUrl || (process.env.SKYLINK_BASE_URL || 'https://dev-axis-payment.valinkgroup.com').trim(),
      greenApiInstanceId: memorySettings.greenApiInstanceId || (process.env.GREEN_API_INSTANCE_ID || '').trim(),
      greenApiToken: memorySettings.greenApiToken || (process.env.GREEN_API_TOKEN || '').trim(),
      resendApiKey: memorySettings.resendApiKey || (process.env.RESEND_API_KEY || '').trim(),
      resendFromEmail: memorySettings.resendFromEmail || (process.env.RESEND_FROM_EMAIL || 'SkyPay <onboarding@resend.dev>').trim()
    };
  }

  const now = Date.now();
  if (!forceRefresh && settingsCache.value && now < settingsCache.expiresAt) {
    return settingsCache.value;
  }

  const res = await supabaseFetch('store_settings?id=eq.default&limit=1');
  if (res.ok && Array.isArray(res.data) && res.data.length > 0) {
    const parsed = rowToSettings(res.data[0]);
    settingsCache = { value: parsed, expiresAt: now + 15000 };
    return parsed;
  }

  return memorySettings;
}

function getPublicStoreSettingsFrom(settings) {
  return {
    storeName: settings.storeName,
    storeRif: settings.storeRif,
    storeAddress: settings.storeAddress,
    storeCity: settings.storeCity,
    storePhone: settings.storePhone,
    storeLogoUrl: settings.storeLogoUrl,
    invoiceFooter: settings.invoiceFooter,
    pricingMode: settings.pricingMode,
    bcvMode: settings.bcvMode,
    manualBcvRate: settings.manualBcvRate,
    supabaseConnected: isSupabaseEnabled()
  };
}

function getMaskedAdminSettingsFrom(settings) {
  return {
    storeName: settings.storeName,
    storeRif: settings.storeRif,
    storeAddress: settings.storeAddress,
    storeCity: settings.storeCity,
    storePhone: settings.storePhone,
    storeLogoUrl: settings.storeLogoUrl,
    invoiceFooter: settings.invoiceFooter,
    pricingMode: settings.pricingMode,
    bcvMode: settings.bcvMode,
    manualBcvRate: settings.manualBcvRate,

    skylinkBaseUrl: settings.skylinkBaseUrl,
    skylinkCommerceCode: settings.skylinkCommerceCode,
    skylinkApiKeyConfigured: Boolean(settings.skylinkApiKey),
    skylinkApiKeyMasked: maskSecret(settings.skylinkApiKey),

    whatsappProvider: settings.whatsappProvider,
    greenApiInstanceId: settings.greenApiInstanceId,
    greenApiTokenConfigured: Boolean(settings.greenApiToken),
    greenApiTokenMasked: maskSecret(settings.greenApiToken),
    greenApiHost: settings.greenApiHost,

    evolutionApiUrl: settings.evolutionApiUrl,
    evolutionApiKeyConfigured: Boolean(settings.evolutionApiKey),
    evolutionApiKeyMasked: maskSecret(settings.evolutionApiKey),
    evolutionInstanceName: settings.evolutionInstanceName,

    resendEnabled: settings.resendEnabled,
    resendApiKeyConfigured: Boolean(settings.resendApiKey),
    resendApiKeyMasked: maskSecret(settings.resendApiKey),
    resendFromEmail: settings.resendFromEmail,

    webhookUrl: settings.webhookUrl,
    webhookSecret: settings.webhookSecret,
    supabaseConnected: isSupabaseEnabled(),
    updatedAt: settings.updatedAt
  };
}

async function saveStoreSettings(patch = {}) {
  const current = await getStoreSettings(true);
  const next = { ...current };

  const stringFields = [
    'storeName', 'storeRif', 'storeAddress', 'storeCity', 'storePhone',
    'storeLogoUrl', 'invoiceFooter', 'skylinkBaseUrl', 'skylinkCommerceCode',
    'greenApiInstanceId', 'greenApiHost', 'evolutionApiUrl', 'evolutionInstanceName',
    'resendFromEmail', 'webhookUrl', 'webhookSecret'
  ];

  for (const field of stringFields) {
    if (patch[field] !== undefined && patch[field] !== null) {
      next[field] = String(patch[field]).trim();
    }
  }

  if (patch.pricingMode === 'fixed_bs' || patch.pricingMode === 'usd_bcv') {
    next.pricingMode = patch.pricingMode;
  }
  if (patch.bcvMode === 'auto' || patch.bcvMode === 'manual') {
    next.bcvMode = patch.bcvMode;
  }
  if (patch.manualBcvRate !== undefined && Number.isFinite(Number(patch.manualBcvRate)) && Number(patch.manualBcvRate) > 0) {
    next.manualBcvRate = Number(Number(patch.manualBcvRate).toFixed(4));
  }
  if (['green_api', 'evolution_api', 'disabled'].includes(patch.whatsappProvider)) {
    next.whatsappProvider = patch.whatsappProvider;
  }
  if (patch.resendEnabled !== undefined) {
    next.resendEnabled = Boolean(patch.resendEnabled);
  }

  // Secretos: solo reemplazar si el admin envió un valor nuevo real (no vacío ni enmascarado)
  const isRealSecret = (val) => typeof val === 'string' && val.trim().length > 0 && !val.includes('••••');
  if (isRealSecret(patch.skylinkApiKey)) next.skylinkApiKey = patch.skylinkApiKey.trim();
  if (isRealSecret(patch.greenApiToken)) next.greenApiToken = patch.greenApiToken.trim();
  if (isRealSecret(patch.evolutionApiKey)) next.evolutionApiKey = patch.evolutionApiKey.trim();
  if (isRealSecret(patch.resendApiKey)) next.resendApiKey = patch.resendApiKey.trim();

  next.updatedAt = new Date().toISOString();
  memorySettings = next;
  settingsCache = { value: next, expiresAt: Date.now() + 15000 };

  if (isSupabaseEnabled()) {
    const dbRow = {
      id: 'default',
      store_name: next.storeName,
      store_rif: next.storeRif,
      store_address: next.storeAddress,
      store_city: next.storeCity,
      store_phone: next.storePhone,
      store_logo_url: next.storeLogoUrl,
      invoice_footer: next.invoiceFooter,
      pricing_mode: next.pricingMode,
      bcv_mode: next.bcvMode,
      manual_bcv_rate: next.manualBcvRate,
      skylink_base_url: next.skylinkBaseUrl,
      skylink_commerce_code: next.skylinkCommerceCode,
      skylink_api_key_enc: next.skylinkApiKey ? encryptSecret(next.skylinkApiKey) : '',
      whatsapp_provider: next.whatsappProvider,
      green_api_instance_id: next.greenApiInstanceId,
      green_api_token_enc: next.greenApiToken ? encryptSecret(next.greenApiToken) : '',
      green_api_host: next.greenApiHost,
      evolution_api_url: next.evolutionApiUrl,
      evolution_api_key_enc: next.evolutionApiKey ? encryptSecret(next.evolutionApiKey) : '',
      evolution_instance_name: next.evolutionInstanceName,
      resend_enabled: next.resendEnabled,
      resend_api_key_enc: next.resendApiKey ? encryptSecret(next.resendApiKey) : '',
      resend_from_email: next.resendFromEmail,
      webhook_url: next.webhookUrl,
      webhook_secret: next.webhookSecret,
      updated_at: next.updatedAt
    };

    const res = await supabaseFetch('store_settings?on_conflict=id', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=representation',
      body: dbRow
    });
    if (!res.ok) {
      throw new Error('No se pudo guardar la configuración en Supabase (verifica el esquema SQL).');
    }
  }

  return next;
}

// ============================================================================
// 2. CUSTOMERS CRM (Cédula Express - Registro 1 sola vez)
// ============================================================================
function rowToCustomer(row) {
  if (!row) return null;
  return {
    id: row.id,
    cedula: row.cedula,
    fullName: row.full_name || row.fullName || '',
    email: row.email || '',
    phone: row.phone || '',
    ordersCount: Number(row.orders_count ?? row.ordersCount ?? 0),
    lastOrderAt: row.last_order_at || row.lastOrderAt || null,
    createdAt: row.created_at || row.createdAt || new Date().toISOString(),
    updatedAt: row.updated_at || row.updatedAt || new Date().toISOString()
  };
}

async function findCustomerByCedula(rawCedula) {
  const cedula = normalizeCedula(rawCedula);
  if (!cedula) return null;

  if (isSupabaseEnabled()) {
    const res = await supabaseFetch(`customers?cedula=eq.${encodeURIComponent(cedula)}&limit=1`);
    if (res.ok && Array.isArray(res.data) && res.data.length > 0) {
      const c = rowToCustomer(res.data[0]);
      memoryCustomers.set(cedula, c);
      return c;
    }
    return null;
  }

  return memoryCustomers.get(cedula) || null;
}

async function upsertCustomer({ cedula: rawCedula, fullName, email, phone, incrementOrder = false }) {
  const cedula = normalizeCedula(rawCedula);
  if (!cedula) return null;

  const existing = await findCustomerByCedula(cedula);
  const now = new Date().toISOString();
  const cleanPhone = normalizePhone(phone || existing?.phone || '') || String(phone || existing?.phone || '').replace(/\D/g, '');
  const nextOrdersCount = Number(existing?.ordersCount || 0) + (incrementOrder ? 1 : 0);

  const record = {
    id: existing?.id || crypto.randomUUID(),
    cedula,
    fullName: String(fullName || existing?.fullName || '').trim(),
    email: String(email || existing?.email || '').trim().toLowerCase(),
    phone: cleanPhone,
    ordersCount: nextOrdersCount,
    lastOrderAt: incrementOrder ? now : (existing?.lastOrderAt || null),
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };

  memoryCustomers.set(cedula, record);

  if (isSupabaseEnabled()) {
    const dbRow = {
      cedula: record.cedula,
      full_name: record.fullName,
      email: record.email,
      phone: record.phone,
      orders_count: record.ordersCount,
      last_order_at: record.lastOrderAt,
      updated_at: now
    };
    const res = await supabaseFetch('customers?on_conflict=cedula', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=representation',
      body: dbRow
    });
    if (res.ok && Array.isArray(res.data) && res.data.length > 0) {
      const saved = rowToCustomer(res.data[0]);
      memoryCustomers.set(cedula, saved);
      return saved;
    }
  }

  return record;
}

async function listCustomers(limit = 200) {
  if (isSupabaseEnabled()) {
    const res = await supabaseFetch(`customers?select=*&order=updated_at.desc&limit=${Number(limit) || 200}`);
    if (res.ok && Array.isArray(res.data)) {
      return res.data.map(rowToCustomer);
    }
  }
  return Array.from(memoryCustomers.values()).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

// ============================================================================
// 3. PRODUCTS CATALOG (Supabase + Fallback)
// ============================================================================
function rowToProduct(row) {
  return {
    id: Number(row.id),
    code: String(row.barcode || row.code || '').trim(),
    barcode: String(row.barcode || row.code || '').trim(),
    name: String(row.name || '').trim(),
    priceBs: Number(row.price_bs ?? row.priceBs ?? 0),
    priceUsd: Number(row.price_usd ?? row.priceUsd ?? 0),
    category: row.category || 'General',
    icon: row.icon || '📦',
    keywords: Array.isArray(row.keywords) ? row.keywords : [],
    active: row.active !== undefined ? Boolean(row.active) : true
  };
}

function buildKeywords(name, category) {
  const words = `${name || ''} ${category || ''}`
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(w => w.length >= 3);
  return Array.from(new Set(words)).slice(0, 8);
}

async function listProducts(includeInactive = false) {
  if (isSupabaseEnabled()) {
    const filter = includeInactive ? '' : '&active=eq.true';
    const res = await supabaseFetch(`products?select=*${filter}&order=id.asc`);
    if (res.ok && Array.isArray(res.data)) {
      if (res.data.length > 0) {
        return res.data.map(rowToProduct);
      }
      // Si la tabla está vacía, devolver arreglo vacío (o productos creados)
      return [];
    }
  }
  return memoryProducts.filter(p => includeInactive || p.active !== false);
}

async function findProductByBarcode(code) {
  const clean = String(code || '').trim();
  if (!clean) return null;

  if (isSupabaseEnabled()) {
    const res = await supabaseFetch(`products?barcode=eq.${encodeURIComponent(clean)}&limit=1`);
    if (res.ok && Array.isArray(res.data) && res.data.length > 0) {
      return rowToProduct(res.data[0]);
    }
    return null;
  }

  return memoryProducts.find(p => p.code === clean || p.barcode === clean) || null;
}

async function createOrUpdateProduct(data, currentBcvRate = 37.50) {
  const name = String(data.name || '').trim();
  const code = String(data.code || data.barcode || ('759' + Math.floor(100000 + Math.random() * 900000))).trim();
  const category = String(data.category || 'General').trim();
  const icon = String(data.icon || '📦').trim();
  let priceBs = Number(data.priceBs ?? data.price_bs ?? 0);
  let priceUsd = Number(data.priceUsd ?? data.price_usd ?? 0);

  if (priceBs <= 0 && priceUsd > 0) {
    priceBs = Number((priceUsd * currentBcvRate).toFixed(2));
  } else if (priceUsd <= 0 && priceBs > 0 && currentBcvRate > 0) {
    priceUsd = Number((priceBs / currentBcvRate).toFixed(4));
  }

  const keywords = Array.isArray(data.keywords) && data.keywords.length > 0
    ? data.keywords
    : buildKeywords(name, category);

  if (isSupabaseEnabled()) {
    const dbRow = {
      barcode: code,
      name,
      price_bs: Number(priceBs.toFixed(2)),
      price_usd: Number(priceUsd.toFixed(4)),
      category,
      icon,
      keywords,
      active: data.active !== undefined ? Boolean(data.active) : true,
      updated_at: new Date().toISOString()
    };

    const res = await supabaseFetch('products?on_conflict=barcode', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=representation',
      body: dbRow
    });
    if (res.ok && Array.isArray(res.data) && res.data.length > 0) {
      return { product: rowToProduct(res.data[0]), updated: false };
    }
    throw new Error('No se pudo guardar el producto en Supabase.');
  }

  const existingIndex = memoryProducts.findIndex(p => p.code === code || p.barcode === code);
  if (existingIndex >= 0) {
    const updated = {
      ...memoryProducts[existingIndex],
      name,
      code,
      barcode: code,
      priceBs: Number(priceBs.toFixed(2)),
      priceUsd: Number(priceUsd.toFixed(4)),
      category,
      icon,
      keywords,
      active: data.active !== undefined ? Boolean(data.active) : true
    };
    memoryProducts[existingIndex] = updated;
    return { product: updated, updated: true };
  }

  const created = {
    id: nextMemoryProductId++,
    name,
    code,
    barcode: code,
    priceBs: Number(priceBs.toFixed(2)),
    priceUsd: Number(priceUsd.toFixed(4)),
    category,
    icon,
    keywords,
    active: true
  };
  memoryProducts.push(created);
  return { product: created, updated: false };
}

async function updateProduct(id, patch = {}, currentBcvRate = 37.50) {
  const numId = Number(id);
  if (!Number.isFinite(numId)) return null;

  const updates = {};
  if (patch.name !== undefined) updates.name = String(patch.name).trim();
  if (patch.code !== undefined || patch.barcode !== undefined) {
    updates.barcode = String(patch.barcode ?? patch.code).trim();
  }
  if (patch.category !== undefined) updates.category = String(patch.category).trim();
  if (patch.icon !== undefined) updates.icon = String(patch.icon).trim();
  if (patch.active !== undefined) updates.active = Boolean(patch.active);

  if (patch.priceBs !== undefined || patch.price_bs !== undefined) {
    const bs = Number(patch.priceBs ?? patch.price_bs);
    if (Number.isFinite(bs) && bs > 0) {
      updates.price_bs = Number(bs.toFixed(2));
      if (patch.priceUsd === undefined && patch.price_usd === undefined && currentBcvRate > 0) {
        updates.price_usd = Number((bs / currentBcvRate).toFixed(4));
      }
    }
  }
  if (patch.priceUsd !== undefined || patch.price_usd !== undefined) {
    const usd = Number(patch.priceUsd ?? patch.price_usd);
    if (Number.isFinite(usd) && usd > 0) {
      updates.price_usd = Number(usd.toFixed(4));
      if (patch.priceBs === undefined && patch.price_bs === undefined && currentBcvRate > 0) {
        updates.price_bs = Number((usd * currentBcvRate).toFixed(2));
      }
    }
  }

  if (updates.name || updates.category) {
    updates.keywords = buildKeywords(updates.name || '', updates.category || '');
  }
  updates.updated_at = new Date().toISOString();

  if (isSupabaseEnabled()) {
    const res = await supabaseFetch(`products?id=eq.${numId}`, {
      method: 'PATCH',
      prefer: 'return=representation',
      body: updates
    });
    if (res.ok && Array.isArray(res.data) && res.data.length > 0) {
      return rowToProduct(res.data[0]);
    }
    if (res.status === 409) {
      const err = new Error('Ya existe otro producto con ese código de barras.');
      err.httpStatus = 409;
      throw err;
    }
    return null;
  }

  const idx = memoryProducts.findIndex(p => Number(p.id) === numId);
  if (idx === -1) return null;

  if (updates.barcode) {
    const conflict = memoryProducts.find((p, i) => i !== idx && (p.code === updates.barcode || p.barcode === updates.barcode));
    if (conflict) {
      const err = new Error('Ya existe otro producto con ese código de barras.');
      err.httpStatus = 409;
      throw err;
    }
  }

  const cur = memoryProducts[idx];
  const merged = {
    ...cur,
    ...(updates.name ? { name: updates.name } : {}),
    ...(updates.barcode ? { code: updates.barcode, barcode: updates.barcode } : {}),
    ...(updates.category ? { category: updates.category } : {}),
    ...(updates.icon ? { icon: updates.icon } : {}),
    ...(updates.active !== undefined ? { active: updates.active } : {}),
    ...(updates.price_bs !== undefined ? { priceBs: updates.price_bs } : {}),
    ...(updates.price_usd !== undefined ? { priceUsd: updates.price_usd } : {}),
    ...(updates.keywords ? { keywords: updates.keywords } : {})
  };
  memoryProducts[idx] = merged;
  return merged;
}

async function deleteProduct(id) {
  const numId = Number(id);
  if (!Number.isFinite(numId)) return false;

  if (isSupabaseEnabled()) {
    const res = await supabaseFetch(`products?id=eq.${numId}`, { method: 'DELETE' });
    return res.ok;
  }

  const before = memoryProducts.length;
  memoryProducts = memoryProducts.filter(p => Number(p.id) !== numId);
  return memoryProducts.length < before;
}

async function bulkUpsertProducts(items = [], currentBcvRate = 37.50) {
  const results = [];
  for (const raw of items) {
    if (!raw || !raw.name) continue;
    const priceVal = Number(raw.priceBs ?? raw.price_bs ?? raw.price ?? 0);
    const priceUsdVal = Number(raw.priceUsd ?? raw.price_usd ?? 0);
    if (priceVal <= 0 && priceUsdVal <= 0) continue;
    const saved = await createOrUpdateProduct({
      name: raw.name,
      code: raw.code || raw.barcode,
      priceBs: priceVal,
      priceUsd: priceUsdVal,
      category: raw.category || 'General',
      icon: raw.icon || '📦'
    }, currentBcvRate);
    results.push(saved.product);
  }
  return results;
}

// ============================================================================
// 4. ORDERS PERSISTENCE (Supabase + Fallback)
// ============================================================================
function rowToOrder(row) {
  if (!row) return null;
  const snapshot = row.store_snapshot && typeof row.store_snapshot === 'object' ? row.store_snapshot : {};
  return {
    orderId: row.id,
    identifier: row.id,
    token: row.token || '',
    sessionId: row.session_id || '',
    source: row.source || 'kiosk',
    status: row.status || 'pending',
    description: row.description || '',
    amountBs: Number(row.amount_bs || 0),
    amountVes: Number(row.amount_bs || 0),
    amount: Number(row.amount_usd || 0),
    bcvRate: Number(row.bcv_rate || 37.50),
    items: Array.isArray(row.items) ? row.items : [],
    customerId: row.customer_id || null,
    clientName: row.client_name || '',
    clientId: row.client_cedula || '',
    clientEmail: row.client_email || '',
    invoiceEmail: row.client_email || '',
    clientPhone: row.client_phone || '',
    invoicePhone: row.client_phone || '',
    invoice: {
      name: row.client_name || '',
      idNumber: row.client_cedula || '',
      phone: row.client_phone || '',
      email: row.client_email || ''
    },
    reference: row.reference || '',
    paymentMethod: row.payment_method || '',
    paymentUrl: row.payment_url || '',
    skylinkPayUrl: row.payment_url || '',
    storeName: snapshot.storeName || '',
    storeRif: snapshot.storeRif || '',
    storeAddress: snapshot.storeAddress || '',
    storeCity: snapshot.storeCity || '',
    storePhone: snapshot.storePhone || '',
    invoiceFooter: snapshot.invoiceFooter || '',
    whatsappDispatch: row.whatsapp_dispatch || null,
    emailDispatch: row.email_dispatch || null,
    shippingData: row.shipping_data || null,
    paidAt: row.paid_at || null,
    createdAt: row.created_at || new Date().toISOString()
  };
}

function indexMemoryOrder(order) {
  for (const key of [order.identifier, order.orderId, order.sessionId, order.token]) {
    if (key) memoryOrders.set(key, order);
  }
}

async function saveOrder(order) {
  if (!order) return order;
  const id = order.orderId || order.identifier;
  if (!id) return order;

  indexMemoryOrder(order);

  if (isSupabaseEnabled()) {
    const dbRow = {
      id,
      token: order.token || null,
      session_id: order.sessionId || null,
      source: order.source || 'kiosk',
      status: order.status || 'pending',
      description: order.description || '',
      amount_bs: Number(order.amountBs ?? order.amountVes ?? 0),
      amount_usd: Number(order.amount ?? 0),
      bcv_rate: Number(order.bcvRate || 37.50),
      items: Array.isArray(order.items) ? order.items : [],
      customer_id: order.customerId || null,
      client_name: order.clientName || order.invoice?.name || '',
      client_cedula: order.clientId || order.invoice?.idNumber || '',
      client_email: order.clientEmail || order.invoiceEmail || order.invoice?.email || '',
      client_phone: order.clientPhone || order.invoicePhone || order.invoice?.phone || '',
      reference: order.reference || '',
      payment_method: order.paymentMethod || '',
      payment_url: order.paymentUrl || order.skylinkPayUrl || '',
      store_snapshot: {
        storeName: order.storeName || '',
        storeRif: order.storeRif || '',
        storeAddress: order.storeAddress || '',
        storeCity: order.storeCity || '',
        storePhone: order.storePhone || '',
        invoiceFooter: order.invoiceFooter || ''
      },
      whatsapp_dispatch: order.whatsappDispatch || null,
      email_dispatch: order.emailDispatch || null,
      shipping_data: order.shippingData || null,
      paid_at: order.paidAt || null,
      updated_at: new Date().toISOString()
    };

    await supabaseFetch('orders?on_conflict=id', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: dbRow
    });
  }

  return order;
}

async function getOrderByAnyKey(key) {
  if (!key) return null;
  const cached = memoryOrders.get(key);
  if (cached && !isSupabaseEnabled()) return cached;

  if (isSupabaseEnabled()) {
    const encoded = encodeURIComponent(key);
    const res = await supabaseFetch(`orders?or=(id.eq.${encoded},token.eq.${encoded},session_id.eq.${encoded})&limit=1`);
    if (res.ok && Array.isArray(res.data) && res.data.length > 0) {
      const fromDb = rowToOrder(res.data[0]);
      // Preservar flags transitorios de concurrencia si ya estaba en memoria
      if (cached) {
        fromDb._dispatchingWhatsApp = cached._dispatchingWhatsApp;
        fromDb._dispatchingEmail = cached._dispatchingEmail;
      }
      indexMemoryOrder(fromDb);
      return fromDb;
    }
  }

  return cached || null;
}

async function listOrders(limit = 100) {
  if (isSupabaseEnabled()) {
    const res = await supabaseFetch(`orders?select=*&order=created_at.desc&limit=${Number(limit) || 100}`);
    if (res.ok && Array.isArray(res.data)) {
      return res.data.map(rowToOrder);
    }
  }
  const unique = Array.from(new Set(memoryOrders.values()));
  return unique.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, limit);
}

async function listPendingOrders(maxAgeMinutes = 45, limit = 15) {
  const cutoffIso = new Date(Date.now() - maxAgeMinutes * 60 * 1000).toISOString();
  if (isSupabaseEnabled()) {
    const res = await supabaseFetch(
      `orders?select=*&status=eq.pending&created_at=gte.${encodeURIComponent(cutoffIso)}&order=created_at.desc&limit=${Number(limit) || 15}`
    );
    if (res.ok && Array.isArray(res.data)) {
      return res.data.map(rowToOrder);
    }
  }
  const unique = Array.from(new Set(memoryOrders.values()));
  return unique
    .filter(o => o.status === 'pending' && o.token && new Date(o.createdAt).toISOString() >= cutoffIso)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, limit);
}

module.exports = {
  isSupabaseEnabled,
  verifySupabaseAuthAdmin,
  resetMemoryStore,
  getStoreSettings,
  getPublicStoreSettingsFrom,
  getMaskedAdminSettingsFrom,
  saveStoreSettings,
  findCustomerByCedula,
  upsertCustomer,
  listCustomers,
  listProducts,
  findProductByBarcode,
  createOrUpdateProduct,
  updateProduct,
  deleteProduct,
  bulkUpsertProducts,
  saveOrder,
  getOrderByAnyKey,
  listOrders,
  listPendingOrders
};
