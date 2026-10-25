// Score predictions: the channel post's "⚽️ پیش‌بینی نتیجه" opens the bot (t.me/bot?start=pr_<gid>), the
// player sets the score with ➕/➖ and sends it once; after the match the owner enters the result and the
// first exact prediction wins.
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { esc, btn, call, send, now, digits } from './util.js';
import { localStr } from './store.js';
import { loadGv, predictOpen, refreshAny } from './gv.js';

const MAX = 15;
const scoreKb = (g, a, b) => [
  [btn('➖', `pp:${g.id}:${Math.max(0, a - 1)}:${b}`), btn(`${g.match.a}: ${a}`, 'noop'), btn('➕', `pp:${g.id}:${Math.min(MAX, a + 1)}:${b}`)],
  [btn('➖', `pp:${g.id}:${a}:${Math.max(0, b - 1)}`), btn(`${g.match.b}: ${b}`, 'noop'), btn('➕', `pp:${g.id}:${a}:${Math.min(MAX, b + 1)}`)],
  [btn(`✅ ثبت نهایی: ${a} - ${b}`, `pc:${g.id}:${a}:${b}`)],
];
const scoreText = async (g, a, b) => `⚽️ <b>پیش‌بینی ${esc(g.match.a)} 🆚 ${esc(g.match.b)}</b>\n\n` +
  `${esc(g.match.a)}  <b>${a}</b>  -  <b>${b}</b>  ${esc(g.match.b)}\n\n` +
  'با ➕ و ➖ نتیجه رو تنظیم کن و «ثبت نهایی» رو بزن.\n⚠️ فقط یه بار میشه ثبت کرد و بعدش قابل تغییر نیست.' +
  (g.match.until ? `\n⏰ مهلت: ${await localStr(g.match.until)}` : '');

async function mine(gid, uid) {
  return db.get(sql`SELECT a, b FROM predictions WHERE gid = ${gid} AND user_id = ${uid}`);
}

/** Why this person can't predict now, or null. */
async function blocked(g, uid) {
  if (!g || !g.match) return '⛔️ این پیش‌بینی پیدا نشد.';
  if (!predictOpen(g)) return '⛔️ مهلت پیش‌بینی این بازی تموم شده.';
  const p = await mine(g.id, uid);
  if (p) return `✅ پیش‌بینیت قبلاً ثبت شده: ${esc(g.match.a)} <b>${p.a} - ${p.b}</b> ${esc(g.match.b)}\nقابل تغییر نیست. موفق باشی 🍀`;
  for (const sp of g.sponsors || []) {
    const r = await call('getChatMember', { chat_id: sp, user_id: uid });
    if (r.ok && ['left', 'kicked'].includes(r.result.status)) return `📢 اول باید عضو ${esc(sp)} بشی، بعد دوباره از پست دکمه‌ی پیش‌بینی رو بزن.`;
  }
  return null;
}

/** /start pr_<gid> */
export async function predictStart(uid, gid) {
  const g = await loadGv(gid);
  const why = await blocked(g, uid);
  if (why) return send(uid, why);
  return send(uid, await scoreText(g, 0, 0), scoreKb(g, 0, 0));
}

/** pp:<gid>:<a>:<b> (change the score) and pc:<gid>:<a>:<b> (send it). */
export async function predictCallback(c) {
  const [act, gid, a, b] = c.data.split(':');
  const uid = c.from.id;
  const msg = c.message;
  const g = await loadGv(gid);
  const why = await blocked(g, uid);
  if (why) return call('editMessageText', { chat_id: uid, message_id: msg.message_id, text: why, parse_mode: 'HTML' });
  const A = Math.min(MAX, Math.max(0, Number(a) || 0)), B = Math.min(MAX, Math.max(0, Number(b) || 0));
  if (act === 'pp') {
    return call('editMessageText', { chat_id: uid, message_id: msg.message_id, text: await scoreText(g, A, B), parse_mode: 'HTML', reply_markup: { inline_keyboard: scoreKb(g, A, B) } });
  }
  if (!(await record(g, c.from, A, B))) return call('editMessageText', { chat_id: uid, message_id: msg.message_id, text: await blocked(g, uid) || '✅ ثبت شده.', parse_mode: 'HTML' });
  return call('editMessageText', { chat_id: uid, message_id: msg.message_id, parse_mode: 'HTML',
    text: `✅ <b>پیش‌بینیت ثبت شد!</b>\n\n${esc(g.match.a)}  <b>${A} - ${B}</b>  ${esc(g.match.b)}\n\nبعد از بازی نتیجه تو کانال اعلام میشه. موفق باشی 🍀` });
}

/** Store one person's prediction (once) and update the count under the post. -> false if they already had one */
async function record(g, from, A, B) {
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ');
  const row = (await db.run(sql`INSERT INTO predictions (gid, user_id, name, un, a, b, ts) VALUES (${g.id}, ${from.id}, ${name}, ${from.username || null}, ${A}, ${B}, ${now()})
    ON CONFLICT(gid, user_id) DO NOTHING RETURNING id`)).rows[0];
  if (!row) return false;
  g.pcount = (g.pcount || 0) + 1;
  await refreshAny(g);
  return true;
}

