// Shazam on the server: fingerprints made by shazamio-core (converted to plain JS, see shazam_core.js),
// looked up with Shazam's own API. Works for mp3 / m4a / mp4 (Instagram, TikTok, videos, audio files)
// and, through lib/opus.js, for Telegram voice messages (ogg/opus).
import { fetch } from 'sdk';
import { initShazam, recognizeBytes } from './shazam_core.js';
import { decodeOggOpus } from './opus.js';

const uuid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'
  .replace(/[xy]/g, (c) => ((Math.random() * 16) | (c === 'x' ? 0 : 8)).toString(16).toUpperCase());

/** -> { title, artist, album, cover, engine } or null */
export async function shazamLookup(uri, samplems) {
  if (!/^data:audio\/vnd\.shazam\.sig;base64,/.test(uri)) return null;
  const url = `https://amp.shazam.com/discovery/v5/en-US/GB/iphone/-/tag/${uuid()}/${uuid()}`
    + '?sync=true&webv3=true&sampling=true&connected=&shazamapiversion=v3&sharehub=true&hubv5minorversion=v5.1&hidelb=true&video=v3';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', Accept: '*/*', 'Accept-Language': 'en-US',
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
      'X-Shazam-Platform': 'IPHONE', 'X-Shazam-AppVersion': '14.1.0',
    },
    body: JSON.stringify({ timezone: 'Europe/Berlin', signature: { uri, samplems: Math.round(samplems) }, timestamp: Date.now(), context: {}, geolocation: {} }),
  });
  if (!res.ok) throw new Error(`shazam ${res.status}`);
  const t = (await res.json())?.track;
  if (!t) return null;
  const album = (t.sections || []).flatMap((s) => s.metadata || []).find((m) => m.title === 'Album')?.text || null;
  return { title: t.title, artist: t.subtitle || null, album, cover: t.images?.coverart || null, engine: 'Shazam' };
}

// 16-bit mono WAV around PCM samples: shazamio-core's own decoder path is ~50x faster than
// handing it raw floats.
function wav(pcm, rate) {
  const b = new Uint8Array(44 + pcm.length * 2), v = new DataView(b.buffer);
  const tag = (o, t) => { for (let i = 0; i < 4; i++) b[o + i] = t.charCodeAt(i); };
  tag(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  tag(36, 'data'); v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 32767, true);
  return b;
}

const isOgg = (b) => b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53;

/**
 * Fingerprints from the start of a file. The sandbox has a CPU budget of a few seconds per call,
 * so: voice notes (cheap to decode) give up to two 12 s windows, other files the first 12 s.
 */
function signatures(bytes) {
  initShazam();
  if (isOgg(bytes)) {
    const { pcm, sampleRate } = decodeOggOpus(bytes, 24);
    const out = [];
    for (let s = 0; s + sampleRate * 3 <= pcm.length && out.length < 2; s += sampleRate * 12) {
      out.push(...recognizeBytes(wav(pcm.subarray(s, s + sampleRate * 12), sampleRate)));
    }
    return out;
  }
  return recognizeBytes(bytes);
}

/** Recognise a voice note / video / audio file / reel. -> match or null */
export async function shazamBytes(bytes) {
  let sigs;
  try {
    sigs = signatures(bytes);
  } catch (e) {
    console.warn('shazam: cannot read this file', e.message);
    return null;
  }
  try {
    for (const sig of sigs) {
      const m = await shazamLookup(sig.uri, sig.samplems);
      if (m) return m;
    }
    return null;
  } finally {
    for (const sig of sigs) sig.free();
  }
}
