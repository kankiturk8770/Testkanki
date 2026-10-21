// Finding and downloading music with plain HTTP (the platform has no yt-dlp / ffmpeg).
//
//   search:   YouTube (InnerTube, no key) + RadioJavan + SoundCloud (public web client id)
//   audio:    SoundCloud — native, HLS segments joined into an .m4a (AAC 160k)
//             RadioJavan — native, 256k mp3;  JioSaavn (only as a stand-in) — up to 320k AAC
//             YouTube    — 1) "cobalt" download service if configured (any quality, mp3)
//                          2) native InnerTube app clients (m4a 128k), 3) the same song on SoundCloud / RadioJavan / JioSaavn
//   video:    cobalt if configured, else native: HD video + m4a joined by lib/mp4mux.js (no re-encode)
//   links:    Instagram / TikTok / … through cobalt
import { fetch } from 'sdk';
import { getSetting, setSetting } from './store.js';
import { concatBytes, readBytes, fromBase64 } from './util.js';
import { muxAV } from './mp4mux.js';
import { desDecrypt } from './des.js';

export const AUDIO_QUALITIES = ['128', '192', '320'];
/** Sources the bot can search and download itself; anything else is a pasted link. */
export const MUSIC_SOURCES = ['youtube', 'soundcloud', 'radiojavan', 'saavn'];
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

// Direct stream URLs from the InnerTube player. The iOS/Android app clients are accepted from
// Telegram's servers (the web clients get "Sign in to confirm you're not a bot").
const YT_CLIENTS = [
  [{ clientName: 'IOS', clientVersion: '20.10.4', deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.3.2.22D82' },
    'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)'],
  [{ clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, osName: 'Android', osVersion: '11' },
    'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip'],
  [{ clientName: 'ANDROID_VR', clientVersion: '1.62.27', deviceMake: 'Oculus', deviceModel: 'Quest 3', androidSdkVersion: 32, osName: 'Android', osVersion: '12L' },
    'com.google.android.apps.youtube.vr.oculus/1.62.27 (Linux; U; Android 12L) gzip'],
];

async function ytPlayer(videoId) {
  let reason = 'unavailable';
  for (const [client, ua] of YT_CLIENTS) {
    const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': ua },
      body: JSON.stringify({ context: { client: { ...client, hl: 'en' } }, videoId, contentCheckOk: true, racyCheckOk: true }),
    });
    const j = await res.json().catch(() => ({}));
    const sd = j?.streamingData;
    if (j?.playabilityStatus?.status === 'OK' && sd && [...(sd.formats || []), ...(sd.adaptiveFormats || [])].some((f) => f.url)) {
      return { formats: [...(sd.formats || []), ...(sd.adaptiveFormats || [])].filter((f) => f.url), ua };
    }
    reason = j?.playabilityStatus?.reason || reason;
  }
  throw new Error(`youtube: ${reason}`);
}

// googlevideo throttles big single requests; fetch 2 MB ranges, 4 at a time.
async function rangedDownload(url, size, ua) {
  const step = 2 * 1024 * 1024;
  const ranges = [];
  for (let start = 0; start < size; start += step) ranges.push([start, Math.min(size, start + step) - 1]);
  const parts = [];
  for (let i = 0; i < ranges.length; i += 4) {
    parts.push(...(await Promise.all(ranges.slice(i, i + 4).map(async ([a, b]) => {
      const res = await fetch(`${url}&range=${a}-${b}`, { headers: { 'User-Agent': ua } });
      if (!res.ok) throw new Error(`youtube download ${res.status}`);
      return readBytes(res);
    }))));
  }
  return concatBytes(parts);
}

const sizeOf = (f) => Number(f.contentLength) || Math.round(((f.bitrate || f.averageBitrate || 0) / 8) * (Number(f.approxDurationMs) / 1000 || 0));

async function ytNativeAudio(videoId) {
  const { formats, ua } = await ytPlayer(videoId);
  const f = formats.find((x) => x.itag === 140) || formats.find((x) => x.mimeType.startsWith('audio/mp4'));
  if (!f) throw new Error('youtube: no m4a stream');
  return { bytes: await rangedDownload(f.url, sizeOf(f), ua), ext: 'm4a', mime: 'audio/mp4' };
}

