// Finding and downloading music with plain HTTP (the platform has no yt-dlp / ffmpeg).
//
//   search:   YouTube (InnerTube, no key) + SoundCloud (public web client id)
//   audio:    SoundCloud — native, HLS segments joined into an .m4a (AAC 160k)
//             YouTube    — 1) "cobalt" download service if configured (any quality, mp3)
//                          2) native InnerTube (m4a 128k), 3) the same song on SoundCloud
//   video:    cobalt service (360p…1080p); native fallback is 360p only
//   links:    Instagram / TikTok / … through cobalt
import { fetch } from 'sdk';
import { getSetting, setSetting } from './store.js';
import { concatBytes, readBytes } from './util.js';

export const AUDIO_QUALITIES = ['128', '192', '320'];
export const VIDEO_QUALITIES = ['360', '480', '720', '1080'];
const MAX_DURATION = 20 * 60;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const JUNK = /\s*[(\[](official|music|lyric|lyrics|audio|video|hd|4k|visualizer|موزیک ویدیو|ویدیو|متن)[^)\]]*[)\]]/gi;

export function splitTitle(title, uploader) {
  const clean = (title || '').replace(JUNK, '').trim();
  for (const sep of [' - ', ' – ', ' | ', ' — ']) {
    const i = clean.indexOf(sep);
    if (i > 0) return { title: clean.slice(i + sep.length).trim(), artist: clean.slice(0, i).trim() };
  }
  return { title: clean, artist: (uploader || '').replace(/\s*-\s*Topic$|VEVO$/, '').trim() || null };
}

function parseLength(text) {
  if (!text) return null;
  return text.split(':').reduce((a, p) => a * 60 + Number(p), 0) || null;
}

// ---------------- YouTube ----------------

const YT_WEB = { clientName: 'WEB', clientVersion: '2.20250101.00.00', hl: 'en' };

async function ytSearch(query, limit) {
  const res = await fetch('https://www.youtube.com/youtubei/v1/search?prettyPrint=false', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ context: { client: YT_WEB }, query, params: 'EgIQAQ%3D%3D' /* videos only */ }),
  });
  if (!res.ok) return [];
  const j = await res.json();
  const sections = j?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
  const out = [];
  for (const s of sections) {
    for (const it of s.itemSectionRenderer?.contents || []) {
      const v = it.videoRenderer;
      if (!v?.videoId) continue;
      const duration = parseLength(v.lengthText?.simpleText);
      if (!duration || duration > MAX_DURATION) continue;
      const { title, artist } = splitTitle(v.title?.runs?.[0]?.text, v.ownerText?.runs?.[0]?.text);
      out.push({
        key: `youtube:${v.videoId}`, source: 'youtube', url: `https://www.youtube.com/watch?v=${v.videoId}`,
        title, artist, duration, thumb: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
      });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

export function youtubeId(url) {
  const m = String(url).match(/(?:youtu\.be\/|v=|shorts\/|embed\/|music\.youtube\.com\/watch\?v=)([\w-]{11})/);
  return m ? m[1] : null;
}

// Direct stream URLs from the InnerTube player. Works when YouTube trusts the caller's IP.
async function ytPlayer(videoId) {
  const client = { clientName: 'ANDROID_VR', clientVersion: '1.62.27', deviceMake: 'Oculus', deviceModel: 'Quest 3',
    androidSdkVersion: 32, osName: 'Android', osVersion: '12L', hl: 'en' };
  const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'com.google.android.apps.youtube.vr.oculus/1.62.27 (Linux; U; Android 12L) gzip' },
    body: JSON.stringify({ context: { client }, videoId, contentCheckOk: true, racyCheckOk: true }),
  });
  const j = await res.json();
  if (j?.playabilityStatus?.status !== 'OK') throw new Error(`youtube: ${j?.playabilityStatus?.reason || 'unavailable'}`);
  return j.streamingData || {};
}

// googlevideo throttles big single requests; fetch in 4 MB ranges.
async function rangedDownload(url, size) {
  const parts = [];
  const step = 4 * 1024 * 1024;
  for (let start = 0; start < size; start += step) {
    const end = Math.min(size, start + step) - 1;
    const res = await fetch(`${url}&range=${start}-${end}`, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`youtube download ${res.status}`);
    parts.push(await readBytes(res));
  }
  return concatBytes(parts);
}

async function ytNativeAudio(videoId) {
  const sd = await ytPlayer(videoId);
  const f = (sd.adaptiveFormats || []).find((x) => x.itag === 140 && x.url); // m4a AAC 128k
  if (!f) throw new Error('youtube: no m4a stream');
  return { bytes: await rangedDownload(f.url, Number(f.contentLength)), ext: 'm4a', mime: 'audio/mp4' };
}

async function ytNativeVideo(videoId) {
  const sd = await ytPlayer(videoId);
  const f = (sd.formats || []).find((x) => x.itag === 18 && x.url); // 360p mp4 with sound
  if (!f) throw new Error('youtube: no 360p stream');
  const size = Number(f.contentLength) || 0;
  const bytes = size ? await rangedDownload(f.url, size) : await readBytes(await fetch(f.url));
  return { bytes, ext: 'mp4', mime: 'video/mp4', height: '360' };
}

