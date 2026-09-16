/**
 * Token encryption utility for Page access tokens.
 * Uses AES-256-GCM with server-side secret from PAGE_TOKEN_SECRET env var.
 */
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

function getKey() {
  const secret = process.env.PAGE_TOKEN_SECRET;
  if (!secret) {
    console.warn('[TOKEN_ENCRYPT] ?? PAGE_TOKEN_SECRET not set. Token encryption will use fallback key.');
    return crypto.createHash('sha256').update('default-insecure-key-change-me').digest();
  }
  return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Encrypt a plaintext string.
 * @param {string} plaintext
 * @returns {string} Format: iv:authTag:ciphertext (all hex)
 */
function encryptToken(plaintext) {
  if (!plaintext) return '';
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Decrypt an encrypted token string.
 * @param {string} encrypted Format: iv:authTag:ciphertext (all hex)
 * @returns {string} Plaintext token
 */
function decryptToken(encrypted) {
  if (!encrypted) return '';
  const parts = encrypted.split(':');
  if (parts.length !== 3) {
    console.error('[TOKEN_ENCRYPT] Invalid encrypted token format');
    return '';
  }
  const [ivHex, authTagHex, ciphertext] = parts;
  const key = getKey();
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

module.exports = { encryptToken, decryptToken };
