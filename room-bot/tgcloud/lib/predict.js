// Score predictions: the channel post's "⚽️ پیش‌بینی نتیجه" opens the bot (t.me/bot?start=pr_<gid>), the
// player sets the score with ➕/➖ and sends it once; after the match the owner enters the result and the
// first exact prediction wins.
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { esc, btn, call, send, now, digits } from './util.js';
import { localStr } from './store.js';
import { loadGv, predictOpen, refreshAny, drawGiveaway, pickMembers, isMember, shown, winnersLines, claimRow, footer } from './gv.js';

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
// the score in a popup: a line per team that starts with its name, so right-to-left text can't swap the numbers
// (an "a - b" line came out mixed up, and a line starting with an emoji was cut off)
const faNum = (n) => String(n).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);
const score = (g, a, b) => `${g.match.a}: ${faNum(a)}\n${g.match.b}: ${faNum(b)}`;

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
    return toast(`پیش‌بینیت ثبت شد ✅\n${score(g, cur.a, cur.b)}\nنتیجه بعد از بازی تو کانال اعلام میشه 🍀`, true);
  }
  const step = act.endsWith('+') ? 1 : act.endsWith('-') ? -1 : 0; // the team name itself just shows the score
  const a = act.startsWith('a') ? Math.min(MAX, Math.max(0, cur.a + step)) : cur.a;
  const b = act.startsWith('b') ? Math.min(MAX, Math.max(0, cur.b + step)) : cur.b;
  await db.run(sql`INSERT INTO pdrafts (gid, user_id, a, b) VALUES (${g.id}, ${uid}, ${a}, ${b})
    ON CONFLICT(gid, user_id) DO UPDATE SET a = excluded.a, b = excluded.b`);
  // a popup in the middle of the screen: the small toast shows at the very top, far from the post, and is missed
  return toast(`پیش‌بینی تو:\n${score(g, a, b)}\nآخرش «ثبت نتیجه» رو بزن ✅`, true);
}

// ---------- the result (owner) ----------
const resKb = (g, a, b) => [
  [btn('➕', `rp:${g.id}:${Math.min(MAX, a + 1)}:${b}`), btn(`${g.match.a}: ${a}`, 'noop'), btn('➖', `rp:${g.id}:${Math.max(0, a - 1)}:${b}`)],
  [btn('➕', `rp:${g.id}:${a}:${Math.min(MAX, b + 1)}`), btn(`${g.match.b}: ${b}`, 'noop'), btn('➖', `rp:${g.id}:${a}:${Math.max(0, b - 1)}`)],
  [btn(`✅ نتیجه: ${g.match.a} ${a} - ${b} ${g.match.b}`, `rk:${g.id}:${a}:${b}`)],
  [btn('🔙 برگشت', 'gvl')],
];

/** mr:<gid> and rp:… — the owner sets the final score with ➕/➖ (no typing, no "which number is which team"). */
export async function resultPicker(uid, gid, a = 0, b = 0, msgId = null) {
  const g = await loadGv(gid);
  if (!g || g.owner !== uid || !g.match || g.match.result) return send(uid, '⌛️ این بازی دیگه منتظر نتیجه نیست.');
  const text = `🏁 <b>نتیجه‌ی ${esc(g.match.a)} 🆚 ${esc(g.match.b)}</b>\n\n${esc(g.match.a)}  <b>${a}</b>  -  <b>${b}</b>  ${esc(g.match.b)}\n\n` +
    `با ➕/➖ گل‌های هر تیم رو بذار و «✅ نتیجه» رو بزن.\n👥 ${g.pcount} نفر پیش‌بینی کردن.`;
  if (msgId) return call('editMessageText', { chat_id: uid, message_id: msgId, text, parse_mode: 'HTML', reply_markup: { inline_keyboard: resKb(g, a, b) } });
  return send(uid, text, resKb(g, a, b));
}

/** rk:… asks once more, ry:… announces. */
export async function resultConfirm(uid, gid, a, b, msgId) {
  const g = await loadGv(gid);
  if (!g || g.owner !== uid || !g.match || g.match.result) return send(uid, '⌛️ این بازی دیگه منتظر نتیجه نیست.');
  return call('editMessageText', { chat_id: uid, message_id: msgId, parse_mode: 'HTML',
    text: `❓ <b>مطمئنی؟</b>\n\n${esc(g.match.a)}  <b>${a} - ${b}</b>  ${esc(g.match.b)}\n\nبا تأیید، نتیجه و برنده‌ها تو کانال اعلام میشن و دیگه برنمی‌گرده.`,
    reply_markup: { inline_keyboard: [[btn('✅ آره، اعلام کن', `ry:${gid}:${a}:${b}`)], [btn('🔙 نه، درستش کنم', `rp:${gid}:${a}:${b}`)]] } });
}

