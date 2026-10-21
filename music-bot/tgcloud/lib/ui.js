// Inline keyboards and texts of the chat bot. Every keyboard is short: one main row, the rest behind "⋯".
import { getSetting } from './store.js';
import { esc, fmtTime } from './util.js';
import { AUDIO_QUALITIES, VIDEO_QUALITIES } from './sources.js';

export const btn = (text, data) => ({ text, callback_data: data });

// Address printed by `tgcloud push`; /set webapp_url overrides it.
export const DEFAULT_WEBAPP_URL = 'https://app8859705249.tgcloud.ai/';

export async function webappUrl() {
  return (await getSetting('webapp_url')) || DEFAULT_WEBAPP_URL;
}

/** Mini App button, or null when no Mini App address is known. */
export async function appButton(text, params = '') {
  const url = await webappUrl();
  return url ? { text, web_app: { url: url.replace(/\/?$/, '/') + params } } : null;
}

const kb = (rows) => ({ inline_keyboard: rows.map((r) => r.filter(Boolean)).filter((r) => r.length) });

export function trackName(t) {
  return esc(t.artist ? `${t.artist} - ${t.title}` : t.title);
}

/** Search results: one button per song; a tap sends the song. */
export async function resultsKeyboard(tracks) {
  const rows = tracks.slice(0, 8).map((t) => {
    const name = t.artist ? `${t.artist} - ${t.title}` : t.title;
    return [btn(`🎵 ${name.slice(0, 46)} · ${fmtTime(t.duration)}`, `t:${t.id}`)];
  });
  rows.push([await appButton('🎧 باز کردن در پلیر')]);
  return kb(rows);
}

/** Under every song the bot sends. where: a (audio message). */
export async function songKeyboard(tid) {
  return kb([[await appButton('✂️ برش', `?t=${tid}&edit=1`), btn('⋯', `mo:${tid}`)]]);
}

export async function moreKeyboard(tid, liked) {
  return kb([
    [btn('🎬 ویدیو', `v:${tid}`), btn('🔁 ریمیکس‌ها', `rx:${tid}`), btn('🎚 کیفیت', `q:${tid}`)],
    [btn('➕ پلی‌لیست', `pl:${tid}`), btn(liked ? '❤️' : '🤍', `lk:${tid}`), await appButton('🎧 پلیر', `?t=${tid}`), btn('🔙', `bk:${tid}`)],
  ]);
}

export function qualityKeyboard(tid) {
  return kb([[...AUDIO_QUALITIES.map((q) => btn(`${q}k`, `aq:${tid}:${q}`)), btn('🎙 ویس', `vo:${tid}`), btn('🔙', `mo:${tid}`)]]);
}

export function videoQualityKeyboard(tid) {
  return kb([VIDEO_QUALITIES.map((h) => btn(`${h}p`, `vq:${tid}:${h}`))]);
}

export function playlistPicker(tid, lists) {
  return kb([
    ...lists.slice(0, 10).map((p) => [btn(`📁 ${p.name} (${p.count})`, `pa:${p.id}:${tid}`)]),
    [btn('➕ پلی‌لیست جدید', `pn:${tid}`)],
  ]);
}

export const WELCOME = (name) =>
  `سلام ${esc(name)} 👋 به <b>Kanki Music</b> خوش اومدی 🎧\n\n` +
  '🔎 اسم آهنگ یا خواننده رو بنویس\n' +
  '📝 یا یه تیکه از متن آهنگ\n' +
  '🔗 یا لینک بفرست (اینستاگرام، تیک‌تاک، یوتیوب…)\n' +
  '🎙 یا ویس بفرست؛ آهنگی که پخش میشه یا خودت می‌خونی\n\n' +
  'خودم پیداش می‌کنم و برات می‌فرستم ✨';

export const ADMIN_HELP =
  '⚙️ <b>تنظیمات</b>\n' +
  '<code>/set audd_token …</code> — تشخیص آهنگ مستقیم تو چت (audd.io)\n' +
  '<code>/set acr_key …</code> + <code>/set acr_secret …</code> (+ <code>acr_host</code>) — ACRCloud\n' +
  '<code>/set acr_hum_key …</code> + <code>/set acr_hum_secret …</code> — تشخیص زمزمه\n' +
  '<code>/set stt_key …</code> — Groq Whisper (آواز ← متن)\n' +
  '<code>/set cobalt_url https://…</code> — دانلود ویدیوی یوتیوب\n' +
  '<code>/settings</code> — وضعیت · <code>/unset نام</code> — پاک کردن';
