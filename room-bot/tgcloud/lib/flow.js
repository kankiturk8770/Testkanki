// The chat flow: menus, the step-by-step builder, preview, sending and scheduling.
// st = { s: the post being built | null, w: what the bot waits for | null } (saved by the handler).
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { esc, btn, grid, call, send, markup, now, digits } from './util.js';
import { SETS, PRESETS, COLS, STYLES, RULES, RSHORT, REC, KIND_LABEL, SKIP, kbase } from './data.js';
import * as store from './store.js';
import { sendPost, sendBeauty, deliver } from './posts.js';
import { gvMake, buildGv, gvKb } from './gv.js';
import { aiEnabled, writePost } from './ai.js';

const steps = (s) => SETS[s.kind];
const cur = (s) => s.edit || s.keys[s.i];
export const active = (st) => !!st.s && !!(st.s.edit || st.s.i < st.s.keys.length);

// ---------- keyboards ----------
export async function menuKb() {
  const rows = [[btn('🆕  ساخت اعلام روم  🎮', 'new')],
    [btn('🎁 قرعه‌کشی', 'gv'), btn('✨ پست زیبا', 'post')]];
  if (await aiEnabled()) rows.push([btn('🪄 بگو، خودم می‌سازم (هوش مصنوعی)', 'ai')], [btn('📰 پست خودکار (خبر و عکس روزانه)', 'auto')]);
  rows.push([btn('⏰ زمان‌بندی‌ها', 'jobs'), btn('📢 کانال‌های من', 'chs')],
    [btn('📊 آمار من', 'stats'), btn('❓ راهنما', 'help')]);
  return rows;
}

function rulesKb(s) {
  const rows = grid(RULES.map((_, i) => btn((s.rsel.includes(i) ? '✅ ' : '▫️ ') + RSHORT[i], `r:${i}`)), 2);
  rows.push([btn('⭐ پیشنهادی', 'r:rec'), btn('🧹 پاک کردن', 'r:clr')]);
  rows.push([btn(`✅  تایید قوانین (${s.rsel.length + s.rcustom.length})  ✅`, 'r:ok')]);
  return rows;
}

async function kbFor(uid, s, key) {
  const u = await store.user(uid);
  let rows = [];
  if (PRESETS[key]) rows = grid(PRESETS[key].map(([id, label]) => btn(label, `o:${key}:${id}`)), COLS[key]);
  else if (key === 'rules') rows = rulesKb(s);
  else if (key === 'spons') {
    if (u.spons.length) rows.push([btn(`♻️ همون اسپانسرهای قبلی (${u.spons.length})`, 'o:spons:last')]);
    if (kbase(s.kind) === 'gv') rows.push([btn('⏭ بدون اسپانسر', 'o:spons:n')]);
  } else if (key === 'pbody') {
    if (await aiEnabled()) rows.push([btn('🪄 هوش مصنوعی بنویسه (از روی عنوان)', 'o:pbody:ai')]);
  } else if (SKIP[key]) rows.push([btn(SKIP[key], `o:${key}:n`)]);
  const nav = [];
  if (s.edit) nav.push(btn('↩️ برگشت به پیش‌نمایش', 'pv'));
  else if (s.i > 0) nav.push(btn('🔙 قبلی', 'back'));
  nav.push(btn('❌ لغو', 'cancel'));
  rows.push(nav);
  return rows;
}

async function previewKb(uid, s) {
  const u = await store.user(uid);
  const gv = kbase(s.kind) === 'gv';
  const rows = [];
  if (u.channels.length > 1) {
    for (const c of u.channels) {
      const on = s.sel.includes(String(c.id));
      rows.push([btn((gv ? (on ? '🔘 ' : '⚪️ ') : (on ? '✅ ' : '⬜ ')) + c.title, `ch:${c.id}`)]);
    }
  }
  rows.push(...grid(steps(s).map(([k, t]) => btn('✏️ ' + t, 'e:' + k)), 3));
  rows.push([btn('📌 پین کردن: ' + (s.pin ? 'روشن ✅' : 'خاموش ❌'), 'pin')]);
  rows.push([btn('🚀  ارسال الان  🚀', 'go'), btn('⏰ زمان‌بندی', 'sch')]);
  rows.push([btn('❌ لغو', 'cancel')]);
  return rows;
}