// ---------------- SoundCloud ----------------

async function scClientId(refresh = false) {
  if (!refresh) {
    const cached = await getSetting('sc_client_id');
    if (cached) return cached;
  }
  const home = await (await fetch('https://soundcloud.com/', { headers: { 'User-Agent': UA } })).text();
  const scripts = [...home.matchAll(/<script crossorigin src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)].map((m) => m[1]);
  for (const src of scripts.reverse()) {
    const js = await (await fetch(src)).text();
    const m = js.match(/client_id\s*:\s*"([A-Za-z0-9]{32})"/) || js.match(/client_id=([A-Za-z0-9]{32})/);
    if (m) {
      await setSetting('sc_client_id', m[1]);
      return m[1];
    }
  }
  throw new Error('soundcloud: client id not found');
}

async function scApi(path) {
  for (const refresh of [false, true]) {
    const cid = await scClientId(refresh);
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetch(`https://api-v2.soundcloud.com${path}${sep}client_id=${cid}`, { headers: { 'User-Agent': UA } });
    if (res.status === 401 || res.status === 403) continue;
    if (!res.ok) throw new Error(`soundcloud ${res.status}`);
    return res.json();
  }
  throw new Error('soundcloud: unauthorized');
}

function scToTrack(t) {
  const meta = t.publisher_metadata || {};
  const split = splitTitle(t.title, t.user?.username);
  return {
    key: `soundcloud:${t.id}`, source: 'soundcloud', url: t.permalink_url,
    title: meta.release_title || split.title, artist: meta.artist || split.artist,
    duration: Math.round((t.full_duration || t.duration) / 1000),
    thumb: (t.artwork_url || t.user?.avatar_url || '').replace('-large.', '-t500x500.') || null,
  };
}

async function scSearch(query, limit) {
  const j = await scApi(`/search/tracks?q=${encodeURIComponent(query)}&limit=${limit + 6}`);
  return (j.collection || [])
    .filter((t) => t.policy !== 'BLOCK' && t.policy !== 'SNIP' && t.duration / 1000 <= MAX_DURATION)
    .slice(0, limit)
    .map(scToTrack);
}

