// 会員・スタッフの認証に使う部品（パスワード、二段階認証、乱数、電話番号）。外部のライブラリは使わず、Node.js の標準だけで書く。
import crypto from 'node:crypto';

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (text) => crypto.createHash('sha256').update(String(text)).digest('hex');

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---- パスワード（scrypt）。保存するのは「方式$塩$ハッシュ」
const SCRYPT = { N: 16384, r: 8, p: 1 };
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 32, SCRYPT);
  return ['scrypt', salt.toString('base64url'), hash.toString('base64url')].join('$');
}
export function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const actual = crypto.scryptSync(String(password), Buffer.from(salt, 'base64url'), 32, SCRYPT);
  return crypto.timingSafeEqual(actual, Buffer.from(hash, 'base64url'));
}

// ---- 二段階認証（TOTP、RFC 6238。認証アプリと同じ: SHA-1・6桁・30秒）
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(text) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of String(text).replace(/=+$/, '').toUpperCase()) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('base32 ではありません');
    value = ((value << 5) | idx) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
export const newTotpSecret = () => base32Encode(crypto.randomBytes(20));
export function totp(secret, at = Date.now(), step = 30) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / step)));
  const mac = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, '0');
}
/** 前後1つ分（±30秒）のずれまで認める */
export function verifyTotp(secret, code, at = Date.now()) {
  const given = String(code ?? '').trim();
  if (!/^\d{6}$/.test(given)) return false;
  return [-1, 0, 1].some((d) => safeEqual(totp(secret, at + d * 30000), given));
}
export const otpauthUrl = (secret, account, issuer = 'Reiwa no Seri') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}`;

// ---- SMS の認証番号（6桁）
export const newOtpCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');

/**
 * 電話番号をそろえる（日本国内の番号だけ。本仕様 6章の前提）。
 * 全角の数字を半角に直し、数字以外を落とし、+81 を 0 に直す。0 から始まる 10〜11 桁だけを通す。
 */
export function normalizePhone(input) {
  let digits = String(input ?? '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/＋/g, '+')
    .replace(/[^\d+]/g, '');
  if (digits.startsWith('+81')) digits = '0' + digits.slice(3);
  if (!/^0\d{9,10}$/.test(digits)) return null;
  return digits;
}
export const isEmail = (text) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(text ?? '')) && String(text).length <= 254;

/**
 * 利用者の接続元。手前にプロキシがあるとき（POC_TRUST_PROXY=1）は、プロキシが付けた x-real-ip を使う
 * （付けなければ、全員が同じ接続元に見えて、1人の連打で全員のログインが止まる）。
 * x-real-ip は、入口（Cloudflare の Worker・Caddy）が、利用者から届いた同名のヘッダーを上書きして付ける。
 */
export function clientIp(req, config) {
  const real = config.trustProxy ? String(req.headers['x-real-ip'] ?? '').trim() : '';
  return real && real.length <= 64 ? real : req.socket.remoteAddress;
}
