// Getting a track's file into Telegram once, then reusing its file_id.
import { api, InputFile } from 'sdk';
import { cachedFile, cacheFile, anyCachedAudio, getSetting } from './store.js';
import { downloadAudio, downloadVideo, VIDEO_QUALITIES } from './sources.js';
import { songKeyboard } from './ui.js';

const UPLOAD_MAX = 50 * 1024 * 1024;

export class TooBig extends Error {}

function fileName(track, ext, suffix = '') {
  const base = [track.artist, track.title].filter(Boolean).join(' - ').replace(/[\\/:*?"<>|]/g, '').slice(0, 80);
  return `${base || 'track'}${suffix}.${ext}`;
}

/** Send the audio of a track to a chat; uses the cached file_id when there is one. */
export async function sendAudio(chatId, track, kbps = '192', { silent = false, markup = true, extra: buttons = [] } = {}) {
  const variant = `a${kbps}`;
  const extra = {
    chat_id: chatId,
    disable_notification: silent,
    ...(markup ? { reply_markup: await songKeyboard(track.id, buttons) } : {}),
  };
  const cached = await cachedFile(track.id, variant);
  if (cached) return api.sendAudio({ ...extra, audio: cached.fileId });
  const file = await downloadAudio(track, kbps);
  if (file.bytes.length > UPLOAD_MAX) throw new TooBig();
  const msg = await api.sendAudio({
    ...extra,
    audio: new InputFile(file.bytes, fileName(track, file.ext), { type: file.mime }),
    title: track.title,
    performer: track.artist || undefined,
    duration: track.duration || undefined,
    ...(file.alt ? { caption: `ℹ️ این نسخه در دسترس نبود؛ نزدیک‌ترین نسخه رو فرستادم:\n${[file.alt.artist, file.alt.title].filter(Boolean).join(' - ')}` } : {}),
  });
  const audio = msg.audio || msg.document;
  if (audio) await cacheFile(track.id, variant, audio.file_id, file.bytes.length);
  return msg;
}

export async function sendVideo(chatId, track, height = '720') {
  if (!VIDEO_QUALITIES.includes(height)) height = '720';
  const cached = await cachedFile(track.id, `v${height}`);
  if (cached) return api.sendVideo({ chat_id: chatId, video: cached.fileId, supports_streaming: true });
  const file = await downloadVideo(track, height);
  if (file.bytes.length > UPLOAD_MAX) throw new TooBig();
  const msg = await api.sendVideo({
    chat_id: chatId,
    video: new InputFile(file.bytes, fileName(track, 'mp4'), { type: 'video/mp4' }),
    caption: `🎬 ${[track.artist, track.title].filter(Boolean).join(' - ')} · ${file.height}p`,
    supports_streaming: true,
  });
  if (msg.video) await cacheFile(track.id, `v${file.height}`, msg.video.file_id, file.bytes.length);
  return msg;
}

/** Voice messages accept m4a/mp3 too, so the cached audio file is sent as is. */
export async function sendVoice(chatId, track) {
  const file = await audioBytes(track, chatId);
  return api.sendVoice({ chat_id: chatId, voice: new InputFile(file.bytes, 'voice.m4a', { type: 'audio/mp4' }),
    caption: `🎙 ${[track.artist, track.title].filter(Boolean).join(' - ')}` });
}

/**
 * Make sure Telegram has an audio file for the track (needed by the Mini App player and editor).
 * Uploaded to the storage channel (/storage) when set, otherwise to the user's own chat.
 */
export async function ensureAudio(track, userId) {
  const have = await anyCachedAudio(track.id);
  if (have) return have;
  const storage = await getSetting('storage_chat');
  await sendAudio(storage ? Number(storage) : userId, track, '192', { silent: true, markup: !storage });
  return anyCachedAudio(track.id);
}

/** Bytes of the track's audio (Bot API getFile limit: 20 MB). */
export async function audioBytes(track, userId) {
  const f = await ensureAudio(track, userId);
  // Telegram's file download fails now and then; one retry covers it
  const bytes = await api.getFileContent(f.fileId).catch(() => api.getFileContent(f.fileId));
  return { bytes, size: f.size };
}

export { fileName };