// ---------- steps ----------
function initRules(s) {
  const ex = s.d.rules || [];
  s.rsel = RULES.map((r, i) => (ex.includes(r) ? i : -1)).filter((i) => i >= 0);
  s.rcustom = ex.filter((r) => !RULES.includes(r));
}

export async function ask(uid, st) {
  const s = st.s;
  const key = cur(s);
  let q = steps(s).find((x) => x[0] === key)[2];
  if (!s.edit && !s.quick && !s.auto) q += `\n\n📍 <i>مرحله ${s.i + 1} از ${s.keys.length}</i>`;
  await send(uid, q, await kbFor(uid, s, key));
}

async function go(uid, st) {
  if (cur(st.s) === 'rules') initRules(st.s);
  await ask(uid, st);
}

async function previewText(uid, s) {
  const base = kbase(s.kind);
  if (base === 'room') return sendPost(uid, s.d);
  if (base === 'post') return sendBeauty(uid, s.d);
  const g = { ...gvMake(s.d), id: 0, status: 'open', endsAt: null, count: 0 };
  await send(uid, await buildGv(g), gvKb(g));
  await send(uid, '🍀 <i>پیش‌نمایش قرعه‌کشی: دکمه‌ی شرکت بعد از ارسال فعال میشه.</i>');
}

export async function preview(uid, st) {
  const s = st.s;
  s.edit = null;
  s.mode = null;
  s.i = s.keys.length;
  await previewText(uid, s);
  const r = await send(uid, '👆 <b>پیش‌نمایش</b>\n\nهمه‌چی درسته؟ اگه نه، از دکمه‌های ✏️ بخش موردنظر رو ویرایش کن.', await previewKb(uid, s));
  s.ctl = r.result?.message_id || null;
}

// Filled by the AI: those steps are skipped, the optional ones it left empty too.
const OPTIONAL = new Set(['room', 'desc', 'photo', 'pbtn']);
const filled = (s, k) => s.d[k] !== undefined || (s.auto && (OPTIONAL.has(k) || (k === 'spons' && kbase(s.kind) === 'gv')));

async function done(uid, st) {
  const s = st.s;
  if (s.edit || (s.quick && s.i + 1 >= s.qn)) return preview(uid, st);
  s.i += 1;
  while (s.auto && s.i < s.keys.length && filled(s, s.keys[s.i])) s.i += 1;
  if (s.i >= s.keys.length) return preview(uid, st);
  return go(uid, st);
}

export async function startSession(uid, st, kind, { quick = false, prefill = null } = {}) {
  const u = await store.user(uid);
  if (!u.channels.length) {
    st.w = 'addch';
    return send(uid, addHelp('📢 اول باید یه کانال به ربات وصل کنی.'), [[btn('🏠 منو', 'menu')]]);
  }
  const d = { ...(prefill || {}) };
  if (kind.startsWith('gv')) {
    d.theme = kind.split('_')[1];
    if (quick) Object.assign(d, { gwin: 1, gcap: 50, gend: 'full', spons: null, desc: null });
  }
  const sel = kbase(kind) === 'gv' ? [String(u.channels[0].id)] : u.channels.map((c) => String(c.id));
  st.w = null;
  st.s = { kind, keys: SETS[kind].map((x) => x[0]), i: 0, d, edit: null, pin: !!u.pin, ctl: null, sel, mode: null,
    quick, qn: kind === 'gv_chicken' ? 2 : 1, rsel: [], rcustom: [], auto: !!prefill };
  if (prefill) {
    const s = st.s;
    while (s.i < s.keys.length && filled(s, s.keys[s.i])) s.i += 1;
    if (s.i >= s.keys.length) return preview(uid, st);
  }
  return go(uid, st);
}

export function cleanIds(txt) {
  const out = [];
  for (let w of String(txt).replace(/[,،\n]/g, ' ').split(/\s+/)) {
    if (w.includes('t.me/')) w = w.split('t.me/')[1];
    w = w.trim().replace(/^@+/, '').replace(/\/.*$/, '');
    if (/^\w{4,}$/.test(w) && !out.includes('@' + w)) out.push('@' + w);
  }
  return out;
}

