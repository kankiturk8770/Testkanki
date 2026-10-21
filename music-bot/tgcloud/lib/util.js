// Small helpers that don't depend on the platform. The runtime has no Node Buffer,
// so base64 and SHA-1 are implemented here.

export const now = () => Math.floor(Date.now() / 1000);

export function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

export function fmtTime(sec) {
  if (!sec) return '--:--';
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';

export function toLatinDigits(s) {
  return s.replace(/[۰-۹٠-٩]/g, (d) => String(FA_DIGITS.indexOf(d) + 1 ? FA_DIGITS.indexOf(d) : AR_DIGITS.indexOf(d)));
}

// '1:23' / '83' / '01:02:03' -> seconds
export function parseTime(s) {
  return toLatinDigits(s).replace('٫', '.').split(':').reduce((acc, p) => acc * 60 + parseFloat(p), 0);
}

// 'برش ۰:۳۰ تا ۱:۰۰' / '45-75' -> [30, 60]
export function parseRange(text) {
  const m = toLatinDigits(text).match(/([\d:.]+)\s*(?:-|تا|to|–)\s*([\d:.]+)/);
  if (!m) return null;
  const a = parseTime(m[1]), b = parseTime(m[2]);
  return isFinite(a) && isFinite(b) && b > a ? [a, b] : null;
}

export function concatBytes(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// sdk fetch exposes the body as text/json or as a stream of Uint8Array chunks.
export async function readBytes(res, max = 30 * 1024 * 1024) {
  const parts = [];
  let size = 0;
  for await (const chunk of res.body) {
    const c = typeof chunk === 'string' ? utf8(chunk) : chunk;
    size += c.length;
    if (size > max) throw new Error('file too large');
    parts.push(c);
  }
  return concatBytes(parts);
}

export function utf8(str) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
  const out = [];
  for (const ch of unescape(encodeURIComponent(str))) out.push(ch.charCodeAt(0));
  return new Uint8Array(out);
}

// ---------- base64 ----------
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_REV = new Uint8Array(128);
for (let i = 0; i < B64.length; i++) B64_REV[B64.charCodeAt(i)] = i;

export function toBase64(bytes) {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += B64[n >> 18] + B64[(n >> 12) & 63] + '==';
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + '=';
  }
  return out;
}

export function fromBase64(str) {
  str = str.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((str.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < str.length; i += 4) {
    const n = (B64_REV[str.charCodeAt(i)] << 18) | (B64_REV[str.charCodeAt(i + 1)] << 12)
      | (B64_REV[str.charCodeAt(i + 2)] << 6) | B64_REV[str.charCodeAt(i + 3)];
    out[o++] = n >> 16;
    if (i + 2 < str.length) out[o++] = (n >> 8) & 255;
    if (i + 3 < str.length) out[o++] = n & 255;
  }
  return out.subarray(0, o);
}

// ---------- SHA-1 / HMAC-SHA1 (ACRCloud request signing) ----------
function sha1(bytes) {
  const ml = bytes.length;
  const withPad = new Uint8Array(((ml + 9 + 63) >> 6) << 6);
  withPad.set(bytes);
  withPad[ml] = 0x80;
  const bits = ml * 8;
  const dv = new DataView(withPad.buffer);
  dv.setUint32(withPad.length - 8, Math.floor(bits / 2 ** 32));
  dv.setUint32(withPad.length - 4, bits >>> 0);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let off = 0; off < withPad.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = (x << 1) | (x >>> 31);
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      const [f, k] = i < 20 ? [(b & c) | (~b & d), 0x5a827999]
        : i < 40 ? [b ^ c ^ d, 0x6ed9eba1]
        : i < 60 ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc]
        : [b ^ c ^ d, 0xca62c1d6];
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  const out = new Uint8Array(20);
  const odv = new DataView(out.buffer);
  [h0, h1, h2, h3, h4].forEach((h, i) => odv.setUint32(i * 4, h));
  return out;
}

export function hmacSha1Base64(key, message) {
  let k = utf8(key);
  if (k.length > 64) k = sha1(k);
  const block = new Uint8Array(64);
  block.set(k);
  const ipad = block.map((b) => b ^ 0x36), opad = block.map((b) => b ^ 0x5c);
  const inner = sha1(concatBytes([ipad, utf8(message)]));
  return toBase64(sha1(concatBytes([opad, inner])));
}
