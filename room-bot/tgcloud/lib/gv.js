// Giveaways: a post with a join button in the channel, a random draw when it is full or time is up.
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { esc, btn, call, send, now, LINE } from './util.js';
import { localStr } from './store.js';

/** Session data -> the giveaway's settings. */
export function gvMake(d) {
  return {
    theme: d.theme, title: d.gtitle || '',
    prize: d.gprize || d.gprize_c || (d.glamt ? `${d.glamt} لایک ${d.glike}` : '-'),
    winners: Number(d.gwin), cap: Number(d.gcap), end: d.gend || 'full', sponsors: d.spons || [], desc: d.desc || null,
    photo: d.photo || null, text: d.gtext || null, btns: d.gbtns || [],
  };
}

export function calcEnd(spec) {
  if (spec.startsWith('d:')) return now() + Number(spec.slice(2)) * 60;
  if (spec.startsWith('at:')) {
    const ts = Number(spec.slice(3));
    return ts > now() ? ts : null;
  }
  return null;
}

const header = (g) => g.theme === 'uc' ? '🎁💰 <b>قرعه‌کشی ویژه UC</b> 💰🎁'
  : g.theme === 'chicken' ? '🍗❤️ <b>قرعه‌کشی لایک پابجی</b> ❤️🍗'
    : `🎉🎁 <b>${esc(g.title || 'قرعه‌کشی ویژه')}</b> 🎁🎉`;

async function whenTxt(g) {
  if (g.endsAt) return `⏰ ${await localStr(g.endsAt)} (یا زودتر با پر شدن ظرفیت)`;
  if (g.end.startsWith('d:')) return `⏱ ${Number(g.end.slice(2))} دقیقه بعد از ارسال (یا زودتر با پر شدن ظرفیت)`;
  return '✅ بلافاصله بعد از پر شدن ظرفیت';
}

function bar(n, cap) {
  const k = Math.floor((10 * Math.min(n, cap)) / Math.max(cap, 1));
  return '▰'.repeat(k) + '▱'.repeat(10 - k);
}

const mention = (p) => `<a href="tg://user?id=${p.id}">${esc(p.name || 'کاربر')}</a>` + (p.un ? ` (@${esc(p.un)})` : '');
const MEDALS = ['🥇', '🥈', '🥉'];
const winnersLines = (g) => (g.winnersList || []).map((p, i) => `${MEDALS[i] || '🏅'} ${mention(p)}`);

export async function buildGv(g) {
  const n = g.count;
  if (g.status === 'done') {
    const L = [header(g), '', LINE, '', `🎁 <b>جایزه :</b>  ${esc(g.prize)}`, ''];
    if (g.winnersList?.length) L.push('🏆 <b>برنده‌ها :</b>', '', ...winnersLines(g));
    else L.push('😔 هیچ‌کس شرکت نکرد.');
    L.push('', LINE, `🔒 <b>قرعه‌کشی پایان یافت</b>  ·  ${n} نفر شرکت کردن 🍀`);
    return L.join('\n');
  }
  if (g.status === 'cancel') return [header(g), '', LINE, '', '⛔️ <b>این قرعه‌کشی لغو شد.</b>'].join('\n');
  // the admin's own text: as written, with the live counter under it
  if (g.text) return `${esc(g.text)}\n\n📊 ${bar(n, g.cap)}  <b>${n}/${g.cap}</b>`;
  const L = [header(g), '', '🔥 <i>امروز قرعه‌کشی داریم! فقط با یه کلیک شرکت کن</i> 🔥', '', LINE, '',
    `🎁 <b>جایزه :</b>  ${esc(g.prize)}`, '',
    `🏆 <b>تعداد برنده :</b>  ${g.winners} نفر`, '',
    `👥 <b>ظرفیت :</b>  ${g.cap} نفر`, '',
    `⏰ <b>زمان قرعه‌کشی :</b>  ${await whenTxt(g)}`, '',
    `📊 ${bar(n, g.cap)}  <b>${n}/${g.cap}</b>`];
  if (g.desc) L.push('', '💬 ' + esc(g.desc));
  L.push('', LINE);
  if (g.sponsors.length) L.push('📢 <b>شرط شرکت</b>', '', '😦 حتما عضو کانال‌های زیر باشید ⬇️', ...g.sponsors.map((x) => '🚀 ' + x), '', LINE);
  L.push('👇 <b>برای شرکت، دکمه زیر رو بزن</b> 👇', '🍀 برنده‌ها کاملا شانسی توسط ربات انتخاب میشن');
  return L.join('\n');
}

// the admin's link buttons stay under the post, also after the draw
const linkRows = (g) => (g.btns || []).map((b) => [{ text: b.t, url: b.u }]);
export const gvKb = (g) => [[btn(`🎯 شرکت در قرعه‌کشی 🍀  (${g.count}/${g.cap})`, `gj:${g.id}`)], ...linkRows(g)];

