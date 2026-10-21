// Every incoming message: commands, links, voice/video for recognition, text intents and search.
import { api } from 'sdk';
import * as store from '../lib/store.js';
import { send, doSearch, openLink, runRecognition, sendRemixes } from '../lib/actions.js';
import { WELCOME, ADMIN_HELP, appButton, webappUrl, audioQualityKeyboard, videoQualityKeyboard, trackName } from '../lib/ui.js';
import { esc, parseRange } from '../lib/util.js';

const URL_RE = /https?:\/\/\S+/;

// Words meaning "send me the song / video of the last track" rather than a search query.
const FILLER = new Set('رو را لطفا لطفاً برام واسم برای من میخوام می‌خوام بده بفرست بفرستش دانلود کن همین اینو این همینو اونو please send me the it this'.split(' '));
const AUDIO_W = new Set(['آهنگ', 'آهنگش', 'آهنگشو', 'آهنگو', 'صدا', 'صداش', 'صداشو', 'موزیک', 'موزیکش', 'موزیکشو', 'mp3', 'audio', 'song', 'music']);
const VIDEO_W = new Set(['ویدیو', 'ویدیوش', 'ویدیوشو', 'ویدئو', 'ویدئوشو', 'کلیپ', 'کلیپش', 'کلیپشو', 'فیلم', 'فیلمش', 'فیلمشو', 'mp4', 'video', 'clip']);
const REMIX_W = new Set(['ریمیکس', 'ریمیکسش', 'ریمیکساش', 'remix', 'remixes']);
const CUT_W = new Set(['برش', 'کات', 'cut', 'رینگتون']);

async function isAdmin(userId) {
  return String(userId) === (await store.getSetting('admin_id'));
}

async function adminCommand(msg, cmd, arg) {
  const uid = msg.from.id;
  if (cmd === '/admin') {
    const current = await store.getSetting('admin_id');
    if (!current) await store.setSetting('admin_id', String(uid));
    if (current && current !== String(uid)) return send(msg.chat.id, 'ادمین قبلاً تعیین شده.');
    return send(msg.chat.id, `✅ شما ادمین هستید.\n\n${ADMIN_HELP}`);
  }
  if (!(await isAdmin(uid))) return send(msg.chat.id, 'این دستور فقط برای ادمینه. (اولین نفری که /admin بزنه ادمین میشه)');
  if (cmd === '/set') {
    const [k, ...rest] = arg.split(/\s+/);
    if (!k || !rest.length) return send(msg.chat.id, ADMIN_HELP);
    await store.setSetting(k, rest.join(' '));
    // the message holds a secret: don't leave it in the chat
    try { await api.deleteMessage({ chat_id: msg.chat.id, message_id: msg.message_id }); } catch {}
    return send(msg.chat.id, `✅ <code>${esc(k)}</code> ذخیره شد.`);
  }
  if (cmd === '/unset') {
    await store.setSetting(arg.trim(), null);
    return send(msg.chat.id, `🗑 <code>${esc(arg.trim())}</code> پاک شد.`);
  }
  if (cmd === '/settings') {
    const rows = await store.allSettings();
    const hidden = /token|key|secret/;
    const lines = rows.map((r) => `• <code>${esc(r.k)}</code> = ${hidden.test(r.k) ? '••••' + esc(r.v.slice(-4)) : esc(r.v)}`);
    return send(msg.chat.id, `${lines.join('\n') || 'هنوز چیزی تنظیم نشده.'}\n\n${ADMIN_HELP}`);
  }
}

async function command(msg, uid) {
  const [head, ...rest] = msg.text.trim().split(' ');
  const cmd = head.split('@')[0].toLowerCase();
  const arg = rest.join(' ').trim();
  if (cmd === '/start') {
    const app = await appButton('📱 باز کردن مینی‌اپ');
    // the "🎵 پلیر" button next to the message box opens the Mini App
    await api.setChatMenuButton({ chat_id: msg.chat.id, menu_button: { type: 'web_app', text: '🎵 پلیر', web_app: { url: await webappUrl() } } }).catch(() => {});
    return send(msg.chat.id, WELCOME(msg.from.first_name), app ? { reply_markup: { inline_keyboard: [[app]] } } : {});
  }
  if (cmd === '/app') {
    const app = await appButton('باز کردن');
    return send(msg.chat.id, app ? '📱 مینی‌اپ:' : 'مینی‌اپ هنوز تنظیم نشده.', app ? { reply_markup: { inline_keyboard: [[app]] } } : {});
  }
  if (cmd === '/remix') return arg ? doSearch(msg.chat.id, uid, `${arg} remix`) : send(msg.chat.id, 'بنویس: /remix اسم آهنگ');
  if (cmd === '/history') {
    const rows = await store.history(uid, null, 15);
    if (!rows.length) return send(msg.chat.id, 'تاریخچه‌ات خالیه.');
    const lines = rows.map((r) => `• ${r.kind}: ${r.title ? trackName(r) : esc(r.query || '')}`);
    return send(msg.chat.id, `🕘 آخرین فعالیت‌ها:\n${lines.join('\n')}\n\nتاریخچه کامل تو مینی‌اپ 📱`);
  }
  if (['/admin', '/set', '/unset', '/settings'].includes(cmd)) return adminCommand(msg, cmd, arg);
  return send(msg.chat.id, 'دستور ناشناخته. /start رو بزن.');
}

