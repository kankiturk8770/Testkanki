// The channel posts: room announcement, framed post, and sending them to the chosen channels.
import { esc, call, LINE } from './util.js';
import { STYLES } from './data.js';
import { user, bumpCount } from './store.js';
import { openGiveaway } from './gv.js';

export function build(d) {
  const L = ['✨🎮 <b>درود و خسته نباشید به همگی</b> 🎮✨', '',
    LINE, '🃏 <b>مشخصات روم امشب</b> 🃏', LINE, '',
    `🕗 <b>زمان شروع :</b>  ${esc(d.time)}`, '',
    `🎁 <b>جایزه :</b>  ${esc(d.prize)} 💸 به ${esc(d.winner)} 🏆`, '',
    `🗺 <b>مپ :</b>  ${esc(d.map)} 🔥`, '',
    `👥 <b>حالت روم :</b>  ${esc(d.mode)}`, '',
    LINE, '📜 <b>قوانین روم</b>', '', ...(d.rules || []).map(esc)];
  if (d.room) L.push('', LINE, '🔑 <b>اطلاعات روم</b>', '', `<code>${esc(d.room)}</code>`);
  if (d.desc) L.push('', LINE, '💬 <b>توضیحات</b>', '', esc(d.desc));
  L.push('', LINE, '📢 <b>شرط دریافت جایزه</b>', '', '😦 حتما برنده باید عضو چنل‌های زیر باشه ⬇️', '⭕️ در غیر اینصورت پرایز تعلق نمیگیره', '');
  L.push(...(d.spons || []).map((x) => '🚀 ' + x), '', '🔥 <b>موفق باشید</b> 🔥');
  return L.join('\n');
}

export function buildBeauty(d) {
  const [top, line, em] = STYLES[d.pstyle] || STYLES.gold;
  return [top, '', `${em} <b>${esc(d.ptitle)}</b> ${em}`, '', line, '', esc(d.pbody), '', line, '', top].join('\n');
}

// A photo caption holds 1024 characters: longer posts go as photo + message.
async function sendText(chat, text, photo, markup) {
  const rm = markup ? { reply_markup: { inline_keyboard: markup } } : {};
  if (photo) {
    if (text.length <= 1000) return call('sendPhoto', { chat_id: chat, photo, caption: text, parse_mode: 'HTML', ...rm });
    await call('sendPhoto', { chat_id: chat, photo });
  }
  return call('sendMessage', { chat_id: chat, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...rm });
}

export const sendPost = (chat, d) => sendText(chat, build(d), d.photo);
export const sendBeauty = (chat, d) => sendText(chat, buildBeauty(d), d.photo, d.pbtn ? [[{ text: d.pbtn.t, url: d.pbtn.u }]] : null);

/** Send to every target channel -> [report lines, how many succeeded] */
export async function deliver(uid, base, d, targets, pin) {
  const u = await user(uid);
  const titles = Object.fromEntries(u.channels.map((c) => [String(c.id), c.title]));
  const lines = [];
  let ok = 0;
  for (const t of targets) {
    const title = esc(titles[String(t)] || t);
    let good, err;
    if (base === 'gv') [good, err] = await openGiveaway(uid, t, d, pin);
    else {
      const r = await (base === 'post' ? sendBeauty : sendPost)(t, d);
      good = r.ok;
      err = r.description;
      if (good && pin) await call('pinChatMessage', { chat_id: t, message_id: r.result.message_id });
    }
    if (good) {
      ok++;
      lines.push('✅ ' + title);
    } else lines.push(`❌ ${title}\n↳ ${esc(err)}`);
  }
  if (ok) await bumpCount(uid);
  return [lines, ok];
}