/** Row + its entries -> the giveaway object used above. */
export async function loadGv(id) {
  const r = await db.get(sql`SELECT * FROM giveaways WHERE id = ${Number(id)}`);
  if (!r) return null;
  const count = (await db.get(sql`SELECT COUNT(*) AS n FROM entries WHERE gid = ${r.id}`)).n;
  return { ...JSON.parse(r.data), id: r.id, owner: r.owner, chatId: r.chat_id, msgId: r.msg_id, status: r.status,
    endsAt: r.ends_at, winnersList: r.winners ? JSON.parse(r.winners) : null, count };
}

// The post is a photo with the text as caption (asCaption), or a text message (with a photo above it, or none).
async function editPost(g, kb = null) {
  const rm = kb ? { reply_markup: { inline_keyboard: kb } } : {};
  if (g.asCaption) return call('editMessageCaption', { chat_id: g.chatId, message_id: g.msgId, caption: await buildGv(g), parse_mode: 'HTML', ...rm });
  return call('editMessageText', { chat_id: g.chatId, message_id: g.msgId, text: await buildGv(g), parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...rm });
}
const refreshPost = (g) => editPost(g, gvKb(g));

/** The giveaway post: photo first, the text under it, the join button under that (a caption holds 1024 characters). */
export async function sendGvPost(chatId, g) {
  const text = await buildGv(g);
  const kb = { reply_markup: { inline_keyboard: gvKb(g) } };
  if (g.photo && text.length <= 1024) {
    const r = await call('sendPhoto', { chat_id: chatId, photo: g.photo, caption: text, parse_mode: 'HTML', ...kb });
    return { ...r, asCaption: true };
  }
  if (g.photo) await call('sendPhoto', { chat_id: chatId, photo: g.photo });
  return call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...kb });
}

/** Post a new giveaway in a channel -> [ok, error] */
export async function openGiveaway(uid, chatId, d, pin) {
  const g = { ...gvMake(d), owner: uid, chatId, status: 'open', count: 0 };
  g.endsAt = calcEnd(g.end);
  const data = { theme: g.theme, title: g.title, prize: g.prize, winners: g.winners, cap: g.cap, end: g.end, sponsors: g.sponsors, desc: g.desc, photo: g.photo, text: g.text, btns: g.btns };
  const row = (await db.run(sql`INSERT INTO giveaways (owner, chat_id, data, status, ends_at, created)
    VALUES (${uid}, ${chatId}, ${JSON.stringify(data)}, 'open', ${g.endsAt}, ${now()}) RETURNING id`)).rows[0];
  g.id = row.id;
  const r = await sendGvPost(chatId, g);
  if (!r.ok) {
    await db.run(sql`DELETE FROM giveaways WHERE id = ${g.id}`);
    return [false, r.description];
  }
  if (r.asCaption) await db.run(sql`UPDATE giveaways SET data = ${JSON.stringify({ ...data, asCaption: true })} WHERE id = ${g.id}`);
  await db.run(sql`UPDATE giveaways SET msg_id = ${r.result.message_id} WHERE id = ${g.id}`);
  if (pin) await call('pinChatMessage', { chat_id: chatId, message_id: r.result.message_id });
  return [true, g.id];
}

function sample(list, k) {
  const a = [...list];
  const rnd = () => {
    try { return crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32; } catch { return Math.random(); }
  };
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, k);
}

export async function drawGiveaway(gid) {
  // only one caller wins the "open -> done" switch
  const won = (await db.run(sql`UPDATE giveaways SET status = 'done' WHERE id = ${Number(gid)} AND status = 'open' RETURNING id`)).rows[0];
  if (!won) return;
  const g = await loadGv(gid);
  const parts = (await db.all(sql`SELECT user_id AS id, name, un FROM entries WHERE gid = ${g.id} ORDER BY id`)).slice(0, g.cap);
  g.winnersList = sample(parts, Math.min(g.winners, parts.length));
  await db.run(sql`UPDATE giveaways SET winners = ${JSON.stringify(g.winnersList)} WHERE id = ${g.id}`);
  await editPost(g, linkRows(g).length ? linkRows(g) : null);
  const win = g.winnersList;
  const msg = win.length
    ? `🎊🏆 <b>نتیجه قرعه‌کشی</b> 🏆🎊\n\n🎁 <b>جایزه :</b>  ${esc(g.prize)}\n\n${winnersLines(g).join('\n')}\n\n` +
      '🎉 <b>تبریک به برنده‌ها!</b>\n📩 برای دریافت جایزه به ادمین پیام بدید.\n\n🍀 ممنون از همه‌ی شرکت‌کننده‌ها'
    : '😔 <b>قرعه‌کشی تموم شد ولی کسی شرکت نکرده بود.</b>';
  await call('sendMessage', { chat_id: g.chatId, text: msg, parse_mode: 'HTML', link_preview_options: { is_disabled: true },
    reply_parameters: { message_id: g.msgId, allow_sending_without_reply: true } });
  for (const p of win) await send(p.id, `🎉🏆 <b>تبریک!</b>\n\nتو برنده‌ی قرعه‌کشی «${esc(g.prize)}» شدی 🎁\nبرای دریافت جایزه به ادمین کانال پیام بده.`);
  await send(g.owner, `🎲 <b>قرعه‌کشی #${g.id} تموم شد</b>\n\n👥 شرکت‌کننده: ${g.count}\n🏆 برنده‌ها:\n${winnersLines(g).join('\n') || '—'}`, [[btn('🏠 منو', 'menu')]]);
}

