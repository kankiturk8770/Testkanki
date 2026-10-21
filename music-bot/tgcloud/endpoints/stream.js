// Instant playback: a direct URL of the song (or of the same song elsewhere) for the player.
// input: { id } -> { kind: 'file' | 'hls', url, alt? } or { kind: null } (then the player uses audioChunk)
import { streamInfo } from '../lib/sources.js';
import { caller, trackOrFail } from '../lib/webapp.js';

export default async function (input, ctx) {
  await caller(ctx);
  const t = await trackOrFail(input?.id);
  return (await streamInfo(t)) || { kind: null };
}
