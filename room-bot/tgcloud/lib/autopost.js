// Automatic channel posts, a few times a day: PUBG Mobile news (official YouTube channel + Google News)
// written up in Persian by Gemini, or a "set / character of the day" post. Pictures are always official
// PUBG MOBILE art (the posters of the official channel's videos): an image AI doesn't know PUBG. In "approve" mode every post comes to the owner first with ✅ / 🔄 / ❌.
import { db, fetch, InputFile } from 'sdk';
import { sql } from 'sdk/db';
import { esc, btn, call, send, now, digits } from './util.js';
import * as store from './store.js';
import { gemini, cleanText } from './ai.js';

// Creators who report PUBG Mobile news, leaks and tricks first (chosen by the owner, editable in the panel).
const CREATORS = [
  ['UCQTeBv3p7q9rWWIC9vZvdWQ', 'Sobishow'], ['UCoFPD2vSR1ASDHnEbeY6cBw', 'PUBG ERRORIAN'], ['UCg5ZwCBahiaK6MYz6XcujMA', 'Javid Gaming'],
  ['UC20D7JTd_Vgkh8mVVXhSkog', 'International TV'], ['UCUnaeRojh-SiauF2nqKSagA', 'AMIRREZAAR'], ['UCzcUK2OemzoCWXcOODSLO7Q', 'BTX Gaming'],
  ['UCJ8RStb8ZmcobVGIh8fwnyw', 'PASHTON YT'], ['UCFqTfpH5x5QLXtfA6Hr7UYw', 'Gk Afroz'], ['UCzavu1YB-eUAIowh5BLin4A', 'Cinderella Gaming'],
  ['UCffh6IaDaZDMwSycr3pXaaQ', 'Trotz PUBG'], ['UCGuBZLq7tPfjHPSla8_XoqA', 'BRADYBITS'], ['UCyNYZBZLdTX9f1piBIEN5FA', 'Emmi Plays'],
  ['UCFQzl89P1a0AjwUMhnb6eqA', 'SOLSO'], ['UCuBnmJvEbxTs1QT09n8vVdg', 'MOSI_SOLO'], ['UCgn7fCFfIjUx34GMGbSEYaw', 'PUBG MOBILE Philippines'],
].map(([id, name]) => ({ id, name }));
const DEFAULT = { on: false, mode: 'approve', times: ['10:00', '14:00', '18:00', '22:00'], chat: null, title: null, sources: [], yt: CREATORS };
export async function getAuto() {
  const v = await store.getSetting('auto');
  return { ...DEFAULT, ...(v ? JSON.parse(v) : {}) };
}
const saveAuto = (cfg) => store.setSetting('auto', JSON.stringify(cfg));

