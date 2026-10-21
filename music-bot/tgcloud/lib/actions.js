// Chat flows shared by the message and callback handlers.
import { api, BotApiError } from 'sdk';
import * as store from './store.js';
import { search, remixes, fromUrl, linkMedia, downloadAudio } from './sources.js';
import { recognize, queryOf } from './recognize.js';
import { TooBig } from './deliver.js';
import { cardKeyboard, resultsKeyboard, trackName } from './ui.js';
import { esc, fmtTime } from './util.js';

export const send = (chatId, text, extra = {}) =>
  api.sendMessage({ chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });

export const edit = (msg, text, extra = {}) =>
  api.editMessageText({ chat_id: msg.chat.id, message_id: msg.message_id, text, parse_mode: 'HTML',
    link_preview_options: { is_disabled: true }, ...extra });

export async function quietDelete(msg) {
  try {
    await api.deleteMessage({ chat_id: msg.chat.id, message_id: msg.message_id });
  } catch (e) {
    if (!(e instanceof BotApiError)) throw e;
  }
}

/** Run a slow job behind a "please wait" note and turn failures into a friendly message. */
export async function withProgress(chatId, note, job) {
  const wait = await send(chatId, note);
  try {
    await job();
  } catch (e) {
    console.error(e);
    const text = e instanceof TooBig ? '⚠️ فایل از ۵۰ مگابایت بزرگ‌تره؛ کیفیت پایین‌تر رو انتخاب کن.'
      : `⚠️ نشد: ${esc(String(e.message || e).slice(0, 200))}`;
    await send(chatId, text);
  } finally {
    await quietDelete(wait);
  }
}

export async function showCard(chatId, userId, t) {
  await store.setState(userId, 'last', t.id);
  const liked = (await store.likedIds(userId)).has(t.id);
  const isLink = t.source !== 'youtube' && t.source !== 'soundcloud';
  const caption = `🎵 <b>${trackName(t)}</b>\n⏱ ${fmtTime(t.duration)} · ${esc(t.source)}\n<a href="${esc(t.url)}">لینک منبع</a>`;
  const reply_markup = await cardKeyboard(t.id, liked, isLink);
  if (t.thumb) {
    try {
      return await api.sendPhoto({ chat_id: chatId, photo: t.thumb, caption, parse_mode: 'HTML', reply_markup });
    } catch (e) {
      if (!(e instanceof BotApiError)) throw e;
    }
  }
  return send(chatId, caption, { reply_markup });
}

export async function doSearch(chatId, userId, query) {
  const status = await send(chatId, `🔎 دنبال «${esc(query)}» می‌گردم...`);
  const tracks = await store.upsertTracks(await search(query));
  await store.log(userId, 'search', query);
  if (!tracks.length) return edit(status, '😕 چیزی پیدا نشد. جور دیگه بنویس یا یه ویس از آهنگ بفرست.');
  return edit(status, `🎶 نتایج «${esc(query)}»:`, { reply_markup: await resultsKeyboard(tracks) });
}

export async function sendRemixes(chatId, userId, t) {
  const status = await send(chatId, `🔁 دنبال ریمیکس‌های ${trackName(t)} می‌گردم...`);
  const found = await store.upsertTracks(await remixes(t));
  await store.log(userId, 'search', `${t.title} remix`);
  if (!found.length) return edit(status, 'ریمیکسی پیدا نشد.');
  return edit(status, `🔁 ریمیکس‌ها و نسخه‌های دیگه‌ی ${trackName(t)}:`, { reply_markup: await resultsKeyboard(found, false) });
}

export async function openLink(chatId, userId, url) {
  const t = await store.upsertTrack(await fromUrl(url));
  await store.log(userId, 'open', url, t.id);
  return showCard(chatId, userId, t);
}

/** sample: { bytes, name, mime } */
export async function runRecognition(chatId, userId, sample, hum = false) {
  const status = await send(chatId, hum ? '🎤 دارم به صدات گوش می‌دم...' : '🎧 دارم گوش می‌دم...');
  const res = await recognize(sample, { hum });
  if (res.match) {
    const m = res.match;
    const tracks = await store.upsertTracks(await search(queryOf(m), 8));
    await store.log(userId, 'recognize', queryOf(m), tracks[0]?.id ?? null);
    return edit(status,
      `✅ پیدا شد! (${esc(m.engine)})\n\n🎵 <b>${esc(m.title)}</b>\n👤 ${esc(m.artist || '?')}` +
      (m.album ? `\n💿 ${esc(m.album)}` : '') + '\n\nنسخه‌ای که می‌خوای رو انتخاب کن 👇 (ریمیکس و کاور هم هست)',
      { reply_markup: await resultsKeyboard(tracks) });
  }
  if (res.transcript) {
    const q = res.lyricHits[0] ? queryOf(res.lyricHits[0]) : res.transcript;
    const tracks = await store.upsertTracks(await search(q, 8));
    await store.log(userId, 'recognize', res.transcript, tracks[0]?.id ?? null);
    const hits = res.lyricHits.map((h) => `• ${esc(queryOf(h))}`).join('\n');
    return edit(status,
      `📝 چیزی که شنیدم: «${esc(res.transcript.slice(0, 300))}»\n\n` +
      (hits ? `آهنگ‌هایی که این متن رو دارن:\n${hits}\n\n` : '') + 'نتایج 👇',
      tracks.length ? { reply_markup: await resultsKeyboard(tracks) } : {});
  }
  return edit(status, res.configured === false
    ? '⚠️ هنوز هیچ سرویس تشخیص آهنگی تنظیم نشده. ادمین باید با /set کلید AudD یا ACRCloud رو وارد کنه.'
    : '😕 نتونستم تشخیص بدم.\n• ۱۰ تا ۱۵ ثانیه صدای واضح بفرست\n• یا یه تیکه از متن آهنگ رو بنویس\n• یا تو مینی‌اپ دکمه «گوش بده» رو بزن');
}

/** "What song is in this video/link?" */
export async function recognizeTrack(chatId, userId, t) {
  const media = t.source === 'youtube' || t.source === 'soundcloud'
    ? await downloadAudio(t, '128')
    : await linkMedia(t.url);
  if (!media) return send(chatId, '⚠️ برای تشخیص آهنگ لینک‌های اینستا/تیک‌تاک، ادمین باید سرویس دانلود (cobalt_url) رو تنظیم کنه. فعلاً خود ویدیو رو اینجا بفرست.');
  return runRecognition(chatId, userId, { bytes: media.bytes.subarray(0, 4.5 * 1024 * 1024), name: `sample.${media.ext}`, mime: media.mime });
}
