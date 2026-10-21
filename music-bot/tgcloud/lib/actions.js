// Chat flows shared by the message and callback handlers. The rule everywhere: when we know which
// song the user means, send the song itself; buttons are for "other versions", not for the next step.
import { api, BotApiError } from 'sdk';
import * as store from './store.js';
import { search, remixes, fromUrl, linkInfo, linkSound, bestMatches, youtubeId } from './sources.js';
import { shazamBytes } from './shazam.js';
import { recognize, queryOf } from './recognize.js';
import { sendAudio, TooBig } from './deliver.js';
import { resultsKeyboard, trackName, appButton, btn } from './ui.js';
import { esc } from './util.js';

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

export function friendly(e) {
  if (e instanceof TooBig) return '⚠️ فایل از ۵۰ مگابایت بزرگ‌تره؛ کیفیت پایین‌تر رو امتحان کن.';
  const m = String(e?.message || e);
  return /[؀-ۿ]/.test(m) ? `⚠️ ${esc(m)}` : '⚠️ دریافت این آهنگ نشد؛ یه نسخه‌ی دیگه رو امتحان کن.';
}

/** Run a slow job behind a "please wait" note and turn failures into a friendly message. */
export async function withProgress(chatId, note, job) {
  const wait = await send(chatId, note);
  try {
    await job();
  } catch (e) {
    console.error(e);
    await send(chatId, friendly(e));
  } finally {
    await quietDelete(wait);
  }
}

/** Download and send one track (the user picked it, or we found it). */
export async function deliverTrack(chatId, userId, t, kbps = '192') {
  await store.setState(userId, 'last', t.id);
  await store.log(userId, 'download', `audio ${kbps}`, t.id);
  return withProgress(chatId, `⏳ ${trackName(t)}`, () => sendAudio(chatId, t, kbps));
}

/**
 * We know the song's name (Shazam, Instagram music, …): find the best full version and send that one
 * song. extra: buttons added under it (e.g. the post's video).
 */
export async function sendSong(chatId, userId, want, { status = null, kind = 'recognize', extra = [] } = {}) {
  const label = esc(want.artist ? `${want.artist} - ${want.title}` : want.title);
  const note = `🎵 ${label}\n⏳`;
  status = status ? (await edit(status, note), status) : await send(chatId, note);
  let found = await bestMatches(want);
  if (!found.length) found = (await search(queryOf(want), 3)).slice(0, 1); // nothing close: the top result
  const rows = await store.upsertTracks(found);
  await store.log(userId, kind, queryOf(want), rows[0]?.id ?? null);
  for (let i = 0; i < Math.min(3, found.length); i++) {
    const t = { ...found[i], ...rows[i] }; // keep the source's direct media link from the search
    try {
      await store.setState(userId, 'last', t.id);
      await sendAudio(chatId, t, '192', { extra });
      return quietDelete(status);
    } catch (e) {
      console.warn('send failed', t.key, e.message);
    }
  }
  return edit(status, `🎵 ${label}\n😕 فایل این آهنگ رو پیدا نکردم.`);
}

export async function doSearch(chatId, userId, query) {
  const status = await send(chatId, `🔎 ${esc(query)}`);
  const tracks = await store.upsertTracks(await search(query));
  await store.log(userId, 'search', query);
  if (!tracks.length) return edit(status, '😕 چیزی پیدا نشد. جور دیگه بنویس یا یه ویس از آهنگ بفرست.');
  return edit(status, `🔎 <b>${esc(query)}</b>`, { reply_markup: await resultsKeyboard(tracks) });
}

export async function sendRemixes(chatId, userId, t) {
  const status = await send(chatId, `🔁 ${trackName(t)}`);
  const found = await store.upsertTracks(await remixes(t));
  await store.log(userId, 'search', `${t.title} remix`);
  if (!found.length) return edit(status, 'ریمیکسی پیدا نشد.');
  return edit(status, `🔁 ریمیکس‌ها و نسخه‌های دیگه‌ی <b>${trackName(t)}</b>:`, { reply_markup: await resultsKeyboard(found) });
}

/** "Artist - Title" -> { artist, title } */
function splitName(s) {
  const i = s.indexOf(' - ');
  return i > 0 ? { artist: s.slice(0, i).trim(), title: s.slice(i + 3).trim() } : { title: s.trim(), artist: null };
}

/** A pasted link: find the song in it and send it (with the post's video under it when there is one). */
export async function openLink(chatId, userId, url) {
  if (youtubeId(url) || /soundcloud\.com\//.test(url)) {
    const t = await store.upsertTrack(await fromUrl(url));
    await store.log(userId, 'open', url, t.id);
    return deliverTrack(chatId, userId, t);
  }
  const status = await send(chatId, '🔗 ⏳');
  const info = await linkInfo(url);
  if (!info) return edit(status, '⚠️ این لینک باز نشد. لینک اینستاگرام، تیک‌تاک، یوتیوب یا ساندکلاد بفرست.');
  const post = await store.upsertTrack({ key: `link:${info.kind}:${info.id}`, source: info.kind, url, title: info.title.slice(0, 120), thumb: info.thumb || null });
  await store.log(userId, 'open', url, post.id);
  const extra = info.video ? [btn('🎬 ویدیو', `lv:${post.id}`)] : [];
  // what is actually playing beats what the post says it uses
  let want = null;
  try {
    want = await shazamBytes((await linkSound(info)).bytes);
  } catch (e) {
    console.warn('link sound', e.message);
  }
  want ||= info.song || (info.hint && splitName(info.hint));
  if (want) return sendSong(chatId, userId, want, { status, extra });
  return edit(status, '😕 آهنگ این پست پیدا نشد.', extra.length ? { reply_markup: { inline_keyboard: [extra] } } : {});
}

/**
 * Voice / video / audio file: what song is this? Shazam runs right here; the paid engines (if the
 * admin set keys) are the second try and the only way for humming.
 */
export async function runRecognition(chatId, userId, sample, hum = false) {
  const status = await send(chatId, '🎧 ⏳');
  const s = typeof sample === 'function' ? await sample() : sample;
  const match = hum ? null : await shazamBytes(s.bytes);
  if (match) return sendSong(chatId, userId, match, { status });
  const configured = await store.getSetting('audd_token') || await store.getSetting('acr_key')
    || await store.getSetting('acr_hum_key') || await store.getSetting('stt_key');
  if (configured) {
    const res = await recognize(s, { hum });
    if (res.match) return sendSong(chatId, userId, res.match, { status });
    if (res.transcript) {
      const q = res.lyricHits[0] ? queryOf(res.lyricHits[0]) : res.transcript;
      const tracks = await store.upsertTracks(await search(q, 8));
      await store.log(userId, 'recognize', res.transcript, tracks[0]?.id ?? null);
      if (tracks.length) return edit(status, `📝 «${esc(res.transcript.slice(0, 200))}»`, { reply_markup: await resultsKeyboard(tracks) });
    }
  }
  return edit(status, '😕 پیدا نشد. صدای آهنگ باید واضح باشه؛ یه تیکه‌ی دیگه بفرست یا اسمش رو بنویس.');
}