// ---------- sources ----------
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const YT_CHANNEL = 'UCKuBf7CRNf4OYoDyTtAL5fg'; // PUBG MOBILE (official)
const unxml = (s) => String(s || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
// tournament streams are hours long and say nothing new
const STREAM = /main event|group [a-z]\b|\bday \d|\blive\b|finals?\b|week \d|\[(en|ar|id|tr|ru|th|vn)\]|qualifier|league stage|survival stage/i;

export async function ytNews() {
  const r = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${YT_CHANNEL}`);
  // the feed answers 404 now and then: the newest uploads from YouTube search instead
  if (!r.ok) {
    const lists = await Promise.all(['PUBG MOBILE', 'PUBG MOBILE update', 'PUBG MOBILE new', 'PUBG MOBILE coming'].map((q) => ytOfficial(q, 'CAISAhAB').catch(() => [])));
    const seenVid = new Set();
    return lists.flat().filter((v) => !STREAM.test(v.title) && !seenVid.has(v.vid) && seenVid.add(v.vid))
      .map((v) => ({ key: 'yt:' + v.vid, vid: v.vid, title: v.title, desc: '', ts: now() - Math.round(v.days * 86400), source: 'PUBG MOBILE' }));
  }
  const x = await r.text();
  return [...x.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => ({
    key: 'yt:' + (e.match(/<yt:videoId>(.*?)<\/yt:videoId>/) || [])[1],
    vid: (e.match(/<yt:videoId>(.*?)<\/yt:videoId>/) || [])[1],
    title: unxml((e.match(/<title>(.*?)<\/title>/) || [])[1]),
    desc: unxml((e.match(/<media:description>([\s\S]*?)<\/media:description>/) || [])[1]).slice(0, 700),
    ts: Date.parse((e.match(/<published>(.*?)<\/published>/) || [])[1]) / 1000,
    source: 'PUBG MOBILE',
  })).filter((n) => n.vid && !STREAM.test(n.title));
}

export async function googleNews() {
  const q = encodeURIComponent('"PUBG Mobile" (update OR new OR collaboration OR season OR event OR leak)');
  const x = await (await fetch(`https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`, { headers: { 'User-Agent': UA } })).text();
  return [...x.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, e]) => {
    const title = unxml((e.match(/<title>([\s\S]*?)<\/title>/) || [])[1]);
    const link = unxml((e.match(/<link>([\s\S]*?)<\/link>/) || [])[1]);
    return { key: 'gn:' + link.slice(-80), title: title.replace(/\s+-\s+[^-]+$/, ''), source: unxml((e.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1]),
      desc: '', ts: Date.parse((e.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1]) / 1000 };
  }).filter((n) => n.title && !/esports? charts|viewership|most-watched/i.test(n.title));
}

// Official channel's videos found by YouTube search (sets, X-Suits, characters, collabs …).
// params: EgIQAQ = videos only; CAISAhAB = videos, newest first
async function ytOfficial(query, params = 'EgIQAQ%3D%3D') {
  const res = await fetch('https://www.youtube.com/youtubei/v1/search?prettyPrint=false', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: '2.20250101.00.00', hl: 'en' } }, query, params }),
  });
  const j = await res.json();
  const out = [];
  for (const sec of j?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || []) {
    for (const it of sec.itemSectionRenderer?.contents || []) {
      const v = it.videoRenderer;
      if (!v?.videoId || v.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId !== YT_CHANNEL) continue;
      const age = (v.publishedTimeText?.simpleText || '').match(/(\d+)\s+(hour|day|week|month|year)/);
      const days = age ? Number(age[1]) * { hour: 1 / 24, day: 1, week: 7, month: 30, year: 365 }[age[2]] : 9999;
      out.push({ vid: v.videoId, title: v.title?.runs?.map((r) => r.text).join('') || '', days });
    }
  }
  return out;
}

// Public Telegram channels the owner picked (news / leak / beta channels), read through tgstat.com:
// Telegram's servers can't open t.me. Text and date only (tgstat doesn't show the pictures).
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const strip = (h) => unxml(String(h).replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '')).replace(/\n{3,}/g, '\n\n').trim();
export async function tgPosts(name) {
  const x = await (await fetch(`https://tgstat.com/channel/@${name}`, { headers: { 'User-Agent': UA } })).text();
  const year = new Date().getUTCFullYear();
  return x.split(/class="card card-body border p-2 px-1 px-sm-3 post-container/).slice(1).map((p) => {
    const id = (p.match(/\/channel\/@[\w]+\/(\d+)/) || [])[1];
    const t = (p.match(/<small>\s*(\d{1,2}) (\w{3})(?: (\d{4}))?, (\d{1,2}):(\d{2})\s*<\/small>/) || []);
    let ts = t[1] ? Date.UTC(Number(t[3] || year), MONTHS[t[2].toLowerCase()], Number(t[1]), Number(t[4]) - 3, Number(t[5])) / 1000 : 0; // tgstat shows Moscow time
    if (ts > now() + 86400) ts = Date.UTC(year - 1, MONTHS[t[2].toLowerCase()], Number(t[1]), Number(t[4]) - 3, Number(t[5])) / 1000;
    const text = strip((p.match(/<div class="post-text">([\s\S]*?)<\/div>/) || [])[1] || '');
    return { key: `tg:${name}:${id}`, title: text.split('\n')[0].slice(0, 150), desc: text.slice(0, 1200), ts, source: '@' + name };
  }).filter((n) => n.ts && n.desc.length > 30);
}

// ---------- YouTube creators ----------
async function innertube(path, body) {
  const r = await fetch(`https://www.youtube.com/youtubei/v1/${path}?prettyPrint=false`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: '2.20250101.00.00', hl: 'en' } }, ...body }),
  });
  return r.json();
}

