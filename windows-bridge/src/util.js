/**
 * Shared helpers: clock, JSON responses, body limits, constant-time token compare.
 * No third-party dependencies on purpose: the bridge must run on a bare Node install.
 */
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';

export const PROTOCOL = 'v1.1';
export const SERVER_NAME = 'ldplayer-via-dsh-bridge';
export const SERVER_VERSION = '0.2.0';

export function nowIso(date = new Date()) {
  return date.toISOString();
}

export function nowMs() {
  return Date.now();
}

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/**
 * Constant-time comparison of two secrets.
 * Hashing first keeps the comparison length-safe (timingSafeEqual throws on
 * unequal lengths, which would itself leak the token length).
 */
export function tokenMatches(supplied, expected) {
  if (typeof supplied !== 'string' || typeof expected !== 'string') return false;
  if (!supplied || !expected) return false;
  const a = crypto.createHash('sha256').update(supplied, 'utf8').digest();
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

export function generateToken(bytes = 48) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function maskToken(token) {
  if (typeof token !== 'string' || token.length < 8) return '****';
  return `${token.slice(0, 4)}…${token.slice(-4)} (len=${token.length})`;
}

export function sendJson(res, status, payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  res.end(body);
}

/**
 * Reads a JSON body with a hard byte cap. Never buffers more than cap + 1 byte,
 * so an oversized client cannot exhaust memory.
 */
export function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      // Drain instead of destroy: destroying here would cut the socket before
      // the 413 response reaches the client ("fetch failed" on its side).
      req.removeAllListeners('data');
      req.on('error', () => {});
      req.resume();
      reject(err);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        fail(new HttpError(413, 'body_too_large', `请求体超过 ${maxBytes} 字节上限。`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(new HttpError(400, 'invalid_json', '请求体必须是 JSON 对象。'));
        }
        resolve(parsed);
      } catch {
        reject(new HttpError(400, 'invalid_json', '请求体不是合法 JSON。'));
      }
    });
    req.on('error', (err) => fail(err));
  });
}

export function isLoopback(address) {
  if (!address) return false;
  const normalized = address.startsWith('::ffff:') ? address.slice(7) : address;
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost';
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

/** Atomic write: temp file in the same directory, then rename. */
export async function writeFileAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, data, 'utf8');
  await fs.rename(tmp, file);
}

export function isoPlusSeconds(iso, seconds) {
  const base = iso ? Date.parse(iso) : Date.now();
  return new Date(base + seconds * 1000).toISOString();
}

export function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