const LIMIT = 49 * 1024 * 1024;

// H.264 video-only stream (largest that fits under `height`) + m4a, joined by mp4mux.
async function ytNativeVideo(videoId, height) {
  const { formats, ua } = await ytPlayer(videoId);
  const audioF = formats.find((x) => x.itag === 140);
  const videos = formats
    .filter((x) => x.mimeType.startsWith('video/mp4') && x.mimeType.includes('avc1') && !x.audioQuality && x.height <= Number(height))
    .sort((x, y) => y.height - x.height);
  for (const vf of videos) {
    if (!audioF || sizeOf(vf) + sizeOf(audioF) > LIMIT) continue;
    const [v, a] = await Promise.all([rangedDownload(vf.url, sizeOf(vf), ua), rangedDownload(audioF.url, sizeOf(audioF), ua)]);
    return { bytes: muxAV(v, a), ext: 'mp4', mime: 'video/mp4', height: String(vf.height) };
  }
  const prog = formats.find((x) => x.itag === 18); // 360p with sound, no muxing needed
  if (prog) {
    const size = sizeOf(prog);
    const bytes = size ? await rangedDownload(prog.url, size, ua) : await readBytes(await fetch(prog.url, { headers: { 'User-Agent': ua } }));
    return { bytes, ext: 'mp4', mime: 'video/mp4', height: '360' };
  }
  throw new Error(videos.length ? 'ویدیو از ۵۰ مگابایت بزرگ‌تره؛ کیفیت پایین‌تر رو انتخاب کن' : 'youtube: no video stream');
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

export async function scSearch(query, limit) {
  const j = await scApi(`/search/tracks?q=${encodeURIComponent(query)}&limit=${limit + 6}`);
  return (j.collection || [])
    .filter((t) => t.policy !== 'BLOCK' && t.policy !== 'SNIP' && t.duration / 1000 <= MAX_DURATION)
    // DRM uploads (only encrypted HLS) can never be downloaded: leave them out
    .filter((t) => (t.media?.transcodings || []).some((x) => x.format?.protocol === 'hls' && /^(aac|mp3)/.test(x.preset || '')))
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

// ---------------- RadioJavan (Persian music; full 256k mp3) ----------------

export async function rjSearch(query, limit) {
  const res = await fetch(`https://play.radiojavan.com/api/p/search?query=${encodeURIComponent(query)}`, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) return [];
  const j = await res.json();
  return (j.mp3s || []).filter((m) => m.link && (!m.duration || m.duration <= MAX_DURATION)).slice(0, limit).map((m) => ({
    key: `radiojavan:${m.id}`, source: 'radiojavan', url: m.share_link || `https://play.radiojavan.com/song/${m.permlink}`,
    title: m.song || splitTitle(m.title).title, artist: m.artist || null,
    duration: m.duration ? Math.round(m.duration) : null, thumb: m.photo || m.thumbnail || null, media: m.hq_link || m.link,
  }));
}

async function rjAudio(track) {
  let media = track.media;
  if (!media) {
    const id = track.key.split(':')[1];
    const hit = (await rjSearch(`${track.artist || ''} ${track.title}`.trim(), 10)).find((t) => t.key === `radiojavan:${id}`);
    media = hit?.media;
  }
  if (!media) throw new Error('radiojavan: link not found');
  const res = await fetch(media, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`radiojavan ${res.status}`);
  return { bytes: await readBytes(res), ext: 'mp3', mime: 'audio/mpeg' };
}

// ---------------- JioSaavn (big international catalogue; up to 320k AAC) ----------------

export async function saavnSearch(query, limit) {
  const url = `https://www.jiosaavn.com/api.php?__call=search.getResults&_format=json&_marker=0&api_version=4&ctx=web6dot0&n=${limit + 4}&p=1&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) return [];
  const j = await res.json();
  const clean = (x) => String(x || '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#039;/g, "'");
  return (j.results || []).filter((r) => r.more_info?.encrypted_media_url && !/karaoke|instrumental/i.test(r.title + r.subtitle)).slice(0, limit).map((r) => ({
    key: `saavn:${r.id}`, source: 'saavn', url: r.perma_url, title: clean(r.title),
    artist: clean(r.more_info?.artistMap?.primary_artists?.map((a) => a.name).join(', ') || r.more_info?.music || r.subtitle?.split(' - ')[0]),
    duration: Number(r.more_info?.duration) || null, thumb: (r.image || '').replace('150x150', '500x500') || null,
    media: r.more_info.encrypted_media_url, hq: r.more_info['320kbps'] === 'true',
  }));
}

async function saavnAudio(track, kbps) {
  if (!track.media) {
    // tracks read back from the database don't carry the encrypted URL: look it up again
    const id = track.key.split(':')[1];
    const res = await fetch(`https://www.jiosaavn.com/api.php?__call=song.getDetails&pids=${id}&_format=json&_marker=0&api_version=4&ctx=web6dot0`, { headers: { 'User-Agent': UA } });
    const j = await res.json().catch(() => ({}));
    const song = j.songs?.[0] || j[id];
    track = { ...track, media: song?.more_info?.encrypted_media_url || song?.encrypted_media_url, hq: (song?.more_info || song)?.['320kbps'] === 'true' };
  }
  if (!track.media) throw new Error('saavn: link not found');
  const url = new TextDecoder().decode(desDecrypt(fromBase64(track.media), '38346591'));
  const q = kbps === '320' && track.hq ? '320' : kbps === '128' ? '96' : '160';
  for (const u of [url.replace(/_96\.mp4$/, `_${q}.mp4`), url]) {
    const res = await fetch(u, { headers: { 'User-Agent': UA } });
    if (res.ok) return { bytes: await readBytes(res), ext: 'm4a', mime: 'audio/mp4' };
  }
  throw new Error('saavn: download failed');
}

// ---------------- direct playback URLs for the Mini App (all these CDNs allow any origin) ----------------

async function scStream(track) {
  const t = await scApi(`/tracks/${track.key.split(':')[1]}`);
  const tr = (t.media?.transcodings || []).find((x) => x.format?.protocol === 'hls' && /^aac/.test(x.preset))
    || (t.media?.transcodings || []).find((x) => x.format?.protocol === 'hls' && /^mp3/.test(x.preset));
  if (!tr) return null;
  const cid = await scClientId();
  const { url } = await (await fetch(`${tr.url}?client_id=${cid}&track_authorization=${t.track_authorization}`)).json();
  return url ? { kind: 'hls', url } : null;
}

async function directStream(track) {
  if (track.source === 'radiojavan') {
    const id = track.key.split(':')[1];
    const media = track.media || (await rjSearch(`${track.artist || ''} ${track.title}`.trim(), 10)).find((t) => t.key === `radiojavan:${id}`)?.media;
    return media ? { kind: 'file', url: media } : null;
  }
  if (track.source === 'saavn') {
    let media = track.media;
    if (!media) {
      const id = track.key.split(':')[1];
      const j = await (await fetch(`https://www.jiosaavn.com/api.php?__call=song.getDetails&pids=${id}&_format=json&_marker=0&api_version=4&ctx=web6dot0`, { headers: { 'User-Agent': UA } })).json().catch(() => ({}));
      media = (j.songs?.[0] || j[id])?.more_info?.encrypted_media_url;
    }
    if (!media) return null;
    return { kind: 'file', url: new TextDecoder().decode(desDecrypt(fromBase64(media), '38346591')).replace(/_96\.mp4$/, '_160.mp4') };
  }
  if (track.source === 'soundcloud') return scStream(track);
  return null;
}

/** -> { kind: 'file' | 'hls', url, alt? } for instant playback, or null (then the player uses Telegram's copy). */
export async function streamInfo(track) {
  try {
    const own = await directStream(track);
    if (own) return own;
  } catch (e) {
    console.warn('stream', track.key, e.message);
  }
  if (!MUSIC_SOURCES.includes(track.source)) return null;
  for (const alt of await alternatives(track).catch(() => [])) {
    try {
      const s = await directStream(alt);
      if (s) return { ...s, alt: { title: alt.title, artist: alt.artist } };
    } catch {}
  }
  return null;
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

const safeList = (name, p) => p.catch((e) => (console.warn(`${name} search`, e.message), []));

export async function search(query, limit = 12) {
  const per = Math.ceil(limit / 3) + 2;
  const [yt, rj, sc] = await Promise.all([
    safeList('yt', ytSearch(query, per)), safeList('rj', rjSearch(query, per)), safeList('sc', scSearch(query, per)),
  ]);
  const out = [];
  for (let i = 0; i < Math.max(yt.length, rj.length, sc.length); i++) {
    for (const list of [rj, yt, sc]) if (list[i]) out.push(list[i]);
  }
  return out.slice(0, limit);
}

export async function remixes(track, limit = 12) {
  const base = `${track.artist || ''} ${cleanTitle(track.title)}`.trim();
  const found = (await search(`${base} remix`, limit + 4)).filter((r) => r.key !== track.key);
  const words = ['remix', 'ریمیکس', 'mix', 'edit', 'bootleg', 'cover', 'slowed', 'sped', 'lofi', 'live'];
  const good = found.filter((r) => words.some((w) => `${r.title} ${r.artist || ''}`.toLowerCase().includes(w)));
  return (good.length ? good : found).slice(0, limit);
}

// "KUSURA BAKMA ( Nefes Pro Remix ) Senden Geçemiyorum…" -> "KUSURA BAKMA"
function cleanTitle(t) {
  t = String(t || '');
  const head = t.split(/[(\[{|•]|\s[–—-]\s|\s(?:ft\.?|feat\.?)\s/i)[0].trim();
  return (head || t.replace(/[(\[{][^)\]}]*[)\]}]/g, ' ')).replace(/\s+/g, ' ').trim();
}

// accents are dropped ("Agáchate" = "Agachate"), punctuation splits words
const words = (s) => new Set(String(s || '').toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 1));

function similarity(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const w of A) if (B.has(w)) hit++;
  return hit / Math.min(A.size, B.size);
}

