// Inline button presses.
import { api, InputFile } from 'sdk';
import * as store from '../lib/store.js';
import { sendVideo, sendVoice } from '../lib/deliver.js';
import { send, sendRemixes, withProgress, deliverTrack } from '../lib/actions.js';
import { qualityKeyboard, videoQualityKeyboard, playlistPicker, songKeyboard, moreKeyboard, trackName } from '../lib/ui.js';
import { AUDIO_QUALITIES, linkInfo, linkVideo } from '../lib/sources.js';

async function setMarkup(cb, chatId, reply_markup) {
  try {
    await api.editMessageReplyMarkup({ chat_id: chatId, message_id: cb.message.message_id, reply_markup });
  } catch {}
}

// a late answer (slow job, old button) is harmless: never let it stop the action itself
const answer = (cb, text, alert = false) =>
  api.answerCallbackQuery({ callback_query_id: cb.id, ...(text ? { text, show_alert: alert } : {}) }).catch(() => {});

export default async function (cb) {
  const uid = cb.from.id;
  const chatId = cb.message?.chat.id ?? uid;
  const [op, a, b] = (cb.data || '').split(':');
  await store.touchUser(cb.from);

  const track = async (id) => {
    const t = await store.getTrack(id);
    if (!t) await answer(cb, 'این آهنگ پیدا نشد، دوباره جستجو کن.', true);
    return t;
  };

  switch (op) {
    case 't': { // a search result: send the song right away
      const t = await track(a);
      if (!t) return;
      await answer(cb);
      return deliverTrack(chatId, uid, t);
    }
    case 'mo': // "⋯" under a song
      await answer(cb);
      return setMarkup(cb, chatId, await moreKeyboard(Number(a), (await store.likedIds(uid)).has(Number(a))));
    case 'bk':
      await answer(cb);
      return setMarkup(cb, chatId, await songKeyboard(Number(a)));
    case 'q':
      await answer(cb);
      return setMarkup(cb, chatId, qualityKeyboard(Number(a)));
    case 'aq': {
      const t = await track(a);
      if (!t) return;
      await answer(cb);
      return deliverTrack(chatId, uid, t, AUDIO_QUALITIES.includes(b) ? b : '192');
    }
    case 'v': {
      const t = await track(a);
      if (!t) return;
      await answer(cb);
      return send(chatId, `🎬 ${trackName(t)}\nکیفیت ویدیو؟`, { reply_markup: videoQualityKeyboard(t.id) });
    }
    case 'vq': {
      const t = await track(a);
      if (!t) return;
      await answer(cb);
      await store.log(uid, 'download', `video ${b}`, t.id);
      return withProgress(chatId, `⏳ 🎬 ${trackName(t)} · ${b}p`, () => sendVideo(chatId, t, b));
    }
    case 'lv': { // video of an Instagram / TikTok post
      const t = await track(a);
      if (!t) return;
      await answer(cb);
      return withProgress(chatId, '⏳ 🎬', async () => {
        const bytes = await linkVideo(await linkInfo(t.url));
        await api.sendVideo({ chat_id: chatId, video: new InputFile(bytes, 'video.mp4', { type: 'video/mp4' }), supports_streaming: true });
      });
    }
    case 'vo': {
      const t = await track(a);
      if (!t) return;
      await answer(cb);
      await store.log(uid, 'download', 'voice', t.id);
      return withProgress(chatId, '⏳ 🎙', () => sendVoice(chatId, t));
    }
    case 'rx': {
      const t = await track(a);
      if (!t) return;
      await answer(cb);
      return sendRemixes(chatId, uid, t);
    }
    case 'lk': {
      const liked = await store.toggleLike(uid, Number(a));
      await answer(cb, liked ? '❤️ به علاقه‌مندی‌ها اضافه شد' : 'از علاقه‌مندی‌ها حذف شد');
      return setMarkup(cb, chatId, await moreKeyboard(Number(a), liked));
    }
    case 'pl':
      await answer(cb);
      return send(chatId, '📁 به کدوم پلی‌لیست اضافه بشه؟', { reply_markup: playlistPicker(Number(a), await store.playlists(uid)) });
    case 'pa':
      if (!(await store.ownsPlaylist(uid, a))) return answer(cb, 'پلی‌لیست پیدا نشد', true);
      await store.addToPlaylist(Number(a), Number(b));
      await answer(cb, '✅ اضافه شد');
      return api.deleteMessage({ chat_id: chatId, message_id: cb.message.message_id }).catch(() => {});
    case 'pn':
      await store.setState(uid, 'await', `plname:${a}`);
      await answer(cb);
      return send(chatId, '📝 اسم پلی‌لیست جدید رو بفرست:');
    case 'st': {
      if (String(uid) !== (await store.getSetting('admin_id'))) return answer(cb, 'فقط ادمین', true);
      await store.setSetting('storage_chat', a);
      await answer(cb, '✅ ذخیره شد');
      return send(chatId, '📦 کانال ذخیره تنظیم شد.');
    }
    default:
      return answer(cb);
  }
}