/** "23:30" (bot's clock) or "+45" (minutes) -> unix time */
export async function parseWhen(txt) {
  const t = digits(txt).trim();
  let m = t.match(/^\+\s*(\d{1,4})$/);
  if (m) return now() + Number(m[1]) * 60;
  m = t.match(/^(\d{1,2})\s*[:.٫ ]\s*(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  const off = (await store.tz()) * 60;
  const day = Math.floor((now() + off) / 86400) * 86400;
  let ts = day + h * 3600 + mi * 60 - off;
  if (ts <= now() + 20) ts += 86400;
  return ts;
}

/** A typed answer (or a preset) for the current step. */
export async function storeAnswer(uid, st, key, val) {
  const d = st.s.d;
  val = String(val).trim();
  if (key === 'spons') {
    const ids = cleanIds(val);
    if (!ids.length) return send(uid, '⚠️ آیدی معتبر نبود.\nمثال: @mychannel');
    d.spons = ids;
    await store.setUserSpons(uid, ids);
  } else if (key === 'gwin' || key === 'gcap') {
    const n = Number(digits(val));
    if (!Number.isInteger(n)) return send(uid, '⚠️ یه عدد بفرست (مثلا 50)');
    if (n < 1 || n > 5000 || (key === 'gwin' && n > 50)) return send(uid, '⚠️ عدد معتبر نیست.');
    if (key === 'gwin' && d.gcap && n > d.gcap) return send(uid, '⚠️ تعداد برنده نمیتونه از ظرفیت بیشتر باشه.');
    if (key === 'gcap' && d.gwin && n < d.gwin) return send(uid, '⚠️ ظرفیت نمیتونه از تعداد برنده‌ها کمتر باشه.');
    d[key] = n;
  } else if (key === 'gend') {
    if (val === 'full' || /^d:\d+$/.test(val) || /^at:\d+$/.test(val)) d.gend = val;
    else {
      const ts = await parseWhen(val);
      if (!ts) return send(uid, '⚠️ ساعت رو اینجوری بفرست: 23:30');
      d.gend = `at:${ts}`;
    }
  } else if (key === 'pstyle') {
    if (!STYLES[val]) return send(uid, '🎨 یکی از دکمه‌ها رو بزن 👆');
    d.pstyle = val;
  } else if (key === 'pbtn') {
    if (!val.includes('|')) return send(uid, '⚠️ اینجوری بفرست:\nمتن دکمه | لینک');
    const i = val.indexOf('|');
    const t = val.slice(0, i).trim();
    let u = val.slice(i + 1).trim();
    if (u.startsWith('@')) u = 'https://t.me/' + u.slice(1);
    else if (u.startsWith('t.me/')) u = 'https://' + u;
    if (!t || !/^https?:\/\/\S+$/.test(u)) return send(uid, '⚠️ لینک معتبر نیست (باید با https شروع بشه).');
    d.pbtn = { t: t.slice(0, 60), u };
  } else d[key] = val;
  return done(uid, st);
}

// ---------- sending / scheduling ----------
async function targetsOf(uid, s) {
  const u = await store.user(uid);
  return u.channels.filter((c) => s.sel.includes(String(c.id))).map((c) => c.id);
}

export async function publish(uid, st) {
  const s = st.s;
  const tg = await targetsOf(uid, s);
  if (!tg.length) return send(uid, '⚠️ هیچ کانالی انتخاب نشده. یکی رو انتخاب کن.');
  const [lines, ok] = await deliver(uid, kbase(s.kind), s.d, tg, s.pin);
  if (ok) {
    await store.setUserPin(uid, s.pin);
    st.s = null;
  }
  return send(uid, '📬 <b>نتیجه ارسال</b>\n\n' + lines.join('\n\n'), await menuKb());
}

export async function schedPrompt(uid, st) {
  const s = st.s;
  if (!(await targetsOf(uid, s)).length) return send(uid, '⚠️ هیچ کانالی انتخاب نشده. یکی رو انتخاب کن.');
  s.mode = 'sched';
  return send(uid, '⏰ <b>زمان‌بندی ارسال</b>\n\nساعت دقیق رو تایپ کن (مثلا 23:30)\nیا +45 برای ۴۵ دقیقه دیگه.\nیا یکی از دکمه‌ها رو بزن 👇\n\n' +
    `🕓 الان: <b>${await store.localStr(now())}</b>`, [
    [btn('⏱ ۱۰ دقیقه دیگه', 'sw:10'), btn('⏱ ۳۰ دقیقه دیگه', 'sw:30')],
    [btn('⏱ ۱ ساعت دیگه', 'sw:60'), btn('⏱ ۲ ساعت دیگه', 'sw:120')],
    [btn('⏱ ۳ ساعت دیگه', 'sw:180'), btn('⏱ ۶ ساعت دیگه', 'sw:360')],
    [btn('↩️ برگشت به پیش‌نمایش', 'pv')]]);
}

export async function makeJob(uid, st, ts) {
  const s = st.s;
  await db.run(sql`INSERT INTO jobs (user_id, kind, due, targets, pin, data)
    VALUES (${uid}, ${kbase(s.kind)}, ${ts}, ${JSON.stringify(await targetsOf(uid, s))}, ${s.pin ? 1 : 0}, ${JSON.stringify(s.d)})`);
  st.s = null;
  // without the cron (see /timer) the post goes out on the first bot activity after its time
  const cronOk = Number(await store.getSetting('cron_seen')) > now() - 180;
  const hint = !cronOk && (await store.isOwner(uid)) ? '\n\n⚠️ برای ارسال دقیق سر ساعت، یه بار /timer رو تنظیم کن.' : '';
  return send(uid, `✅ <b>زمان‌بندی شد!</b>\n\n⏰ ارسال: <b>${await store.localStr(ts)}</b>\n\nربات خودش سر وقت میفرسته 🚀${hint}`,
    [[btn('⏰ زمان‌بندی‌های من', 'jobs')], [btn('🏠 منو', 'menu')]]);
}

export async function showJobs(uid) {
  const mine = await db.all(sql`SELECT id, kind, due FROM jobs WHERE user_id = ${uid} ORDER BY due`);
  if (!mine.length) return send(uid, '⏰ هیچ پست زمان‌بندی‌شده‌ای نداری.\n\nموقع پیش‌نمایش هر پست، دکمه «⏰ زمان‌بندی» رو بزن.', [[btn('🏠 منو', 'menu')]]);
  const lines = [], rows = [];
  for (const j of mine) {
    const when = await store.localStr(j.due);
    lines.push(`▫️ ${KIND_LABEL[j.kind]} · <b>${when}</b>`);
    rows.push([btn(`🗑 لغو: ${KIND_LABEL[j.kind]} ${when}`, `sc:${j.id}`)]);
  }
  rows.push([btn('🏠 منو', 'menu')]);
  return send(uid, '⏰ <b>زمان‌بندی‌های من</b>\n\n' + lines.join('\n'), rows);
}

// ---------- channels ----------
export const addHelp = (head = '') => (head ? head + '\n\n' : '') +
  '<b>مراحل اتصال کانال:</b>\n\n' +
  '1️⃣ ربات رو توی کانالت <b>ادمین</b> کن (با اجازه ارسال پیام و پین)\n\n' +
  '2️⃣ بعد یکی از این دو کار:\n' +
  '▫️ آیدی کانال رو بفرست، مثل @mychannel\n' +
  '▫️ یه پیام از کانال به همینجا فوروارد کن (برای کانال خصوصی)';

export async function tryAdd(uid, st, ref) {
  const r = await call('getChat', { chat_id: ref });
  if (!r.ok) return send(uid, '❌ کانال پیدا نشد.\nآیدی رو درست بفرست یا ربات رو ادمین کن و پیام فوروارد کن.');
  const ch = r.result;
  if (!['channel', 'supergroup', 'group'].includes(ch.type)) return send(uid, '❌ این یه کانال یا گروه نیست.');
  const me = (await call('getMe', {})).result;
  const mine = (await call('getChatMember', { chat_id: ch.id, user_id: me.id })).result || {};
  if (mine.status !== 'administrator' || (ch.type === 'channel' && !mine.can_post_messages)) {
    return send(uid, '❌ ربات توی این کانال ادمین نیست یا اجازه ارسال پیام نداره.\nدرستش کن و دوباره بفرست.');
  }
  const um = await call('getChatMember', { chat_id: ch.id, user_id: uid });
  if (!um.ok || !['creator', 'administrator'].includes(um.result.status)) {
    return send(uid, '⛔️ تو ادمین این کانال نیستی، فقط ادمین‌ها میتونن کانال رو وصل کنن.');
  }
  const title = ch.title || String(ref);
  st.w = null;
  if (!(await store.addChannel(uid, ch.id, title))) return send(uid, 'ℹ️ این کانال از قبل وصل بوده.', await menuKb());
  return send(uid, `🎉 <b>کانال «${esc(title)}» وصل شد!</b>\n\nحالا میتونی اعلام بسازی 👇`, await menuKb());
}

export async function showChannels(uid) {
  const u = await store.user(uid);
  if (!u.channels.length) return send(uid, '📢 هنوز کانالی وصل نکردی.', [[btn('➕ افزودن کانال', 'addch')], [btn('🏠 منو', 'menu')]]);
  const rows = u.channels.map((c) => [btn('🗑 حذف: ' + c.title, `dc:${c.id}`)]);
  rows.push([btn('➕ افزودن کانال', 'addch')], [btn('🏠 منو', 'menu')]);
  return send(uid, '📢 <b>کانال‌های من</b>\n\n' + u.channels.map((c) => '▫️ ' + esc(c.title)).join('\n'), rows);
}

export async function showStats(uid) {
  const u = await store.user(uid);
  const n = async (q) => (await db.get(q)).n;
  let t = `📊 <b>آمار من</b>\n\n🚀 پست‌های ارسالی: <b>${u.count}</b>\n🎁 قرعه‌کشی‌ها: <b>${await n(sql`SELECT COUNT(*) AS n FROM giveaways WHERE owner = ${uid}`)}</b>\n` +
    `📢 کانال‌های وصل‌شده: <b>${u.channels.length}</b>\n⏰ زمان‌بندی‌های فعال: <b>${await n(sql`SELECT COUNT(*) AS n FROM jobs WHERE user_id = ${uid}`)}</b>`;
  if (await store.isOwner(uid)) {
    t += `\n\n👑 <b>آمار کل ربات</b>\n👤 کاربران: <b>${await n(sql`SELECT COUNT(*) AS n FROM users`)}</b>\n` +
      `🚀 کل پست‌ها: <b>${await n(sql`SELECT COALESCE(SUM(count), 0) AS n FROM users`)}</b>\n🎁 کل قرعه‌کشی‌ها: <b>${await n(sql`SELECT COUNT(*) AS n FROM giveaways`)}</b>`;
  }
  return send(uid, t, [[btn('🏠 منو', 'menu')]]);
}

export const HELP = '❓ <b>راهنما</b>\n\n' +
  'این ربات پست‌های کانال پابجی رو خودکار و شیک میفرسته.\n\n' +
  '🎮 <b>اعلام روم:</b> ساعت، جایزه، مپ، قوانین و ... با دکمه\n' +
  '🎁 <b>قرعه‌کشی:</b> ثبت‌نام با دکمه توی کانال و انتخاب برنده‌ی شانسی توسط ربات\n' +
  '✨ <b>پست زیبا:</b> هر متنی رو توی یه قاب خوشگل بفرست\n' +
  '🪄 <b>هوش مصنوعی:</b> فقط بنویس چی میخوای، مثلا «روم ساعت ۱۱ لیویک اسکواد ۱۰۰ یوسی به MVP»\n' +
  '⏰ <b>زمان‌بندی:</b> هر پست رو برای ساعت دلخواه تنظیم کن\n\n' +
  '<b>دستورها:</b>\n/new اعلام روم\n/giveaway قرعه‌کشی\n/post پست زیبا\n/jobs زمان‌بندی‌ها\n' +
  '/channels کانال‌ها\n/addchannel افزودن کانال\n/stats آمار\n/cancel لغو';

export async function welcome(uid, name = '') {
  return send(uid, `🎮 <b>سلام ${esc(name)}، خوش اومدی!</b> 👋\n\n` +
    'من رباتی هستم که اعلام روم، قرعه‌کشی و پست‌های کانال پابجی رو <b>خودکار، شیک و با اموجی</b> میفرستم 🔥\n\n' +
    'برای شروع یکی از گزینه‌ها رو بزن 👇', await menuKb());
}

// ---------- callbacks that act on the post being built ----------
export async function sessionCallback(uid, st, data, mid) {
  const s = st.s;
  if (data === 'cancel') {
    st.s = null;
    return send(uid, '❎ لغو شد.', await menuKb());
  }
  if (data === 'back' && s.i > 0) {
    s.i -= 1;
    while (s.auto && s.i > 0 && filled(s, s.keys[s.i]) && s.d[s.keys[s.i]] === undefined) s.i -= 1;
    return go(uid, st);
  }
  if (data === 'pv') return preview(uid, st);
  if (data.startsWith('e:')) {
    s.edit = data.slice(2);
    s.mode = null;
    return go(uid, st);
  }
  if (data === 'pin') {
    s.pin = !s.pin;
    if (s.ctl) await markup(uid, s.ctl, await previewKb(uid, s));
    return;
  }
  if (data.startsWith('ch:')) {
    const cid = data.slice(3);
    if (kbase(s.kind) === 'gv') s.sel = [cid];
    else s.sel = s.sel.includes(cid) ? s.sel.filter((x) => x !== cid) : [...s.sel, cid];
    if (s.ctl) await markup(uid, s.ctl, await previewKb(uid, s));
    return;
  }
  if (data === 'go') return publish(uid, st);
  if (data === 'sch') return schedPrompt(uid, st);
  if (data.startsWith('sw:') && s.mode === 'sched') return makeJob(uid, st, now() + Number(data.slice(3)) * 60);
  if (data.startsWith('r:') && active(st) && cur(s) === 'rules') {
    const v = data.slice(2);
    if (v === 'ok') {
      const rules = [...s.rsel].sort((a, b) => a - b).map((i) => RULES[i]).concat(s.rcustom);
      s.d.rules = rules.length ? rules : [RULES[0]];
      return done(uid, st);
    }
    if (v === 'rec') s.rsel = [...REC];
    else if (v === 'clr') {
      s.rsel = [];
      s.rcustom = [];
    } else {
      const i = Number(v);
      s.rsel = s.rsel.includes(i) ? s.rsel.filter((x) => x !== i) : [...s.rsel, i];
    }
    if (mid) await markup(uid, mid, await kbFor(uid, s, 'rules'));
    return;
  }
  if (data.startsWith('o:') && active(st)) {
    const [, key, v] = data.match(/^o:([^:]+):(.*)$/) || [];
    if (key !== cur(s)) return;
    if (v === 'n') {
      s.d[key] = null;
      return done(uid, st);
    }
    if (key === 'spons' && v === 'last') {
      s.d.spons = (await store.user(uid)).spons;
      return done(uid, st);
    }
    if (key === 'pbody' && v === 'ai') return aiBody(uid, st);
    const p = PRESETS[key]?.find((x) => x[0] === v);
    if (p) return storeAnswer(uid, st, key, p[2]);
  }
}

async function aiBody(uid, st) {
  const wait = await send(uid, '🪄 دارم می‌نویسم…');
  try {
    const body = await writePost(st.s.d.ptitle || '', st.s.d.pstyle);
    if (wait.ok) await call('deleteMessage', { chat_id: uid, message_id: wait.result.message_id });
    return storeAnswer(uid, st, 'pbody', body);
  } catch (e) {
    console.warn('ai body', e.message);
    if (wait.ok) await call('deleteMessage', { chat_id: uid, message_id: wait.result.message_id });
    return send(uid, '⚠️ هوش مصنوعی الان جواب نداد؛ متن رو خودت بفرست یا چند لحظه بعد دوباره بزن.');
  }
}