/** A channel's latest uploads (videos tab, newest first). */
async function channelVideos(ch) {
  const b = await innertube('browse', { browseId: ch.id, params: 'EgZ2aWRlb3PyBgQKAjoA' });
  const out = [];
  JSON.stringify(b, (k, v) => {
    if (k === 'lockupViewModel' && v?.contentId && out.length < 6) {
      const meta = v.metadata?.lockupMetadataViewModel;
      const age = (JSON.stringify(meta?.metadata || {}).match(/(\d+) (minute|hour|day|week|month|year)s? ago/) || []);
      const days = age[1] ? Number(age[1]) * { minute: 1 / 1440, hour: 1 / 24, day: 1, week: 7, month: 30, year: 365 }[age[2]] : 999;
      out.push({ key: 'yv:' + v.contentId, vid: v.contentId, title: meta?.title?.content || '', ts: now() - Math.round(days * 86400), source: ch.name, creator: true });
    }
    return v;
  });
  return out;
}

/** What the video says, as far as its description tells (subtitles aren't reachable from here). */
async function videoText(vid) {
  const p = await innertube('player', { videoId: vid });
  return String(p.videoDetails?.shortDescription || '').replace(/https?:\/\/\S+/g, '').replace(/\n{3,}/g, '\n\n').slice(0, 1500);
}

export async function creatorItems() {
  const cfg = await getAuto();
  return (await Promise.all(cfg.yt.map((ch) => channelVideos(ch).catch(() => [])))).flat();
}

/** "@handle" or a channel link -> { id, name } */
export async function resolveChannel(ref) {
  const h = String(ref).trim().replace(/^https?:\/\/(www\.|m\.)?youtube\.com\//, '').replace(/^@?/, '@').replace(/[/?].*$/, '');
  const r = await innertube('navigation/resolve_url', { url: `https://www.youtube.com/${h.startsWith('@UC') ? 'channel/' + h.slice(1) : h}` });
  const id = r?.endpoint?.browseEndpoint?.browseId;
  return id && id.startsWith('UC') ? { id, name: h.replace(/^@/, '') } : null;
}

// how new an item must be: news is old after a few days
const MAX_AGE = { tg: 2 * 86400, yt: 3 * 86400, gn: 3 * 86400, yv: 2 * 86400 };

/**
 * Fresh items not posted before, best first. news: the owner's Telegram channels, the official channel,
 * the creators, news sites. tip: the creators only (tricks come from people who show them, not from the AI).
 */
async function freshItems(want) {
  const cfg = await getAuto();
  let lists;
  // titles that promise a trick (VPN / DNS / ping videos aren't PUBG tricks)
  const TIPLIKE = /how to|trick|tips?\b|free|setting|sensitivity|guide|\bget\b|ترفند|آموزش|رایگان|تنظیمات|حساسیت|چطور|نحوه|بگیر/i;
  const NOT_TIP = /\bdns\b|vpn|ping|پینگ|دی ان اس|وی پی ان|fiber|فیبر|kills?!|gameplay/i;
  if (want === 'tip') lists = [(await creatorItems()).filter((x) => TIPLIKE.test(x.title) && !NOT_TIP.test(x.title))];
  else {
    const picked = [...cfg.sources].sort(() => Math.random() - 0.5).slice(0, 3); // tgstat blocks many requests at once
    lists = await Promise.all([
      Promise.all(picked.map((n) => tgPosts(n).catch(() => []))).then((l) => l.flat()),
      ytNews().catch(() => []), creatorItems().catch(() => []), googleNews().catch(() => []),
    ]);
  }
  const out = [];
  for (const list of lists) {
    const maxAge = want === 'tip' ? 4 * 86400 : null;
    for (const n of list.filter((x) => x.ts > now() - (maxAge || MAX_AGE[x.key.slice(0, 2)])).sort((a, b) => b.ts - a.ts)) {
      if (await db.get(sql`SELECT k FROM seen WHERE k IN (${n.key}, ${'cv:' + (n.vid || '')})`)) continue;
      out.push(n);
      if (out.length >= 4) return out;
    }
  }
  return out;
}

/** An official poster of the same thing (from the last month), for news from other sources. */
async function officialPicture(keywords) {
  if (!keywords) return null;
  const hit = (await ytOfficial(`PUBG MOBILE ${keywords}`).catch(() => [])).find((v) => v.days < 30);
  return hit ? hit.vid : null;
}

// ---------- pictures ----------
async function bytesOf(url, headers = {}) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, ...headers } });
  if (!r.ok || !/^image\//.test(r.headers.get('content-type') || '')) throw new Error(`image ${r.status}`);
  const parts = [];
  let n = 0;
  for await (const c of r.body) {
    parts.push(c);
    n += c.length;
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  if (n < 5000) throw new Error('image too small');
  return out;
}

const ytThumb = (vid) => bytesOf(`https://i.ytimg.com/vi/${vid}/maxresdefault.jpg`).catch(() => bytesOf(`https://i.ytimg.com/vi/${vid}/hqdefault.jpg`));

// ---------- writing ----------
function parseJson(t) {
  return JSON.parse(String(t).replace(/^```(?:json)?|```$/g, '').trim());
}

async function signature() {
  const cfg = await getAuto();
  return cfg.username ? `\n\n🆔 @${cfg.username}` : '';
}

const day = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);
const markSeen = async (...keys) => {
  for (const k of keys) await db.run(sql`INSERT INTO seen (k, ts) VALUES (${k}, ${now()}) ON CONFLICT(k) DO NOTHING`);
};

