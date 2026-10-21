// Inline button presses.
import { api } from 'sdk';
import * as store from '../lib/store.js';
import { sendAudio, sendVideo, sendVoice } from '../lib/deliver.js';
import { send, showCard, sendRemixes, withProgress, recognizeTrack } from '../lib/actions.js';
import { audioQualityKeyboard, videoQualityKeyboard, playlistPicker, cardKeyboard, editKeyboard, moreKeyboard, trackName } from '../lib/ui.js';
import { AUDIO_QUALITIES, MUSIC_SOURCES } from '../lib/sources.js';

async function setMarkup(cb, chatId, reply_markup) {
  try {
    await api.editMessageReplyMarkup({ chat_id: chatId, message_id: cb.message.message_id, reply_markup });
  } catch {}
}

const answer = (cb, text, alert = false) =>
  api.answerCallbackQuery({ callback_query_id: cb.id, ...(text ? { text, show_alert: alert } : {}) });

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
    case 't': {
      const t = await track(a);
      if (!t) return;
      await answer(cb);
      await store.log(uid, 'open', null, t.id);
      return showCard(chatId, uid, t);
    }
    case 'a': {
      const t = await track(a);
      if (!t) return;
      await answer(cb);
      return send(chatId, `🎧 ${trackName(t)}\nکیفیت آهنگ؟`, { reply_markup: audioQualityKeyboard(t.id) });
    }
    case 'v': {
      const t = await track(a);
      if (!t) return;
      await answer(cb);
      return send(chatId, `🎬 ${trackName(t)}\nکیفیت ویدیو؟`, { reply_markup: videoQualityKeyboard(t.id) });
    }
    case 'aq': {
      const t = await track(a);
      if (!t) return;
      const q = AUDIO_QUALITIES.includes(b) ? b : '192';
      await answer(cb, 'در حال دانلود...');
      await store.setState(uid, 'last', t.id);
      await store.log(uid, 'download', `audio ${q}`, t.id);
      return withProgress(chatId, `⏳ دانلود آهنگ (${q})...`, () => sendAudio(chatId, t, q));
    }
    case 'vq': {
      const t = await track(a);
      if (!t) return;
      await answer(cb, 'در حال دانلود...');
      await store.log(uid, 'download', `video ${b}`, t.id);
      return withProgress(chatId, `⏳ دانلود ویدیو ${b}p...`, () => sendVideo(chatId, t, b));
    }
    case 'vo': {
      const t = await track(a);
      if (!t) return;
      await answer(cb);
      await store.log(uid, 'download', 'voice', t.id);
      return withProgress(chatId, '⏳ ساخت ویس...', () => sendVoice(chatId, t));
    }
    case 'rx': {
      const t = await track(a);
      if (!t) return;
      await answer(cb);
      return sendRemixes(chatId, uid, t);
    }
    case 'rec': {
      const t = await track(a);
      if (!t) return;
      await answer(cb, 'دارم آهنگش رو تشخیص می‌دم...');
      return withProgress(chatId, '⏳ دریافت صدای ویدیو...', () => recognizeTrack(chatId, uid, t));
    }
    case 'lk': {
      const liked = await store.toggleLike(uid, Number(a));
      await answer(cb, liked ? '❤️ به علاقه‌مندی‌ها اضافه شد' : 'از علاقه‌مندی‌ها حذف شد');
      if (b) await setMarkup(cb, chatId, await moreKeyboard(Number(a), b, liked));
      return;
    }
    case 'mo': // "⋯": swap the row for the extra actions
      await answer(cb);
      return setMarkup(cb, chatId, await moreKeyboard(Number(a), b, (await store.likedIds(uid)).has(Number(a))));
    case 'bk':
      await answer(cb);
      if (b === 'a') return setMarkup(cb, chatId, await editKeyboard(Number(a)));
      return setMarkup(cb, chatId, await cardKeyboard(Number(a), false, !MUSIC_SOURCES.includes((await store.getTrack(a))?.source)));
    case 'pl':
      await answer(cb);
      return send(chatId, 'به کدوم پلی‌لیست اضافه بشه؟', { reply_markup: playlistPicker(Number(a), await store.playlists(uid)) });
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