/** Typed result still works: "2-1" = first team 2, second team 1. */
export async function setResult(uid, gid, text) {
  const m = digits(text).match(/(\d{1,2})\s*[-:–]\s*(\d{1,2})/);
  if (!m) return send(uid, '⚠️ نتیجه رو اینجوری بفرست: <code>2-1</code> (اول گل‌های تیم اول)');
  return announceResult(uid, gid, Number(m[1]), Number(m[2]));
}

/**
 * The final score: the first exact prediction by someone still in the channel and the sponsors wins the
 * prediction prize; nobody exact = one more random winner in the draw. The draw happens now if it waited
 * for the result. One results post in the channel.
 */
export async function announceResult(uid, gid, x, y) {
  let g = await loadGv(gid);
  if (!g || g.owner !== uid || !g.match || g.match.result) return send(uid, '⌛️ این بازی دیگه منتظر نتیجه نیست.');
  // claim the result first: a double tap must not announce twice
  const raw = JSON.parse((await db.get(sql`SELECT data FROM giveaways WHERE id = ${g.id}`)).data);
  if (raw.match.result) return;
  raw.match.result = [x, y];
  const upd = (await db.run(sql`UPDATE giveaways SET data = ${JSON.stringify(raw)} WHERE id = ${g.id} AND data NOT LIKE ${'%"result":[%'} RETURNING id`)).rows[0];
  if (!upd) return;
  g.match = raw.match;

  let pred = null;
  for (const p of await db.all(sql`SELECT * FROM predictions WHERE gid = ${g.id} AND a = ${x} AND b = ${y} ORDER BY ts, id`)) {
    if (await isMember(g, p.user_id)) {
      pred = { id: p.user_id, name: p.name, un: p.un };
      break;
    }
  }
  const extra = pred ? 0 : 1;
  if (g.status === 'open') g = (await drawGiveaway(g.id, { extra, announce: false })) || g;
  else if (extra && g.status === 'done') {
    const have = new Set((g.winnersList || []).map((w) => w.id));
    const rest = (await db.all(sql`SELECT user_id AS id, name, un FROM entries WHERE gid = ${g.id} ORDER BY id`)).filter((p) => !have.has(p.id));
    g.winnersList = [...(g.winnersList || []), ...(await pickMembers(g, rest, 1))];
    await db.run(sql`UPDATE giveaways SET winners = ${JSON.stringify(g.winnersList)} WHERE id = ${g.id}`);
  }
  g.match = { ...raw.match, winner: pred };
  const cur = JSON.parse((await db.get(sql`SELECT data FROM giveaways WHERE id = ${g.id}`)).data);
  await db.run(sql`UPDATE giveaways SET data = ${JSON.stringify({ ...cur, match: g.match })} WHERE id = ${g.id}`);

  const predPrize = g.vpn?.pred?.label || 'جایزه‌ی پیش‌بینی';
  const drawPrize = g.vpn?.draw?.label || g.prize;
  const L = [`🏁 <b>نتیجه‌ی نهایی</b>`, '', `⚽️ ${esc(g.match.a)}  <b>${x} - ${y}</b>  ${esc(g.match.b)}`, ''];
  if (pred) L.push(`🥇 <b>برنده‌ی پیش‌بینی دقیق</b> (${esc(predPrize)}):`, `👤 ${shown(pred)}`, '');
  else L.push('😔 هیچ‌کس نتیجه رو دقیق پیش‌بینی نکرد؛', `🎁 جایزه‌ی پیش‌بینی به قرعه‌کشی اضافه شد و برنده‌ها <b>${(g.winnersList || []).length} نفر</b> شدن!`, '');
  if ((g.winnersList || []).length) L.push(`🎉 <b>برنده‌های قرعه‌کشی</b> (${esc(drawPrize)}):`, ...winnersLines(g), '');
  else L.push('😔 کسی تو قرعه‌کشی شرکت نکرده بود.', '');
  L.push('⚠️ جایزه فقط به کسایی می‌رسه که عضو کانال و اسپانسرها باشن.');
  const any = pred || (g.winnersList || []).length;
  if (any && g.vpn) L.push('👇 برنده‌ها جایزه‌شون رو از دکمه‌ی زیر بگیرن.');
  const text2 = L.join('\n') + (await footer());
  await call('sendMessage', { chat_id: g.chatId, text: text2, parse_mode: 'HTML', link_preview_options: { is_disabled: true },
    reply_parameters: { message_id: g.msgId, allow_sending_without_reply: true }, ...(any && g.vpn ? { reply_markup: { inline_keyboard: claimRow(g) } } : {}) });
  await refreshAny(g); // the post: result line, no more ➕/➖
  return send(uid, `✅ نتیجه و برنده‌ها تو کانال اعلام شد.\n\n${text2}`, [[btn('📋 قرعه‌کشی‌های من', 'gvl')], [btn('🏠 منو', 'menu')]]);
}
