// "Send to chat" from the player. input: { id, kind: audio|video|voice, quality }
import * as store from '../lib/store.js';
import { sendAudio, sendVideo, sendVoice } from '../lib/deliver.js';
import { AUDIO_QUALITIES } from '../lib/sources.js';
import { caller, trackOrFail, failure } from '../lib/webapp.js';

export default async function (input, ctx) {
  const uid = await caller(ctx);
  const t = await trackOrFail(input?.id);
  const kind = input?.kind || 'audio';
  const q = String(input?.quality || '');
  try {
    if (kind === 'video') await sendVideo(uid, t, q || '720');
    else if (kind === 'voice') await sendVoice(uid, t);
    else await sendAudio(uid, t, AUDIO_QUALITIES.includes(q) ? q : '192');
  } catch (e) {
    throw failure(e);
  }
  await store.log(uid, 'download', kind, t.id);
  return { ok: true };
}
