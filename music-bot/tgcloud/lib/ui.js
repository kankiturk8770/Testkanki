// Inline keyboards and texts of the chat bot.
import { getSetting } from './store.js';
import { esc, fmtTime } from './util.js';
import { AUDIO_QUALITIES, VIDEO_QUALITIES } from './sources.js';

const ICON = { youtube: '▶️', soundcloud: '☁️', radiojavan: '📻', saavn: '🎶' };

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

export async function resultsKeyboard(tracks, withApp = true) {
  const rows = tracks.slice(0, 10).map((t) => {
    const name = t.artist ? `${t.artist} - ${t.title}` : t.title;
    return [btn(`${ICON[t.source] || '🌐'} ${name.slice(0, 44)} · ${fmtTime(t.duration)}`, `t:${t.id}`)];
  });
  if (withApp) rows.push([await appButton('🎵 باز کردن در پلیر')]);
  return kb(rows);
}

// Every keyboard is one row; the rest lives behind "⋯" (callback mo:<tid>:<where>, back with bk:…).
// where = c (track card) | a (under a sent audio)

export async function cardKeyboard(tid, liked, isLink = false) {
  if (isLink) return kb([[btn('🔍 این چه آهنگیه؟', `rec:${tid}`), btn('🎧 صدا', `aq:${tid}:192`), btn('🎬 ویدیو', `v:${tid}`)]]);
  return kb([[btn('🎧 دانلود آهنگ', `a:${tid}`), btn('🎬 ویدیو', `v:${tid}`), btn('⋯', `mo:${tid}:c`)]]);
}

/** Under every audio the bot sends: one "edit" button (the editor is in the Mini App) and "⋯". */
export async function editKeyboard(tid) {
  return kb([[await appButton('✂️ ویرایش / رینگتون / افکت', `?t=${tid}&edit=1`), btn('⋯', `mo:${tid}:a`)]]);
}

export async function moreKeyboard(tid, where, liked) {
  return kb([
    [btn('🔁 ریمیکس‌ها', `rx:${tid}`), btn(liked ? '❤️' : '🤍', `lk:${tid}:${where}`), btn('➕ پلی‌لیست', `pl:${tid}`)],
    [where === 'a' ? btn('🎬 ویدیو', `v:${tid}`) : btn('🎙 ویس', `vo:${tid}`), await appButton('🎵 پلیر', `?t=${tid}`), btn('🔙', `bk:${tid}:${where}`)],
  ]);
}

export function audioQualityKeyboard(tid) {
  return kb([[...AUDIO_QUALITIES.map((q) => btn(q, `aq:${tid}:${q}`)), btn('🎙 ویس', `vo:${tid}`)]]);
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
  `سلام ${esc(name)} 👋\n\n` +
  '🎵 <b>اسم آهنگ</b>، خواننده یا یه تیکه از متن رو بنویس تا از یوتیوب و ساندکلاد پیداش کنم.\n' +
  '🎙 <b>ویس</b> بفرست (آهنگی که پخش میشه، یا خودت بخون/زمزمه کن) تا بگم چه آهنگیه.\n' +
  '🎬 <b>ویدیو، ویدیو مسیج یا لینک</b> (اینستا، تیک‌تاک، یوتیوب…) بفرست تا آهنگش رو پیدا کنم.\n' +
  '✂️ زیر هر آهنگ: برش، رینگتون، اسلو، تند، باس، 8D و بی‌کلام.\n' +
  '💬 می‌تونی بنویسی «<i>آهنگشو بفرست</i>»، «<i>ویدیوشو بفرست</i>»، «<i>ریمیکساش</i>».\n\n' +
  '📱 پلیر، پلی‌لیست‌ها، تاریخچه و «گوش بده» تو <b>مینی‌اپ</b> هست.';

export const ADMIN_HELP =
  '⚙️ <b>تنظیمات (فقط ادمین)</b>\n' +
  '<code>/set webapp_url https://appXXXX.tgcloud.ai/</code> — آدرس مینی‌اپ (push چاپش می‌کنه)\n' +
  '<code>/set audd_token …</code> — تشخیص آهنگ (audd.io)\n' +
  '<code>/set acr_host identify-eu-west-1.acrcloud.com</code>\n' +
  '<code>/set acr_key …</code> و <code>/set acr_secret …</code> — ACRCloud\n' +
  '<code>/set acr_hum_key …</code> و <code>/set acr_hum_secret …</code> — تشخیص زمزمه\n' +
  '<code>/set stt_key …</code> — Groq/OpenAI Whisper (آواز ← متن)؛ اختیاری: <code>stt_url</code>، <code>stt_model</code>\n' +
  '<code>/set genius_token …</code> — پیدا کردن آهنگ از روی متن\n' +
  '<code>/set cobalt_url https://…</code> و <code>/set cobalt_key …</code> — سرویس دانلود (یوتیوب ۳۲۰، ویدیو ۷۲۰/۱۰۸۰، اینستا، تیک‌تاک)\n' +
  '<code>/unset نام</code> — پاک کردن · <code>/settings</code> — وضعیت\n' +
  '📦 کانال ذخیره: ربات رو ادمین یه کانال خصوصی کن و تو کانال بنویس <code>/storage</code>';
