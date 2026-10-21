// The player and editor get a track's audio in base64 parts (Telegram stores the file;
// the bot token never reaches the browser). input: { id, idx }
import { audioBytes } from '../lib/deliver.js';
import { toBase64 } from '../lib/util.js';
import { caller, trackOrFail, failure } from '../lib/webapp.js';

const CHUNK = 1536 * 1024;

export default async function (input, ctx) {
  const uid = await caller(ctx);
  const t = await trackOrFail(input?.id);
  const idx = Math.max(0, Number(input?.idx) || 0);
  try {
    const { bytes } = await audioBytes(t, uid);
    const total = Math.ceil(bytes.length / CHUNK);
    const isMp3 = bytes[0] === 0x49 || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0); // "ID3" or frame sync
    return {
      idx, total, size: bytes.length,
      mime: isMp3 ? 'audio/mpeg' : 'audio/mp4',
      data: toBase64(bytes.subarray(idx * CHUNK, (idx + 1) * CHUNK)),
    };
  } catch (e) {
    throw failure(e);
  }
}