// Absolute segment URL (the runtime may not have the URL class).
function resolveUrl(u, base) {
  if (/^https?:\/\//.test(u)) return u;
  const origin = base.match(/^https?:\/\/[^/]+/)[0];
  return u.startsWith('/') ? origin + u : base.split('?')[0].replace(/[^/]*$/, '') + u;
}

async function scAudio(track) {
  const id = track.key.split(':')[1];
  const t = await scApi(`/tracks/${id}`);
  if (t.policy === 'SNIP' || t.policy === 'BLOCK') throw new Error('soundcloud: preview only');
  const trs = (t.media?.transcodings || []).filter((x) => !x.snipped && x.format?.protocol === 'hls' && !/encrypted|ctr|cbc/.test(x.preset + x.format.protocol));
  const pick = trs.find((x) => x.preset.startsWith('aac_160')) || trs.find((x) => x.preset.startsWith('aac')) || trs.find((x) => x.preset.startsWith('mp3'));
  if (!pick) throw new Error('soundcloud: no downloadable stream (DRM)');
  const cid = await scClientId();
  const { url } = await (await fetch(`${pick.url}?client_id=${cid}&track_authorization=${t.track_authorization}`)).json();
  if (!url) throw new Error('soundcloud: stream refused');
  const m3u = await (await fetch(url)).text();
  if (/#EXT-X-KEY:METHOD=(?!NONE)/.test(m3u)) throw new Error('soundcloud: encrypted stream');
  const init = m3u.match(/#EXT-X-MAP:URI="([^"]+)"/);
  const segs = [...(init ? [init[1]] : []), ...m3u.split('\n').filter((l) => l && !l.startsWith('#'))].map((u) => resolveUrl(u, url));
  const parts = [];
  for (let i = 0; i < segs.length; i += 6) {
    parts.push(...(await Promise.all(segs.slice(i, i + 6).map(async (u) => readBytes(await fetch(u))))));
  }
  const mp3 = pick.preset.startsWith('mp3');
  return { bytes: concatBytes(parts), ext: mp3 ? 'mp3' : 'm4a', mime: mp3 ? 'audio/mpeg' : 'audio/mp4' };
}

// ---------------- cobalt (optional download service) ----------------
// Any instance of https://github.com/imputnet/cobalt: set it with
//   /set cobalt_url https://your-instance.example   and optionally   /set cobalt_key <api key>

async function cobalt(url, opts) {
  const base = await getSetting('cobalt_url');
  if (!base) return null;
  const key = await getSetting('cobalt_key');
  const res = await fetch(base.replace(/\/$/, '') + '/', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(key ? { Authorization: `Api-Key ${key}` } : {}) },
    body: JSON.stringify({ url, ...opts }),
  });
  const j = await res.json();
  if (j.status === 'error') throw new Error(`cobalt: ${j.error?.code || 'error'}`);
  const link = j.url || j.picker?.find((p) => p.type === 'video')?.url;
  if (!link) throw new Error('cobalt: nothing to download');
  return { bytes: await readBytes(await fetch(link)), filename: j.filename || '' };
}

// ---------------- public API ----------------

export async function search(query, limit = 12) {
  const per = Math.ceil(limit / 2) + 2;
  const [yt, sc] = await Promise.all([
    ytSearch(query, per).catch((e) => (console.warn('yt search', e.message), [])),
    scSearch(query, per).catch((e) => (console.warn('sc search', e.message), [])),
  ]);
  const out = [];
  for (let i = 0; i < Math.max(yt.length, sc.length); i++) {
    if (yt[i]) out.push(yt[i]);
    if (sc[i]) out.push(sc[i]);
  }
  return out.slice(0, limit);
}

export async function remixes(track, limit = 12) {
  const base = `${track.artist || ''} ${track.title}`.trim();
  const found = (await search(`${base} remix`, limit + 4)).filter((r) => r.key !== track.key);
  const words = ['remix', 'ریمیکس', 'mix', 'edit', 'bootleg', 'cover', 'slowed', 'sped', 'lofi', 'live'];
  const good = found.filter((r) => words.some((w) => `${r.title} ${r.artist || ''}`.toLowerCase().includes(w)));
  return (good.length ? good : found).slice(0, limit);
}

// Same song from another source, closest length first (for blocked / DRM uploads).
async function alternatives(track) {
  const found = (await search(`${track.artist || ''} ${track.title}`.trim(), 8)).filter((f) => f.key !== track.key);
  const close = track.duration ? found.filter((f) => f.duration && Math.abs(f.duration - track.duration) <= 15) : found;
  // another source first: if one YouTube upload is blocked, the others usually are too
  const pool = close.length ? close : found;
  return [...pool.filter((f) => f.source !== track.source), ...pool.filter((f) => f.source === track.source)].slice(0, 3);
}

async function audioFrom(track, kbps) {
  if (track.source === 'soundcloud') return scAudio(track);
  const viaCobalt = await cobalt(track.url, { downloadMode: 'audio', audioFormat: 'mp3', audioBitrate: kbps });
  if (viaCobalt) return { bytes: viaCobalt.bytes, ext: 'mp3', mime: 'audio/mpeg' };
  const vid = youtubeId(track.url);
  if (vid) return ytNativeAudio(vid);
  throw new Error('برای این لینک باید سرویس دانلود (cobalt) تنظیم شده باشد');
}

/** -> { bytes, ext, mime, via } ; tries the track itself, then the same song elsewhere. */
export async function downloadAudio(track, kbps = '192') {
  let first;
  try {
    return { ...(await audioFrom(track, kbps)), via: track.source };
  } catch (e) {
    first = e;
    console.warn('audio download failed', track.key, e.message);
  }
  if (track.source === 'youtube' || track.source === 'soundcloud') {
    for (const alt of await alternatives(track).catch(() => [])) {
      try {
        return { ...(await audioFrom(alt, kbps)), via: alt.source };
      } catch (e) {
        console.warn('alternative failed', alt.key, e.message);
      }
    }
  }
  throw first;
}

/** -> { bytes, ext, mime, height } */
export async function downloadVideo(track, height = '720') {
  const viaCobalt = await cobalt(track.url, { downloadMode: 'auto', videoQuality: height, youtubeVideoCodec: 'h264' });
  if (viaCobalt) return { bytes: viaCobalt.bytes, ext: 'mp4', mime: 'video/mp4', height };
  let vid = youtubeId(track.url);
  if (!vid && track.source === 'soundcloud') {
    const yt = (await ytSearch(`${track.artist || ''} ${track.title}`.trim(), 1))[0];
    vid = yt && youtubeId(yt.url);
  }
  if (!vid) throw new Error('ویدیویی برای این آهنگ پیدا نشد');
  return ytNativeVideo(vid);
}

/** A pasted link -> track (YouTube / SoundCloud natively, other sites as a generic "link" track). */
export async function fromUrl(url) {
  const vid = youtubeId(url);
  if (vid) {
    const found = await ytSearch(vid, 5);
    const hit = found.find((f) => f.key === `youtube:${vid}`);
    return hit || { key: `youtube:${vid}`, source: 'youtube', url: `https://www.youtube.com/watch?v=${vid}`,
      title: vid, thumb: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg` };
  }
  if (/soundcloud\.com\//.test(url)) {
    const t = await scApi(`/resolve?url=${encodeURIComponent(url.split('?')[0])}`);
    if (t?.kind === 'track') return scToTrack(t);
  }
  const host = (url.match(/^https?:\/\/(?:www\.)?([^/]+)/) || [])[1] || 'link';
  return { key: `link:${url.slice(0, 300)}`, source: host, url, title: `لینک ${host}` };
}

/** Raw media of a link (Instagram reel, TikTok, …) for song recognition; needs cobalt. */
export async function linkMedia(url) {
  const r = await cobalt(url, { downloadMode: 'audio', audioFormat: 'mp3', audioBitrate: '128' });
  return r && { bytes: r.bytes, ext: 'mp3', mime: 'audio/mpeg' };
}