/** A news or tip post from the newest item that really is one. */
async function makeFrom(want) {
  for (const n of await freshItems(want)) {
    const text = n.creator ? await videoText(n.vid).catch(() => '') : n.desc;
    if (n.creator && text.length < 40 && n.title.length < 25) { // "Yt 1441": nothing to go on
      await markSeen(n.key);
      continue;
    }
    const j = parseJson(await gemini(`You run a Persian Telegram channel for PUBG Mobile players. Today is ${day(now())}.
Item from ${n.source}${n.creator ? ' (a YouTube creator)' : ''}, published ${day(n.ts)}:
Title: ${n.title}
Text: ${text || '(none)'}
What is it?
${want === 'tip'
    ? `- "tip": the text gives practical PUBG Mobile advice a player can act on: how to get something (free materials, gems, rewards, an item from an event or rebate), what to spend on or skip, settings, sensitivity, a gameplay trick. Write it as a how-to with the steps / advice from the text.
- "news": only announcements with nothing to do`
    : `- "news": real, current PUBG Mobile news (update, version, beta, leak, set, X-Suit, weapon skin, event, collab, mode, season, Royale Pass, crate, rebate, release date)
- "tip": a concrete PUBG Mobile trick or how-to (settings, sensitivity, gameplay)`}
- "skip": ads, VPN / internet / DNS stuff, giveaways of other channels, memes, gameplay highlights, esports results, unrelated games, vague clickbait with no facts in the text, or anything already over or announced for a date that has passed
Answer JSON: {"type": "news"|"tip"|"skip", "title": short catchy Persian headline (max 60 chars), "body": Persian post, 3-6 short lines, casual and exciting, a few fitting emoji, only facts from the item (never invent dates, numbers, prices or steps; if it names a date, say it correctly relative to today; for a tip give the actual steps), no hashtags, no links, no channel names, write it as the channel's own post (never say "in this video"), "keywords": 2-4 English words naming the thing (e.g. "Gilt Set", "4.7 update", "M416 Glacier")}`, true));
    if (j.type !== want) {
      if (j.type === 'skip' || !['news', 'tip'].includes(j.type)) await markSeen(n.key); // a tip stays for the tip slot
      continue;
    }
    if (!j.title || !j.body) continue;
    await markSeen(n.key, ...(n.vid && !n.creator ? ['cv:' + n.vid] : []));
    // picture: the official video's poster, else an official poster of the same thing, else the creator's
    let vid = n.vid && !n.creator ? n.vid : null;
    if (!vid && want === 'news') vid = await officialPicture(String(j.keywords || '').slice(0, 60));
    if (vid && vid !== n.vid) await markSeen('cv:' + vid);
    if (!vid && n.creator) vid = n.vid;
    const photo = vid ? await ytThumb(vid).catch(() => null) : null;
    const src = n.key.startsWith('tg:') ? '' : n.creator ? `\n\n🎥 <i>منبع: ${esc(n.source)}</i>` : `\n\n🔗 <i>${esc(n.source || 'PUBG MOBILE')}</i>`;
    const icon = want === 'tip' ? '💡' : '📰';
    const caption = `${icon} <b>${esc(cleanText(j.title))}</b>\n\n${esc(cleanText(j.body))}${src}${await signature()}`;
    return { kind: want, caption, photo };
  }
  return null;
}

