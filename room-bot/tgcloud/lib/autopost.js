// Automatic channel posts, a few times a day: PUBG Mobile news (official YouTube channel + Google News)
// written up in Persian by Gemini, or a "set / character of the day" post. Pictures are always official
// PUBG MOBILE art (the posters of the official channel's videos): an image AI doesn't know PUBG. In "approve" mode every post comes to the owner first with ✅ / 🔄 / ❌.
import { db, fetch, InputFile } from 'sdk';
import { sql } from 'sdk/db';
import { esc, btn, call, send, now, digits } from './util.js';
import * as store from './store.js';
import { gemini, cleanText } from './ai.js';

const DEFAULT = { on: false, mode: 'approve', times: ['12:00', '17:00', '21:00'], chat: null, title: null };
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

/** Newest item not posted before (official channel first), from the last 7 days. */
async function freshNews() {
  const lists = await Promise.all([ytNews().catch(() => []), googleNews().catch(() => [])]);
  const recent = (n) => n.ts && n.ts > now() - 7 * 86400;
  for (const list of lists) {
    for (const n of list.filter(recent).sort((a, b) => b.ts - a.ts)) {
      if (await db.get(sql`SELECT k FROM seen WHERE k IN (${n.key}, ${'cv:' + (n.vid || '')})`)) continue;
      if (!n.vid) { // a news site's story: only with an official picture of the same thing
        const words = n.title.replace(/PUBG Mobile/ig, '').split(/[^\w]+/).filter((w) => w.length > 3).slice(0, 5).join(' ');
        const hit = (await ytOfficial(`PUBG MOBILE ${words}`).catch(() => [])).find((v) => v.days < 30);
        if (!hit) continue;
        n.vid = hit.vid;
      }
      return n;
    }
  }
  return null;
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

async function makeNews() {
  const n = await freshNews();
  if (!n) return null;
  const j = parseJson(await gemini(`You run a Persian Telegram channel for PUBG Mobile players. Write a post about this news.
News title: ${n.title}
Details: ${n.desc || '(none)'}
Source: ${n.source}
Answer JSON: {"title": short catchy Persian headline (max 60 chars), "body": Persian post, 3-5 short lines, casual and exciting, a few fitting emoji, only facts from the news (never invent dates or numbers), no hashtags}`, true));
  const photo = await ytThumb(n.vid);
  // the same video must not come back as a "set of the day"
  for (const k of [n.key, 'cv:' + n.vid]) await db.run(sql`INSERT INTO seen (k, ts) VALUES (${k}, ${now()}) ON CONFLICT(k) DO NOTHING`);
  const caption = `📰 <b>${esc(cleanText(j.title))}</b>\n\n${esc(cleanText(j.body))}\n\n🔗 <i>${esc(n.source || 'PUBG MOBILE')}</i>${await signature()}`;
  return { kind: 'news', caption, photo };
}

// what a "set of the day" post is about; each search gives the official channel's posters
const LOOKS = ['PUBG MOBILE new set', 'PUBG MOBILE X-Suit', 'PUBG MOBILE Mythic set', 'PUBG MOBILE new outfit', 'PUBG MOBILE character',
  'PUBG MOBILE collaboration', 'PUBG MOBILE Royale Pass rewards', 'PUBG MOBILE Gilt set', 'PUBG MOBILE new skin'];
async function makeChar() {
  const queries = [...LOOKS].sort(() => Math.random() - 0.5).slice(0, 3);
  const found = (await Promise.all(queries.map((q) => ytOfficial(q).catch(() => [])))).flat()
    .filter((v) => v.days < 730 && !STREAM.test(v.title)).sort((a, b) => a.days - b.days);
  let pick = null;
  for (const v of found) {
    if (!(await db.get(sql`SELECT k FROM seen WHERE k IN (${'cv:' + v.vid}, ${'yt:' + v.vid})`))) {
      pick = v;
      break;
    }
  }
  if (!pick) throw new Error('no official art found');
  const j = parseJson(await gemini(`You run a Persian Telegram channel for PUBG Mobile players. Today's "set of the day" post shows the official poster of this PUBG MOBILE video:
"${pick.title}" (${pick.days < 1 ? 'today' : Math.round(pick.days) + ' days ago'}).
Answer JSON: {"name": short Persian title for the set / character / item (keep its English name if it has one), "caption": Persian, 2-3 short lines about it (only what the title says, never invent prices or dates), then a question that makes members comment or react (e.g. do you have it? which one is yours?), a few emoji, no hashtags}`, true));
  const photo = await ytThumb(pick.vid);
  await db.run(sql`INSERT INTO seen (k, ts) VALUES (${'cv:' + pick.vid}, ${now()}) ON CONFLICT(k) DO NOTHING`);
  const caption = `🎨 <b>${esc(cleanText(j.name || 'ست امروز'))}</b>\n\n${esc(cleanText(j.caption))}${await signature()}`;
  return { kind: 'char', caption, photo };
}

/** A new post of this kind (news falls back to a character post when there is no fresh news). */
export async function makePost(kind) {
  if (kind === 'news') {
    const p = await makeNews();
    if (p) return p;
  }
  return makeChar();
}

// ---------- delivering ----------
const draftKb = (id) => [[btn('✅ بفرست تو کانال', `ap:${id}`)], [btn('🔄 یکی دیگه', `ar:${id}`), btn('❌ نه', `ax:${id}`)]];

/** Send the post to the owner for approval, or straight to the channel. */
export async function deliverPost(p, mode) {
  const cfg = await getAuto();
  const owner = await store.getSetting('owner');
  const photo = new InputFile(p.photo, 'post.jpg', { type: 'image/jpeg' });
  if (mode === 'auto' && cfg.chat) {
    const r = await call('sendPhoto', { chat_id: cfg.chat, photo, caption: p.caption, parse_mode: 'HTML' });
    await send(owner, r.ok ? `✅ پست خودکار (${p.kind === 'news' ? 'خبر' : 'کاراکتر'}) تو «${esc(cfg.title)}» رفت.` : `⚠️ پست خودکار نرفت: ${esc(r.description)}`);
    return r.ok;
  }
  const row = (await db.run(sql`INSERT INTO drafts (kind, caption, status, created) VALUES (${p.kind}, ${p.caption}, 'wait', ${now()}) RETURNING id`)).rows[0];
  const r = await call('sendPhoto', { chat_id: owner, photo, caption: p.caption, parse_mode: 'HTML', reply_markup: { inline_keyboard: draftKb(row.id) } });
  if (r.ok) await db.run(sql`UPDATE drafts SET photo = ${r.result.photo.at(-1).file_id} WHERE id = ${row.id}`);
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
    if (!cfg.chat) return send(uid, '⚠️ اول تو «📰 پست خودکار» کانال رو انتخاب کن.');
    const r = await call('sendPhoto', { chat_id: cfg.chat, photo: d.photo, caption: d.caption, parse_mode: 'HTML' });
    if (!r.ok) return send(uid, `⚠️ نرفت: ${esc(r.description)}`);
    await db.run(sql`UPDATE drafts SET status = 'sent' WHERE id = ${d.id}`);
    return done(`✅ رفت تو ${cfg.title || 'کانال'}`);
  }
  await db.run(sql`UPDATE drafts SET status = 'drop' WHERE id = ${d.id}`);
  await done('🔄 یکی دیگه…');
  return testPost(uid, d.kind);
}

