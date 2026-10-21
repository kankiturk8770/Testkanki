// The voice / video / link the user just sent in the chat, so the Mini App can run Shazam on it.
// Only the caller's own last file is returned, in 1 MB base64 parts (responses are capped at ~2 MB).
// input: { idx }
import { api, EndpointError } from 'sdk';
import * as store from '../lib/store.js';
import { linkInfo, linkSound } from '../lib/sources.js';
import { toBase64 } from '../lib/util.js';
import { caller } from '../lib/webapp.js';

const CHUNK = 1024 * 1024;
const MAX = 8 * 1024 * 1024; // the first minutes are plenty for recognition

export default async function (input, ctx) {
  const uid = await caller(ctx);
  const saved = await store.getState(uid, 'recfile');
  if (!saved) throw new EndpointError('اول تو چت ویس، ویدیو یا لینک بفرست', { code: 'NO_FILE' });
  const ref = JSON.parse(saved);
  let bytes, mime;
  if (ref.link) {
    ({ bytes, mime } = await linkSound(await linkInfo(ref.link)));
  } else {
    bytes = await api.getFileContent(ref.fileId);
    mime = ref.mime;
  }
  bytes = bytes.subarray(0, MAX);
  const idx = Math.max(0, Number(input?.idx) || 0);
  return { idx, total: Math.ceil(bytes.length / CHUNK), mime, data: toBase64(bytes.subarray(idx * CHUNK, (idx + 1) * CHUNK)) };
}