async function lastTrack(uid) {
  const id = await store.getState(uid, 'last');
  return id ? store.getTrack(id) : null;
}

export default async function (msg) {
  if (!msg.from || msg.chat.type !== 'private') return;
  const uid = msg.from.id;
  const chatId = msg.chat.id;
  await store.touchUser(msg.from);

  // ---- media: what song is this? ----
  const media = msg.voice || msg.audio || msg.video || msg.video_note || msg.document;
  if (media) {
    const mime = media.mime_type || (msg.voice ? 'audio/ogg' : 'video/mp4');
    if (msg.document && !/^(audio|video)\//.test(mime)) return send(chatId, 'فقط فایل صوتی یا ویدیویی رو می‌تونم بررسی کنم.');
    if ((media.file_size || 0) > 20 * 1024 * 1024) return send(chatId, '⚠️ ربات فایل بیشتر از ۲۰ مگ رو نمی‌تونه بگیره؛ یه تیکه کوتاه‌تر بفرست.');
    const bytes = await api.getFileContent(media.file_id);
    const hum = /زمزمه|هامینگ|خوندم|hum/i.test(msg.caption || '');
    const ext = mime.split('/')[1]?.split(';')[0] || 'bin';
    return runRecognition(chatId, uid, { bytes, name: `sample.${ext}`, mime }, hum);
  }

  const text = (msg.text || '').trim();
  if (!text) return;
  if (text.startsWith('/')) return command(msg, uid);

  // ---- an answer the bot asked for ----
  const pending = await store.getState(uid, 'await');
  if (pending) {
    await store.setState(uid, 'await', null);
    const [kind, arg] = pending.split(':');
    if (kind === 'plname') {
      const pid = await store.createPlaylist(uid, text);
      await store.addToPlaylist(pid, Number(arg));
      return send(chatId, `📁 پلی‌لیست «${esc(text.slice(0, 64))}» ساخته شد و آهنگ بهش اضافه شد.`);
    }
  }

  const url = text.match(URL_RE);
  if (url) return openLink(chatId, uid, url[0]);

  // ---- intents about the last track ----
  const words = text.toLowerCase().match(/[\p{L}\p{N}‌]+/gu) || [];
  const rest = words.filter((w) => !FILLER.has(w) && !AUDIO_W.has(w) && !VIDEO_W.has(w) && !REMIX_W.has(w) && !CUT_W.has(w));
  const last = await lastTrack(uid);
  if (last && words.some((w) => CUT_W.has(w))) {
    const range = parseRange(text);
    const app = await appButton('✂️ باز کردن برش‌زن', `?t=${last.id}&edit=cut${range ? `&a=${range[0]}&b=${range[1]}` : ''}`);
    return send(chatId, `✂️ برش ${trackName(last)}${range ? ' (بازه انتخاب شد)' : ''}:`, app ? { reply_markup: { inline_keyboard: [[app]] } } : {});
  }
  if (last && !rest.length && words.length) {
    if (words.some((w) => VIDEO_W.has(w))) return send(chatId, `🎬 ${trackName(last)}\nکیفیت ویدیو؟`, { reply_markup: videoQualityKeyboard(last.id) });
    if (words.some((w) => REMIX_W.has(w))) return sendRemixes(chatId, uid, last);
    if (words.some((w) => AUDIO_W.has(w))) return send(chatId, `🎧 ${trackName(last)}\nکیفیت آهنگ؟`, { reply_markup: audioQualityKeyboard(last.id) });
  }
  let query = rest.length && rest.length < words.length ? rest.join(' ') : text;
  if (words.some((w) => REMIX_W.has(w)) && !/remix/i.test(query)) query += ' remix';
  return doSearch(chatId, uid, query);
}
