// Prizes from the VPN bot: a winner taps "🎁 دریافت جایزه" under the results (t.me/<this bot>?start=cl_<gid>);
// if they really won and are still in the channel and the sponsors, they get a button that opens the VPN bot
// with a personal claim: t.me/<vpn bot>?start=c_<gid>_<n>_<user id>_<GB>_<days>_<tag>_<signature>.
// The signature is HMAC-SHA256 with a secret only the two bots know, so the claim can't be made up or changed;
// the VPN bot also checks that the Telegram account claiming is the one in it, and gives each claim once.
import { esc, btn, send } from './util.js';
import { getSetting } from './store.js';
import { loadGv, isMember } from './gv.js';

const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');

export async function sign(secret, payload) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode('kgw1:' + payload))).slice(0, 20);
}

/** The start parameter for the VPN bot (≤ 64 characters, letters, digits and _). */
export async function claimParam(secret, { gid, n, uid, gb, days, tag }) {
  const t = String(tag).replace(/[^A-Za-z0-9]/g, '').slice(0, 10) || 'Giveaway';
  const payload = `${gid}.${n}.${uid}.${gb}.${days}.${t}`;
  const param = `c_${gid}_${n}_${uid}_${gb}_${days}_${t}_${await sign(secret, payload)}`;
  if (param.length > 64) throw new Error('claim too long');
  return param;
}

/** /start cl_<gid> */
export async function claimStart(uid, gid) {
  const g = await loadGv(gid);
  if (!g) return send(uid, '⛔️ این قرعه‌کشی پیدا نشد.');
  // which prize: 0 = the exact prediction, 1… = the draw winners in order
  let n = -1, prize = null;
  if (g.match?.winner?.id === uid) {
    n = 0;
    prize = g.vpn?.pred;
  } else {
    const i = (g.winnersList || []).findIndex((w) => w.id === uid);
    if (i >= 0) {
      n = i + 1;
      prize = g.vpn?.draw;
    }
  }
  if (n < 0) return send(uid, '🙂 تو جزو برنده‌های این قرعه‌کشی نیستی.\nدفعه‌ی بعد شانست رو امتحان کن 🍀');
  if (!g.vpn || !prize) return send(uid, '🎉 تو برنده شدی! برای دریافت جایزه به ادمین کانال پیام بده.');
  if (!(await isMember(g, uid))) return send(uid, '⚠️ برای گرفتن جایزه باید عضو کانال و همه‌ی اسپانسرها باشی.\nعضو شو و دوباره دکمه‌ی «دریافت جایزه» رو بزن.');
  const secret = await getSetting('claim_secret');
  if (!secret) return send(uid, '⏳ تحویل جایزه هنوز آماده نیست؛ چند دقیقه دیگه دوباره امتحان کن.');
  const vpnBot = (await getSetting('vpn_bot')) || 'Kankivpn_bot';
  const param = await claimParam(secret, { gid: g.id, n, uid, gb: prize.gb, days: prize.days, tag: g.vpn.tag });
  return send(uid, `🎉🏆 <b>تبریک، برنده شدی!</b>\n\n🎁 جایزه‌ت: <b>${esc(prize.label || `${prize.gb} گیگ`)}</b>\n\n` +
    '👇 دکمه رو بزن؛ ربات VPN باز میشه و اشتراکت رو به اسم خودت تحویل میده.\n⚠️ این دکمه فقط برای حساب خودت کار می‌کنه و فقط یه بار.',
  [[{ text: '🎁 دریافت اشتراک', url: `https://t.me/${vpnBot}?start=${param}`, style: 'success' }], [btn('🏠 منو', 'menu')]]);
}