export async function cancelGiveaway(g) {
  await db.run(sql`UPDATE giveaways SET status = 'cancel' WHERE id = ${g.id} AND status = 'open'`);
  g.status = 'cancel';
  await editPost(g, linkRows(g).length ? linkRows(g) : null);
}

/** The join button in the channel. */
export async function gvJoin(c) {
  const uid = c.from.id;
  const ans = (text) => call('answerCallbackQuery', { callback_query_id: c.id, text, show_alert: true });
  const g = await loadGv(c.data.slice(3));
  if (!g || g.status !== 'open') return ans('⛔️ این قرعه‌کشی پایان یافته.');
  if (c.from.is_bot) return ans('');
  for (const sp of g.sponsors) {
    const r = await call('getChatMember', { chat_id: sp, user_id: uid });
    if (r.ok && ['left', 'kicked'].includes(r.result.status)) return ans(`📢 اول باید عضو ${sp} بشی، بعد دوباره دکمه رو بزن.`);
  }
  if (await db.get(sql`SELECT id FROM entries WHERE gid = ${g.id} AND user_id = ${uid}`)) return ans('✅ قبلا ثبت‌نام کردی! منتظر نتیجه باش 🍀');
  if (g.count >= g.cap) return ans('⛔️ ظرفیت پر شده یا قرعه‌کشی تموم شده.');
  const name = [c.from.first_name, c.from.last_name].filter(Boolean).join(' ');
  const row = (await db.run(sql`INSERT INTO entries (gid, user_id, name, un) VALUES (${g.id}, ${uid}, ${name}, ${c.from.username || null})
    ON CONFLICT(gid, user_id) DO NOTHING RETURNING id`)).rows[0];
  if (!row) return ans('✅ قبلا ثبت‌نام کردی! منتظر نتیجه باش 🍀');
  // two people tapping the last seat at once: the later one is out
  const rank = (await db.get(sql`SELECT COUNT(*) AS n FROM entries WHERE gid = ${g.id} AND id <= ${row.id}`)).n;
  if (rank > g.cap) {
    await db.run(sql`DELETE FROM entries WHERE id = ${row.id}`);
    return ans('⛔️ ظرفیت پر شده یا قرعه‌کشی تموم شده.');
  }
  await ans('🎉 ثبت‌نامت انجام شد!\nموفق باشی 🍀');
  if (rank >= g.cap) return drawGiveaway(g.id);
  g.count = (await db.get(sql`SELECT COUNT(*) AS n FROM entries WHERE gid = ${g.id}`)).n;
  return refreshPost(g);
}

export async function showGvs(uid) {
  const rows = await db.all(sql`SELECT id FROM giveaways WHERE owner = ${uid} AND status = 'open' ORDER BY id`);
  if (!rows.length) return send(uid, '📋 قرعه‌کشی بازی نداری.', [[btn('🎁 قرعه‌کشی جدید', 'gv')], [btn('🏠 منو', 'menu')]]);
  const kb = [], lines = [];
  for (const { id } of rows) {
    const g = await loadGv(id);
    lines.push(`▫️ <b>#${g.id}</b> · ${esc(g.prize)} · 👥 ${g.count}/${g.cap}`);
    kb.push([btn(`🎲 تعیین برنده #${g.id}`, `gd:${g.id}`), btn(`⛔️ لغو #${g.id}`, `gx:${g.id}`)]);
  }
  kb.push([btn('🏠 منو', 'menu')]);
  return send(uid, '📋 <b>قرعه‌کشی‌های باز من</b>\n\n' + lines.join('\n'), kb);
}

export function gvMenu(uid) {
  return send(uid, '🎁 <b>قرعه‌کشی</b>\n\nیکی از قالب‌های آماده رو انتخاب کن 👇\n\n' +
    '⚡ <b>سریع:</b> فقط جایزه رو میگی، ۱ برنده بین ۵۰ نفر\n' +
    '❤️ <b>لایک:</b> موتور، گل، هواپیما، مرغ، ماشین (مثلا 2K لایک)\n' +
    '🛠 <b>کامل:</b> تعداد برنده، ظرفیت، زمان و اسپانسر رو خودت تنظیم می‌کنی\n' +
    '✨ <b>سفارشی:</b> هر قرعه‌کشی‌ای که خودت بخوای', [
    [btn('⚡ UC سریع (۱ نفر از ۵۰)', 'gvq:uc')],
    [btn('⚡ لایک سریع 🍗 (۱ نفر از ۵۰)', 'gvq:chicken')],
    [btn('💰 قرعه‌کشی UC', 'gvn:uc'), btn('🍗 قرعه‌کشی لایک', 'gvn:chicken')],
    [btn('✨ قرعه‌کشی سفارشی', 'gvn:custom')],
    [btn('📋 قرعه‌کشی‌های باز من', 'gvl')],
    [btn('🏠 منو', 'menu')]]);
}
