// The Mini App edits audio in the browser (cut, fade, effects) and uploads the result here in
// base64 parts; on the last part the bot sends the file to the user.
// input: { token, idx, data, last?, meta?: { id, label, fmt: mp3|wav, voice? } }
import { api, InputFile, EndpointError } from 'sdk';
import * as store from '../lib/store.js';
import { fileName } from '../lib/deliver.js';
import { concatBytes, fromBase64 } from '../lib/util.js';
import { caller, trackOrFail } from '../lib/webapp.js';

const MAX_PARTS = 40;

export default async function (input, ctx) {
  const uid = await caller(ctx);
  const token = String(input?.token || '').slice(0, 40);
  const idx = Number(input?.idx);
  if (!token || !(idx >= 0 && idx < MAX_PARTS)) throw new EndpointError('آپلود نامعتبر', { code: 'BAD_UPLOAD' });
  await store.savePart(uid, token, idx, fromBase64(String(input.data || '')));
  if (!input.last) return { ok: true };

  const parts = await store.takeParts(uid, token);
  if (parts.length !== idx + 1) throw new EndpointError('بخشی از فایل نرسید؛ دوباره امتحان کن', { code: 'MISSING_PART' });
  const bytes = concatBytes(parts.map((p) => new Uint8Array(p.data)));
  const meta = input.meta || {};
  const t = await trackOrFail(meta.id);
  const label = String(meta.label || 'edit').slice(0, 40);
  const mp3 = meta.fmt !== 'wav';
  const file = new InputFile(bytes, fileName(t, mp3 ? 'mp3' : 'wav', ` (${label})`), { type: mp3 ? 'audio/mpeg' : 'audio/wav' });
  if (meta.voice) await api.sendVoice({ chat_id: uid, voice: file, caption: `✂️ ${label}` });
  else await api.sendAudio({ chat_id: uid, audio: file, title: `${t.title} (${label})`, performer: t.artist || undefined });
  await store.log(uid, 'edit', label, t.id);
  return { ok: true };
}