/**
 * pq:<gid>:a+|a-|b+|b-|ok — the ➕/➖ under the channel post. The buttons are the same for everyone, so each
 * person's score lives in pdrafts and shows in the little popup; "ok" makes it final.
 */
export async function channelPredict(c) {
  const [, gid, act] = c.data.split(':');
  const uid = c.from.id;
  const toast = (text, alert = false) => call('answerCallbackQuery', { callback_query_id: c.id, text, show_alert: alert });
  if (c.from.is_bot) return toast('');
  const g = await loadGv(gid);
  const plain = (h) => h.replace(/<[^>]+>/g, '');
  const why = await blocked(g, uid);
  if (why) return toast(plain(why), true);
  const cur = (await db.get(sql`SELECT a, b FROM pdrafts WHERE gid = ${g.id} AND user_id = ${uid}`)) || { a: 0, b: 0 };
  if (act === 'ok') {
    if (!(await record(g, c.from, cur.a, cur.b))) return toast(plain((await blocked(g, uid)) || '✅ ثبت شده.'), true);
    await db.run(sql`DELETE FROM pdrafts WHERE gid = ${g.id} AND user_id = ${uid}`);
    return toast(`✅ پیش‌بینیت ثبت شد!\n\n${g.match.a}  ${cur.a} - ${cur.b}  ${g.match.b}\n\nقابل تغییر نیست. بعد از بازی نتیجه تو کانال اعلام میشه 🍀`, true);
  }
  const step = act.endsWith('+') ? 1 : act.endsWith('-') ? -1 : 0; // the team name itself just shows the score
  const a = act.startsWith('a') ? Math.min(MAX, Math.max(0, cur.a + step)) : cur.a;
  const b = act.startsWith('b') ? Math.min(MAX, Math.max(0, cur.b + step)) : cur.b;
  await db.run(sql`INSERT INTO pdrafts (gid, user_id, a, b) VALUES (${g.id}, ${uid}, ${a}, ${b})
    ON CONFLICT(gid, user_id) DO UPDATE SET a = excluded.a, b = excluded.b`);
  return toast(`پیش‌بینی تو:  ${g.match.a} ${a}  -  ${b} ${g.match.b}\n👈 آخرش «✅ ثبت نتیجه» رو بزن`);
}

const mention = (p) => `<a href="tg://user?id=${p.user_id}">${esc(p.name || 'کاربر')}</a>` + (p.un ? ` (@${esc(p.un)})` : '');

/** The owner typed the final score ("2-1") for giveaway gid. */
export async function setResult(uid, gid, text) {
  const m = digits(text).match(/(\d{1,2})\s*[-:–]\s*(\d{1,2})/);
  if (!m) return send(uid, '⚠️ نتیجه رو اینجوری بفرست: <code>2-1</code> (اول گل‌های تیم اول)');
  const g = await loadGv(gid);
  if (!g || g.owner !== uid || !g.match || g.match.result) return send(uid, '⌛️ این بازی دیگه منتظر نتیجه نیست.');
  const x = Number(m[1]), y = Number(m[2]);
  g.match.result = [x, y];
  const r = await db.get(sql`SELECT data FROM giveaways WHERE id = ${g.id}`);
  await db.run(sql`UPDATE giveaways SET data = ${JSON.stringify({ ...JSON.parse(r.data), match: g.match })} WHERE id = ${g.id}`);
  const right = await db.all(sql`SELECT * FROM predictions WHERE gid = ${g.id} AND a = ${x} AND b = ${y} ORDER BY ts, id`);
  const score = `${esc(g.match.a)} <b>${x} - ${y}</b> ${esc(g.match.b)}`;
  const text2 = right.length
    ? `🏁 <b>نتیجه‌ی بازی:</b> ${score}\n\n🥇 <b>اولین پیش‌بینی دقیق:</b> ${mention(right[0])}\n` +
      (right.length > 1 ? `\n✅ بقیه‌ی پیش‌بینی‌های دقیق (${right.length - 1}):\n${right.slice(1, 11).map(mention).join('\n')}${right.length > 11 ? '\n…' : ''}\n` : '') +
      `\n🎉 تبریک! برای دریافت جایزه به ادمین پیام بده.\n👥 کل پیش‌بینی‌ها: ${g.pcount}`
    : `🏁 <b>نتیجه‌ی بازی:</b> ${score}\n\n😔 هیچ‌کس نتیجه‌ی دقیق رو پیش‌بینی نکرد.\n👥 کل پیش‌بینی‌ها: ${g.pcount}`;
  await call('sendMessage', { chat_id: g.chatId, text: text2, parse_mode: 'HTML', link_preview_options: { is_disabled: true },
    reply_parameters: { message_id: g.msgId, allow_sending_without_reply: true } });
  await refreshAny(g); // result under the post, the predict button gone
  if (right[0]) await send(right[0].user_id, `🎉🥇 <b>تبریک!</b>\n\nتو اولین نفری بودی که نتیجه‌ی ${score} رو دقیق پیش‌بینی کردی!\nبرای دریافت جایزه به ادمین کانال پیام بده.`);
  return send(uid, `✅ نتیجه ثبت و تو کانال اعلام شد.\n\n${text2}`, [[btn('📋 قرعه‌کشی‌های من', 'gvl')], [btn('🏠 منو', 'menu')]]);
}
