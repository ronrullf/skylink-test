const crypto = require('node:crypto');
const path = require('node:path');

try {
  process.loadEnvFile(path.join(__dirname, '..', '.env'));
} catch (error) {
  if (error && error.code !== 'ENOENT') {
    // Ignore missing .env in serverless environments
  }
}

const ADMIN_COOKIE_NAME = 'skypay_admin_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 horas

function getEncryptionKey() {
  const raw = (
    process.env.SETTINGS_ENCRYPTION_KEY ||
    process.env.ADMIN_PASSWORD ||
    process.env.SKYLINK_API_KEY ||
    'skypay-mvp-default-encryption-seed-change-in-prod'
  ).trim();
  return crypto.createHash('sha256').update(raw, 'utf8').digest();
}

function getSessionSecret() {
  const raw = (
    process.env.SETTINGS_ENCRYPTION_KEY ||
    process.env.ADMIN_PASSWORD ||
    'skypay-mvp-session-secret'
  ).trim();
  return crypto.createHash('sha256').update('session:' + raw, 'utf8').digest('hex');
}

function getAdminPassword() {
  return (process.env.ADMIN_PASSWORD || 'admin1234').trim();
}

/**
 * Cifra un secreto usando AES-256-GCM (formato: enc:v1:ivHex:tagHex:dataHex)
 */
function encryptSecret(plaintext) {
  const value = String(plaintext || '').trim();
  if (!value) return '';
  if (value.startsWith('enc:v1:')) return value;

  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Descifra un secreto AES-256-GCM. Si el valor está en texto plano (legacy), lo devuelve tal cual.
 */
function decryptSecret(ciphertext) {
  const value = String(ciphertext || '').trim();
  if (!value) return '';
  if (!value.startsWith('enc:v1:')) return value;

  try {
    const parts = value.split(':');
    if (parts.length !== 5) return '';
    const iv = Buffer.from(parts[2], 'hex');
    const tag = Buffer.from(parts[3], 'hex');
    const encrypted = Buffer.from(parts[4], 'hex');
    const key = getEncryptionKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch (err) {
    console.warn('[Crypto] No se pudo descifrar un secreto (verifica SETTINGS_ENCRYPTION_KEY):', err.message);
    return '';
  }
}

/**
 * Enmascara un secreto para mostrarlo de forma segura en la UI de administración.
 */
function maskSecret(value) {
  const plain = String(value || '').trim();
  if (!plain) return '';
  if (plain.length <= 4) return '••••';
  return '••••••••' + plain.slice(-4);
}

/**
 * Normaliza Cédula / RIF venezolana:
 * "12.345.678" -> "V-12345678"
 * "v12345678"  -> "V-12345678"
 * "J-507336280" -> "J-507336280"
 */
function normalizeCedula(raw) {
  if (!raw) return '';
  const cleaned = String(raw).trim().toUpperCase().replace(/[\s.]/g, '');
  const match = cleaned.match(/^([VEJG])?-?(\d{5,10})$/i);
  if (!match) return '';
  const prefix = (match[1] || 'V').toUpperCase();
  const digits = match[2];
  return `${prefix}-${digits}`;
}

function createAdminToken() {
  const exp = Date.now() + SESSION_TTL_MS;
  const nonce = crypto.randomBytes(8).toString('hex');
  const payload = `admin.${exp}.${nonce}`;
  const sig = crypto.createHmac('sha256', getSessionSecret()).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function verifyAdminToken(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'admin') return false;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || Date.now() > exp) return false;
  const payload = `${parts[0]}.${parts[1]}.${parts[2]}`;
  const expectedSig = crypto.createHmac('sha256', getSessionSecret()).update(payload).digest('hex');
  const actualBuf = Buffer.from(parts[3], 'utf8');
  const expectedBuf = Buffer.from(expectedSig, 'utf8');
  if (actualBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(actualBuf, expectedBuf);
}

function verifyAdminPassword(candidate) {
  const actual = Buffer.from(String(candidate || '').trim(), 'utf8');
  const expected = Buffer.from(getAdminPassword(), 'utf8');
  if (actual.length === 0 || actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function parseCookies(cookieHeader) {
  const result = {};
  if (!cookieHeader || typeof cookieHeader !== 'string') return result;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) result[key] = decodeURIComponent(val);
  }
  return result;
}

function extractAdminTokenFromReq(req) {
  const auth = req.headers?.authorization || req.headers?.Authorization || '';
  if (auth.startsWith('Bearer ')) {
    return auth.slice(7).trim();
  }
  const cookies = parseCookies(req.headers?.cookie || '');
  return cookies[ADMIN_COOKIE_NAME] || '';
}

module.exports = {
  ADMIN_COOKIE_NAME,
  encryptSecret,
  decryptSecret,
  maskSecret,
  normalizeCedula,
  createAdminToken,
  verifyAdminToken,
  verifyAdminPassword,
  getAdminPassword,
  parseCookies,
  extractAdminTokenFromReq
};