/** The same song on sources that serve full files (for YouTube / DRM / deleted uploads), best first. */
export async function alternatives(track) {
  const title = cleanTitle(track.title);
  const remix = /remix|ریمیکس|mix\b/i.test(track.title) ? (track.title.match(/[(\[]([^)\]]*remix[^)\]]*)[)\]]/i)?.[1] || 'remix') : '';
  const queries = [...new Set([`${track.artist || ''} ${title} ${remix}`.trim(), `${track.artist || ''} ${title}`.trim(), title])];
  const found = (await Promise.all(queries.map((q) => Promise.all([
    safeList('sc', scSearch(q, 6)), safeList('rj', rjSearch(q, 4)), safeList('saavn', saavnSearch(q, 4)),
  ])))).flat(2);
  // Same core title required. Then: the same remix > the original by the same artist > another version.
  const remixName = [...words(remix)].filter((w) => !['remix', 'mix', 'ریمیکس'].includes(w));
  const isRemix = (t) => /remix|ریمیکس|\bmix\b|edit|cover|bootleg/i.test(t);
  const scored = [];
  const seen = new Set();
  for (const f of found) {
    if (f.key === track.key || seen.has(f.key)) continue;
    seen.add(f.key);
    if (similarity(title, cleanTitle(f.title)) < 0.6) continue;
    const fw = words(`${f.artist || ''} ${f.title}`);
    let score = similarity(track.artist, f.artist) >= 0.5 ? 2 : 0;
    if (remixName.length && remixName.every((w) => fw.has(w))) score += 4;
    else if (isRemix(f.title)) score -= remix ? 1 : 3;
    if (track.duration && f.duration) score += Math.abs(f.duration - track.duration) <= 15 ? 1 : 0;
    scored.push({ f, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, 4).map((x) => x.f);
}

async function audioFrom(track, kbps) {
  if (track.source === 'soundcloud') return scAudio(track);
  if (track.source === 'radiojavan') return rjAudio(track);
  if (track.source === 'saavn') return saavnAudio(track, kbps);
  const viaCobalt = await cobalt(track.url, { downloadMode: 'audio', audioFormat: 'mp3', audioBitrate: kbps });
  if (viaCobalt) return { bytes: viaCobalt.bytes, ext: 'mp3', mime: 'audio/mpeg' };
  const vid = youtubeId(track.url);
  if (vid) return ytNativeAudio(vid);
  throw new Error('برای این لینک باید سرویس دانلود (cobalt) تنظیم شده باشد');
}

/** -> { bytes, ext, mime, via } ; tries the track itself, then the same song on other sources. */
export async function downloadAudio(track, kbps = '192') {
  let first;
  try {
    return { ...(await audioFrom(track, kbps)), via: track.source };
  } catch (e) {
    first = e;
    console.warn('audio download failed', track.key, e.message);
  }
  if (MUSIC_SOURCES.includes(track.source)) {
    for (const alt of await alternatives(track).catch((e) => (console.warn('alternatives', e.message), []))) {
      try {
        return { ...(await audioFrom(alt, kbps)), via: alt.source, alt: { title: alt.title, artist: alt.artist, source: alt.source } };
      } catch (e) {
        console.warn('alternative failed', alt.key, e.message);
      }
    }
  }
  throw new Error(track.source === 'youtube'
    ? 'این آهنگ فقط تو یوتیوب هست و یوتیوب دانلود از سرور رو بسته؛ یه نسخه‌ی دیگه از نتایج رو امتحان کن'
    : String(first?.message || first));
}

/** Video of a song can be fetched only through a cobalt instance (YouTube blocks servers). */
export async function videoAvailable() {
  return !!(await getSetting('cobalt_url'));
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
  try {
    return await ytNativeVideo(vid, height);
  } catch (e) {
    // Without a PO token googlevideo serves only the first ~1 MB to servers.
    if (/403/.test(e.message)) throw new Error('یوتیوب دانلود ویدیو رو از سرور بسته؛ ادمین باید سرویس دانلود (cobalt_url) رو تنظیم کنه');
    throw e;
  }
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

// ---------------- links: Instagram / TikTok / YouTube -> song name + media ----------------

const IG_UA = 'Googlebot/2.1 (+http://www.google.com/bot.html)'; // Instagram serves the full reel page to crawlers
const unjson = (x) => { try { return JSON.parse(`"${x}"`); } catch { return x; } };
const unhtml = (x) => String(x || '').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));

