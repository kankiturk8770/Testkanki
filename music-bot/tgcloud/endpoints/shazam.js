// Free recognition: the Mini App fingerprints the audio (shazamio-core) and sends the signature.
// input: { uri, samplems }
import { EndpointError } from 'sdk';
import * as store from '../lib/store.js';
import { shazamLookup } from '../lib/shazam.js';
import { queryOf } from '../lib/recognize.js';
import { search } from '../lib/sources.js';
import { caller, outList } from '../lib/webapp.js';

export default async function (input, ctx) {
  const uid = await caller(ctx);
  const uri = String(input?.uri || '');
  if (uri.length > 200000) throw new EndpointError('signature too large', { code: 'BAD_SIGNATURE' });
  let match;
  try {
    match = await shazamLookup(uri, Number(input?.samplems) || 12000);
  } catch (e) {
    console.warn(e.message);
    throw new EndpointError('Shazam در دسترس نیست؛ کمی بعد دوباره امتحان کن', { code: 'SHAZAM_DOWN' });
  }
  if (!match) return { match: null, tracks: [] };
  const tracks = await store.upsertTracks(await search(queryOf(match), 10));
  await store.log(uid, 'recognize', queryOf(match), tracks[0]?.id ?? null);
  return { match, tracks: await outList(tracks, uid) };
}
