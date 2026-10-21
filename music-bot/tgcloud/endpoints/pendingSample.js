// The voice/video the user just sent in the chat, so the Mini App can fingerprint it for Shazam.
// Only the caller's own last file is returned.
import { api, EndpointError } from 'sdk';
import * as store from '../lib/store.js';
import { toBase64 } from '../lib/util.js';
import { caller } from '../lib/webapp.js';

export default async function (input, ctx) {
  const uid = await caller(ctx);
  const saved = await store.getState(uid, 'recfile');
  if (!saved) throw new EndpointError('فایلی برای تشخیص نیست؛ اول تو چت ویس یا ویدیو بفرست', { code: 'NO_FILE' });
  const { fileId, mime } = JSON.parse(saved);
  const bytes = await api.getFileContent(fileId);
  return { mime, data: toBase64(bytes.subarray(0, 8 * 1024 * 1024)) };
}