async function instagramInfo(url) {
  const code = (url.match(/instagram\.com\/(?:[^/]+\/)?(?:reel|reels|p|tv)\/([\w-]+)/) || [])[1];
  if (!code) return null;
  const res = await fetch(`https://www.instagram.com/reel/${code}/`, { headers: { 'User-Agent': IG_UA } });
  const page = await res.text();
  const pick = (re) => { const m = page.match(re); return m ? unjson(m[1]) : null; };
  // licensed music: "music_asset_info":{…"title":"Waved Up","display_artist":"Wavyeffect"…}
  const asset = page.match(/"music_asset_info":\{[^}]*?"title":"([^"]+)"[^}]*?"display_artist":"([^"]+)"/);
  const song = pick(/"song_name":"([^"]+)"/) || (asset && unjson(asset[1]));
  const artist = pick(/"artist_name":"([^"]+)"/) || (asset && unjson(asset[2]));
  const original = pick(/"original_audio_title":"([^"]+)"/);
  const owner = pick(/"ig_artist":\{"username":"([^"]+)"/) || pick(/"username":"([^"]+)"/);
  const caption = unhtml((page.match(/og:title" content="([^"]{0,200})/) || [])[1]);
  return {
    kind: 'instagram', id: code,
    song: song ? { title: song, artist } : null,
    // "Maviler - Tutsak (Slowed Reverb)" is a real song name; "Original audio" is not
    hint: original && !/^original audio|^audio original|اصلی/i.test(original) ? original : null,
    title: caption || `Instagram ${code}`, owner,
    video: pick(/"video_versions":\[\{[^\]]*?"url":"([^"]+)"/),
    thumb: pick(/"display_url":"([^"]+)"/) || unhtml((page.match(/og:image" content="([^"]+)"/) || [])[1]),
  };
}

async function tiktokInfo(url) {
  const res = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`, { headers: { 'User-Agent': UA } });
  const j = await res.json();
  if (j.code !== 0 || !j.data) return null;
  const d = j.data, m = d.music_info || {};
  const real = m.title && !/original sound|оригинальный звук|son original|sonido original|اصلی/i.test(m.title);
  return {
    kind: 'tiktok', id: d.id, title: d.title || 'TikTok', owner: d.author?.unique_id,
    song: real ? { title: m.title, artist: m.author || null } : null, hint: null,
    video: d.hdplay || d.play, audio: d.music || m.play, thumb: d.cover,
  };
}

/** A pasted link -> { kind, song?, hint?, title, video?, audio?, thumb } (null if unknown). */
export async function linkInfo(url) {
  try {
    if (/instagram\.com\//.test(url)) return await instagramInfo(url);
    if (/tiktok\.com\//.test(url)) return await tiktokInfo(url);
  } catch (e) {
    console.warn('link info', e.message);
  }
  return null;
}

/** Bytes of a link's video (Instagram / TikTok). */
export async function linkVideo(info) {
  if (!info?.video) throw new Error('ویدیوی این لینک پیدا نشد');
  const res = await fetch(info.video, { headers: { 'User-Agent': UA } }); // the CDN refuses crawler agents
  if (!res.ok) throw new Error(`video ${res.status}`);
  return readBytes(res);
}

/** Bytes of a link's sound, for Shazam (TikTok has a separate audio file). */
export async function linkSound(info) {
  const url = info?.audio || info?.video;
  if (!url) throw new Error('صدای این لینک پیدا نشد');
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`media ${res.status}`);
  return { bytes: await readBytes(res, 20 * 1024 * 1024), mime: info.audio ? 'audio/mpeg' : 'video/mp4' };
}

// ---------------- "send me this song": best downloadable version of a title ----------------

/**
 * want: { title, artist } (e.g. from Shazam or Instagram). Returns tracks, best first:
 * same title & artist, original over remix/cover/live unless asked for, sources that serve full files first.
 */
export async function bestMatches(want, limit = 5) {
  const title = cleanTitle(want.title) || want.title;
  const q = `${want.artist || ''} ${title}`.trim();
  const lists = await Promise.all([
    safeList('rj', rjSearch(q, 5)), safeList('sc', scSearch(q, 6)), safeList('saavn', saavnSearch(q, 4)), safeList('yt', ytSearch(q, 5)),
  ]);
  const wantVersion = /remix|ریمیکس|slowed|sped|live|cover|lofi|acoustic/i.exec(want.title)?.[0]?.toLowerCase();
  // YouTube serves only ~1 MB to servers unless a cobalt instance is set: pick it last
  const ytUsable = !!(await getSetting('cobalt_url'));
  const sourceRank = { radiojavan: 1, saavn: 0.9, soundcloud: 0.7, youtube: ytUsable ? 0.2 : -1.5 };
  const scored = lists.flat().map((t) => {
    let score = similarity(title, cleanTitle(t.title)) * 4;
    if (want.artist) score += similarity(want.artist, `${t.artist || ''} ${t.title}`) * 2;
    const version = /remix|ریمیکس|slowed|sped|live|cover|lofi|acoustic|karaoke|instrumental/i.exec(t.title)?.[0]?.toLowerCase();
    if (version && version !== wantVersion) score -= 2;
    if (wantVersion && version === wantVersion) score += 1.5;
    score += sourceRank[t.source] || 0;
    return { t, score };
  });
  const seen = new Set();
  return scored.filter((x) => x.score >= 3).sort((a, b) => b.score - a.score)
    .map((x) => x.t).filter((t) => !seen.has(t.key) && seen.add(t.key)).slice(0, limit);
}

/** Raw media of a link (Instagram reel, TikTok, …) for song recognition; needs cobalt. */
export async function linkMedia(url) {
  const r = await cobalt(url, { downloadMode: 'audio', audioFormat: 'mp3', audioBitrate: '128' });
  return r && { bytes: r.bytes, ext: 'mp3', mime: 'audio/mpeg' };
}
