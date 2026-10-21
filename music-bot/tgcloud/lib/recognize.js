// Song recognition through HTTP APIs (fingerprinting itself can't run in the sandbox).
//
// Order, stopping at the first hit:
//   1. AudD                 (/set audd_token …)            fingerprint, big catalogue incl. local songs
//   2. ACRCloud music       (/set acr_host, acr_key, acr_secret)        fingerprint, remixes/covers
//   3. ACRCloud humming     (/set acr_hum_key, acr_hum_secret)          user hums / sings the melody
//   4. Speech-to-text of what the user sang (/set stt_key; Groq or OpenAI Whisper)
//      -> Genius lyrics search (/set genius_token) -> normal search
import { fetch, FormData, InputFile } from 'sdk';
import { getSetting } from './store.js';
import { hmacSha1Base64, now } from './util.js';

const ACR_MAX = 5 * 1024 * 1024;

async function audd(sample) {
  const token = await getSetting('audd_token');
  if (!token) return null;
  const form = new FormData();
  form.append('api_token', token);
  form.append('return', 'spotify');
  form.append('file', new InputFile(sample.bytes, sample.name, { type: sample.mime }));
  const j = await (await fetch('https://api.audd.io/', { method: 'POST', body: form })).json();
  const r = j?.result;
  return r ? { title: r.title, artist: r.artist, album: r.album, engine: 'AudD', cover: r.spotify?.album?.images?.[0]?.url } : null;
}

async function acr(sample, humming) {
  const host = (await getSetting('acr_host')) || 'identify-eu-west-1.acrcloud.com';
  const key = await getSetting(humming ? 'acr_hum_key' : 'acr_key');
  const secret = await getSetting(humming ? 'acr_hum_secret' : 'acr_secret');
  if (!key || !secret || sample.bytes.length > ACR_MAX) return null;
  const ts = String(now());
  const signature = hmacSha1Base64(secret, ['POST', '/v1/identify', key, 'audio', '1', ts].join('\n'));
  const form = new FormData();
  form.append('access_key', key);
  form.append('data_type', 'audio');
  form.append('signature_version', '1');
  form.append('signature', signature);
  form.append('sample_bytes', String(sample.bytes.length));
  form.append('timestamp', ts);
  form.append('sample', new InputFile(sample.bytes, sample.name, { type: sample.mime }));
  const j = await (await fetch(`https://${host}/v1/identify`, { method: 'POST', body: form })).json();
  const items = (humming ? j?.metadata?.humming : j?.metadata?.music) || j?.metadata?.music || [];
  const it = items[0];
  if (!it) return null;
  return {
    title: it.title,
    artist: (it.artists || []).map((a) => a.name).filter(Boolean).join(', ') || null,
    album: it.album?.name || null,
    youtubeId: it.external_metadata?.youtube?.vid || null,
    engine: humming ? 'ACRCloud (زمزمه)' : 'ACRCloud',
  };
}

export async function transcribe(sample) {
  const key = await getSetting('stt_key');
  if (!key) return null;
  const base = ((await getSetting('stt_url')) || 'https://api.groq.com/openai/v1').replace(/\/$/, '');
  const form = new FormData();
  form.append('model', (await getSetting('stt_model')) || 'whisper-large-v3');
  form.append('file', new InputFile(sample.bytes, sample.name, { type: sample.mime }));
  const res = await fetch(`${base}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form });
  const text = ((await res.json())?.text || '').trim();
  return text.length >= 4 ? text : null;
}

export async function lyricsSearch(text, limit = 5) {
  const token = await getSetting('genius_token');
  if (!token) return [];
  const res = await fetch(`https://api.genius.com/search?q=${encodeURIComponent(text)}`, { headers: { Authorization: `Bearer ${token}` } });
  const hits = (await res.json())?.response?.hits || [];
  return hits.slice(0, limit).map((h) => ({ title: h.result?.title, artist: h.result?.primary_artist?.name }));
}

const safe = (fn) => fn().catch((e) => (console.warn('recognizer failed', e.message), null));

/**
 * sample: { bytes: Uint8Array, name, mime } — a voice note, video, video note, or a Mini App recording.
 * -> { match?, transcript?, lyricHits: [] , configured: bool }
 */
export async function recognize(sample, { hum = false } = {}) {
  if (!hum) {
    const m = (await safe(() => audd(sample))) || (await safe(() => acr(sample, false)));
    if (m) return { match: m, lyricHits: [] };
  }
  const m = await safe(() => acr(sample, true));
  if (m) return { match: m, lyricHits: [] };
  const transcript = await safe(() => transcribe(sample));
  if (transcript) return { transcript, lyricHits: (await safe(() => lyricsSearch(transcript))) || [] };
  const configured = !!((await getSetting('audd_token')) || (await getSetting('acr_key')) || (await getSetting('stt_key')));
  return { lyricHits: [], configured };
}

export const queryOf = (m) => `${m.artist || ''} ${m.title}`.trim();