// what a "set of the day" post is about; each search gives the official channel's posters
const LOOKS = ['PUBG MOBILE new set', 'PUBG MOBILE X-Suit', 'PUBG MOBILE Mythic set', 'PUBG MOBILE new outfit', 'PUBG MOBILE character',
  'PUBG MOBILE collaboration', 'PUBG MOBILE Royale Pass rewards', 'PUBG MOBILE Gilt set', 'PUBG MOBILE new skin'];
async function makeChar() {
  const found = (await Promise.all(LOOKS.map((q) => ytOfficial(q, 'CAISAhAB').catch(() => [])))).flat()
    .filter((v) => v.days <= 21 && !STREAM.test(v.title)).sort((a, b) => a.days - b.days); // only things that are new now
  let pick = null;
  for (const v of found) {
    if (!(await db.get(sql`SELECT k FROM seen WHERE k IN (${'cv:' + v.vid}, ${'yt:' + v.vid})`))) {
      pick = v;
      break;
    }
  }
  if (!pick) return null;
  const j = parseJson(await gemini(`You run a Persian Telegram channel for PUBG Mobile players. Today is ${day(now())}.
Today's "set of the day" post shows the official poster of this PUBG MOBILE video, published ${day(now() - Math.round(pick.days * 86400))}:
"${pick.title}"
If the title says something is "coming" on a date that is already past today, it is in the game now: say so, don't call it upcoming.
Answer JSON: {"name": short Persian title for the set / character / item (keep its English name if it has one), "caption": Persian, 2-3 short lines about it (only what the title says, never invent prices or dates), then a question that makes members comment or react (e.g. do you have it? which one is yours?), a few emoji, no hashtags}`, true));
  const photo = await ytThumb(pick.vid);
  await markSeen('cv:' + pick.vid, 'yt:' + pick.vid);
  const caption = `🎨 <b>${esc(cleanText(j.name || 'ست امروز'))}</b>\n\n${esc(cleanText(j.caption))}${await signature()}`;
  return { kind: 'char', caption, photo };
}

const MAKERS = { news: () => makeFrom('news'), tip: () => makeFrom('tip'), char: makeChar };
const FALLBACK = { news: ['news', 'char', 'tip'], tip: ['tip', 'news', 'char'], char: ['char', 'news', 'tip'] };
/** A new post of this kind, else another kind; null when there is nothing new at all. */
export async function makePost(kind) {
  const order = FALLBACK[kind].map((k) => MAKERS[k]);
  for (const f of order) {
    const p = await f();
    if (p) return p;
  }
  return null;
}

// ---------- delivering ----------
const PANEL_BACK = [[btn('🔙 برگشت', 'auto')]];
const draftKb = (id) => [[btn('✅ بفرست تو کانال', `ap:${id}`)], [btn('🔄 یکی دیگه', `ar:${id}`), btn('❌ نه', `ax:${id}`)]];