/** "Make one now" (and 🔄): build a post and show it to the owner. */
export async function testPost(uid, kind) {
  const wait = await send(uid, kind === 'news' ? '📰 دارم خبر تازه پیدا می‌کنم و می‌نویسم…' : '🎨 دارم عکس و متن می‌سازم…');
  try {
    const p = await makePost(kind);
    if (kind === 'news' && p.kind !== 'news') await send(uid, 'ℹ️ خبر تازه‌ای که قبلاً نذاشته باشیم پیدا نشد؛ به‌جاش یه پست «ست روز» ساختم.');
    await deliverPost(p, 'approve');
  } catch (e) {
    console.error('autopost', e);
    await send(uid, '⚠️ ساختنش نشد (هوش مصنوعی یا یوتیوب جواب نداد). چند لحظه بعد دوباره بزن.');
  } finally {
    if (wait.ok) await call('deleteMessage', { chat_id: uid, message_id: wait.result.message_id });
  }
}

// ---------- schedule (called by the cron tick) ----------
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
      await deliverPost(await makePost(i % 2 === 0 ? 'news' : 'char'), cfg.mode);
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
    `کانال: <b>${esc(cfg.title || 'انتخاب نشده')}</b>\n\n` +
    'هر روز سر این ساعت‌ها یکی در میون:\n📰 خبر تازه‌ی پابجی موبایل (از کانال رسمی و سایت‌های خبری)\n🎨 ست / کاراکتر روز با یه متن جذاب\nعکس‌ها همه پوسترهای رسمی پابجی موبایل هستن.\n\n' +
    '👇 «🧪 الان بساز» رو بزن تا ببینی چی می‌سازه:';
  const kb = [
    [btn(cfg.on ? '🔴 خاموش کن' : '🟢 روشنش کن', 'au:on'), btn(cfg.mode === 'auto' ? '👀 با تأیید من' : '⚡ مستقیم بفرسته', 'au:mode')],
    [btn('⏰ تغییر ساعت‌ها', 'au:times'), btn('📢 کانال', 'au:ch')],
    [btn('🧪 الان بساز: 📰 خبر', 'au:t:news'), btn('🧪 الان بساز: 🎨 کاراکتر', 'au:t:char')],
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
    if (!cfg.chat && !(await pickChannel(uid, cfg, false))) return send(uid, '📢 اول یه کانال به ربات وصل کن (📢 کانال‌های من).');
    cfg.on = !cfg.on;
  } else if (data === 'au:mode') cfg.mode = cfg.mode === 'auto' ? 'approve' : 'auto';
  else if (data === 'au:ch') {
    if (!(await pickChannel(uid, cfg, true))) return send(uid, '📢 اول یه کانال به ربات وصل کن (📢 کانال‌های من).');
  } else if (data === 'au:times') {
    st.w = 'autotimes';
    return send(uid, '⏰ ساعت‌ها رو بفرست، با فاصله (هر چند تا خواستی):\n\nمثال: <code>12 17:30 21</code>', [[btn('🏠 منو', 'menu')]]);
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
  if (!times.length) return send(uid, '⚠️ اینجوری بفرست: <code>12 17:30 21</code>');
  const cfg = await getAuto();
  cfg.times = times;
  await saveAuto(cfg);
  st.w = null;
  return autoPanel(uid);
}