/** Send the post to the owner for approval, or straight to the channel. */
export async function deliverPost(p, mode) {
  const cfg = await getAuto();
  const owner = await store.getSetting('owner');
  const out = (chat, extra = {}) => p.photo
    ? call('sendPhoto', { chat_id: chat, photo: new InputFile(p.photo, 'post.jpg', { type: 'image/jpeg' }), caption: p.caption, parse_mode: 'HTML', ...extra })
    : call('sendMessage', { chat_id: chat, text: p.caption, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
  if (mode === 'auto' && cfg.chat) {
    const r = await out(cfg.chat);
    await send(owner, r.ok ? `✅ پست خودکار (${p.kind === 'news' ? 'خبر' : 'کاراکتر'}) تو «${esc(cfg.title)}» رفت.` : `⚠️ پست خودکار نرفت: ${esc(r.description)}`);
    return r.ok;
  }
  const row = (await db.run(sql`INSERT INTO drafts (kind, caption, status, created) VALUES (${p.kind}, ${p.caption}, 'wait', ${now()}) RETURNING id`)).rows[0];
  const r = await out(owner, { reply_markup: { inline_keyboard: draftKb(row.id) } });
  if (r.ok && r.result.photo) await db.run(sql`UPDATE drafts SET photo = ${r.result.photo.at(-1).file_id} WHERE id = ${row.id}`);
  return r.ok;
}

/** Owner's buttons under a draft: ap (send) / ar (another one) / ax (drop). */
export async function draftAction(uid, data, msg) {
  const [act, id] = data.split(':');
  const d = await db.get(sql`SELECT * FROM drafts WHERE id = ${Number(id)}`);
  const done = (text) => call('editMessageReplyMarkup', { chat_id: uid, message_id: msg.message_id, reply_markup: { inline_keyboard: [[btn(text, 'noop')]] } });
  if (!d || d.status !== 'wait') return done('⌛️ تموم شده');
  if (act === 'ax') {
    await db.run(sql`UPDATE drafts SET status = 'drop' WHERE id = ${d.id}`);
    return done('❌ رد شد');
  }
  if (act === 'ap') {
    const cfg = await getAuto();
    if (!cfg.chat) return send(uid, '⚠️ اول تو «📰 پست خودکار» کانال رو انتخاب کن.', PANEL_BACK);
    const r = d.photo
      ? await call('sendPhoto', { chat_id: cfg.chat, photo: d.photo, caption: d.caption, parse_mode: 'HTML' })
      : await call('sendMessage', { chat_id: cfg.chat, text: d.caption, parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    if (!r.ok) return send(uid, `⚠️ نرفت: ${esc(r.description)}`, PANEL_BACK);
    await db.run(sql`UPDATE drafts SET status = 'sent' WHERE id = ${d.id}`);
    return done(`✅ رفت تو ${cfg.title || 'کانال'}`);
  }
  await db.run(sql`UPDATE drafts SET status = 'drop' WHERE id = ${d.id}`);
  await done('🔄 یکی دیگه…');
  return testPost(uid, d.kind);
}

/** "Make one now" (and 🔄): build a post and show it to the owner. */
export async function testPost(uid, kind) {
  const wait = await send(uid, { news: '📰 دارم خبر تازه پیدا می‌کنم و می‌نویسم…', tip: '💡 دارم ترفند تازه پیدا می‌کنم…', char: '🎨 دارم ست تازه پیدا می‌کنم…' }[kind], false);
  try {
    const p = await makePost(kind);
    if (!p) return send(uid, '📭 الان چیز تازه‌ای نیست: خبرهای چند روز اخیر و ست‌های سه هفته‌ی اخیر رو قبلاً ساختیم. بعداً دوباره بزن، یا تو «📡 منابع خبر» کانال اضافه کن.', PANEL_BACK);
    const NAME = { news: 'خبر', tip: 'ترفند', char: 'ست' };
    if (p.kind !== kind) await send(uid, `ℹ️ ${NAME[kind]} تازه‌ای نبود؛ به‌جاش یه ${NAME[p.kind]} ساختم.`, false);
    await deliverPost(p, 'approve');
  } catch (e) {
    console.error('autopost', e);
    await send(uid, '⚠️ ساختنش نشد (هوش مصنوعی یا یوتیوب جواب نداد). چند لحظه بعد دوباره بزن.', PANEL_BACK);
  } finally {
    if (wait.ok) await call('deleteMessage', { chat_id: uid, message_id: wait.result.message_id });
  }
}

// ---------- schedule (called by the cron tick) ----------
const PLAN = ['news', 'tip', 'news', 'char', 'news', 'news'];
export async function autoTick() {
  const cfg = await getAuto();
  if (!cfg.on || !cfg.chat) return;
  const off = (await store.tz()) * 60;
  const local = now() + off;
  const day = new Date(local * 1000).toISOString().slice(0, 10);
  const mins = Math.floor((local % 86400) / 60);
  const times = [...cfg.times].sort();
  for (let i = 0; i < times.length; i++) {
    const [h, m] = times[i].split(':').map(Number);
    const at = h * 60 + m;
    if (mins < at || mins > at + 50) continue;
    const slot = `${day} ${times[i]}`;
    // claim the slot first: two ticks at once must not post twice
    const prev = (await store.getSetting('auto_last')) || '';
    if (prev >= slot) continue;
    const won = (await db.run(sql`INSERT INTO settings (k, v) VALUES ('auto_last', ${slot})
      ON CONFLICT(k) DO UPDATE SET v = excluded.v WHERE settings.v < excluded.v RETURNING v`)).rows[0];
    if (!won) continue;
    try {
      // the day's plan: news first, one tip a day, a fresh set now and then
      const tipToday = (await store.getSetting('auto_tip_day')) === day;
      let kind = PLAN[i % PLAN.length];
      if (kind === 'tip' && tipToday) kind = 'news';
      const p = await makePost(kind);
      if (p?.kind === 'tip') await store.setSetting('auto_tip_day', day);
      if (p) await deliverPost(p, cfg.mode); // nothing new: better no post than an old one
    } catch (e) {
      console.error('autopost slot', slot, e);
      await send(await store.getSetting('owner'), `⚠️ پست خودکار ساعت ${times[i]} ساخته نشد (هوش مصنوعی یا یوتیوب جواب نداد).`);
    }
    return;
  }
}

// ---------- the owner's control panel ----------
export async function autoPanel(uid, edit = null) {
  const cfg = await getAuto();
  const text = '📰 <b>پست خودکار</b>\n\n' +
    `وضعیت: <b>${cfg.on ? '🟢 روشن' : '🔴 خاموش'}</b>\n` +
    `حالت: <b>${cfg.mode === 'auto' ? '⚡ مستقیم میره تو کانال' : '👀 اول برای تو میاد، تأیید کنی میره'}</b>\n` +
    `ساعت‌ها: <b>${cfg.times.join(' ، ')}</b>\n` +
    `کانال: <b>${esc(cfg.title || 'انتخاب نشده')}</b>\n` +
    `🎥 کانال‌های یوتیوب: ${cfg.yt.length} تا + کانال رسمی پابجی\n` +
    `📡 کانال‌های تلگرام: ${cfg.sources.length ? cfg.sources.map((x) => '@' + x).join(' ') : 'هیچی'} · سایت‌های خبری\n\n` +
    'برنامه‌ی هر روز (به ترتیب ساعت‌ها):\n📰 خبر · 💡 ترفند (روزی یکی) · 📰 خبر · 🎨 ست تازه · 📰 خبر …\n' +
    'فقط چیزهای تازه (خبر ۲ روز اخیر، ست ۳ هفته‌ی اخیر)؛ اگه چیز تازه‌ای نباشه، اون ساعت پست نمیذاره.\n\n' +
    '👇 «🧪 الان بساز» رو بزن تا ببینی چی می‌سازه:';
  const kb = [
    [btn(cfg.on ? '🔴 خاموش کن' : '🟢 روشنش کن', 'au:on'), btn(cfg.mode === 'auto' ? '👀 با تأیید من' : '⚡ مستقیم بفرسته', 'au:mode')],
    [btn('⏰ تغییر ساعت‌ها', 'au:times'), btn('📢 کانال', 'au:ch')],
    [btn('🎥 کانال‌های یوتیوب', 'au:yt'), btn('📡 کانال‌های تلگرام', 'au:src')],
    [btn('🧪 📰 خبر', 'au:t:news'), btn('🧪 💡 ترفند', 'au:t:tip'), btn('🧪 🎨 ست', 'au:t:char')],
    [btn('🏠 منو', 'menu')],
  ];
  if (edit) {
    const r = await call('editMessageText', { chat_id: uid, message_id: edit, text, parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } });
    if (r.ok) return r;
  }
  return send(uid, text, kb);
}

async function pickChannel(uid, cfg, next) {
  const u = await store.user(uid);
  if (!u.channels.length) return false;
  const i = next ? (u.channels.findIndex((c) => String(c.id) === String(cfg.chat)) + 1) % u.channels.length : 0;
  const c = u.channels[i];
  cfg.chat = c.id;
  cfg.title = c.title;
  const info = await call('getChat', { chat_id: c.id });
  cfg.username = info.ok ? info.result.username || null : null;
  return true;
}

/** Panel buttons (au:…). Returns true when the bot now waits for typed times. */
export async function autoAction(uid, st, data, mid) {
  const cfg = await getAuto();
  if (data === 'au:on') {
    if (!cfg.chat && !(await pickChannel(uid, cfg, false))) return send(uid, '📢 اول یه کانال به ربات وصل کن.', [[btn('📢 کانال‌های من', 'chs')], [btn('🔙 برگشت', 'auto')]]);
    cfg.on = !cfg.on;
  } else if (data === 'au:mode') cfg.mode = cfg.mode === 'auto' ? 'approve' : 'auto';
  else if (data === 'au:ch') {
    if (!(await pickChannel(uid, cfg, true))) return send(uid, '📢 اول یه کانال به ربات وصل کن.', [[btn('📢 کانال‌های من', 'chs')], [btn('🔙 برگشت', 'auto')]]);
  } else if (data === 'au:times') {
    st.w = 'autotimes';
    return send(uid, '⏰ ساعت‌ها رو بفرست، با فاصله (هر چند تا خواستی):\n\nمثال: <code>12 17:30 21</code>', PANEL_BACK);
  } else if (data === 'au:yt') {
    st.w = 'autoyt';
    return send(uid, '🎥 <b>کانال‌های یوتیوب</b>\n\nربات ویدیوهای ۲ روز اخیر این کانال‌ها رو چک می‌کنه، از روی عنوان و توضیحات ویدیو خبر یا ترفند درمیاره و به فارسی می‌نویسه (ویدیوهای بی‌ربط مثل VPN و گیم‌پلی رو رد می‌کنه).\n\n' +
      `الان:\n${cfg.yt.map((c) => '▫️ ' + esc(c.name)).join('\n')}\n\n` +
      'اضافه کردن: آیدی یا لینک کانال رو بفرست، مثلا <code>+@PUBGMOBILE</code>\nحذف: <code>-اسم</code> مثلا <code>-SOLSO</code>', PANEL_BACK);
  } else if (data === 'au:src') {
    st.w = 'autosrc';
    return send(uid, '📡 <b>منابع خبر</b>\n\nآیدی کانال‌های عمومی تلگرام که اخبار، لیک و بتای پابجی رو زود میذارن بفرست (با فاصله). ربات جدیدترین پست‌هاشون (۲ روز اخیر) رو می‌خونه و به فارسی و با سبک خودش بازنویسی می‌کنه.\n\n' +
      `الان: ${cfg.sources.length ? cfg.sources.map((x) => '@' + x).join(' ') : 'هیچی'}\n\nمثال: <code>@channel1 @channel2</code>\nبرای پاک کردن همه: <code>-</code>`, PANEL_BACK);
  } else if (data.startsWith('au:t:')) {
    if (!cfg.chat && (await pickChannel(uid, cfg, false))) await saveAuto(cfg);
    return testPost(uid, data.slice(5));
  }
  await saveAuto(cfg);
  return autoPanel(uid, mid);
}

/** Typed answer to "⏰ تغییر ساعت‌ها". */
export async function setTimes(uid, st, text) {
  const times = [...new Set(digits(text).split(/[\s,،]+/).map((x) => {
    const m = x.match(/^(\d{1,2})(?:[:.](\d{2}))?$/);
    if (!m || Number(m[1]) > 23 || Number(m[2] || 0) > 59) return null;
    return `${m[1].padStart(2, '0')}:${(m[2] || '00')}`;
  }).filter(Boolean))].sort().slice(0, 8);
  if (!times.length) return send(uid, '⚠️ اینجوری بفرست: <code>12 17:30 21</code>', PANEL_BACK);
  const cfg = await getAuto();
  cfg.times = times;
  await saveAuto(cfg);
  st.w = null;
  return autoPanel(uid);
}

/** Typed answer to "📡 منابع خبر": @names, or "-" to clear. */
export async function setSources(uid, st, text) {
  const cfg = await getAuto();
  cfg.sources = text.trim() === '-' ? [] : [...new Set(text.split(/[\s,،]+/).map((w) => w.replace(/^https?:\/\/t\.me\/(s\/)?|^@/g, '').replace(/\/.*$/, ''))
    .filter((w) => /^\w{4,32}$/.test(w)))].slice(0, 10);
  await saveAuto(cfg);
  st.w = null;
  return autoPanel(uid);
}

/** Typed answer to "🎥 کانال‌های یوتیوب": "+@handle …" adds, "-name" removes. */
export async function setCreators(uid, st, text) {
  const cfg = await getAuto();
  const added = [], bad = [];
  for (const w of text.split(/[\s,،]+/).filter(Boolean)) {
    if (w.startsWith('-')) {
      const name = w.slice(1).replace(/^@/, '').toLowerCase();
      cfg.yt = cfg.yt.filter((c) => c.name.toLowerCase().replace(/\s+/g, '') !== name.replace(/\s+/g, ''));
      continue;
    }
    const ch = await resolveChannel(w.replace(/^\+/, '')).catch(() => null);
    if (!ch) bad.push(w);
    else if (!cfg.yt.some((c) => c.id === ch.id)) {
      cfg.yt.push(ch);
      added.push(ch.name);
    }
  }
  cfg.yt = cfg.yt.slice(0, 30);
  await saveAuto(cfg);
  st.w = null;
  if (bad.length) await send(uid, `⚠️ اینا پیدا نشدن: ${esc(bad.join(' '))}`, false);
  return autoPanel(uid);
}
