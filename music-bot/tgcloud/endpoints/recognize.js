// "Listen" button of the Mini App. input: { data: base64 recording, mime, hum }
import { EndpointError } from 'sdk';
import * as store from '../lib/store.js';
import { recognize, queryOf } from '../lib/recognize.js';
import { search } from '../lib/sources.js';
import { fromBase64 } from '../lib/util.js';
import { caller, outList } from '../lib/webapp.js';

export default async function (input, ctx) {
  const uid = await caller(ctx);
  const bytes = fromBase64(String(input?.data || ''));
  if (bytes.length < 1000) throw new EndpointError('صدایی ضبط نشد', { code: 'EMPTY' });
  const mime = String(input?.mime || 'audio/webm').split(';')[0];
  const res = await recognize({ bytes, mime, name: `rec.${mime.split('/')[1] || 'webm'}` }, { hum: !!input?.hum });
  const query = res.match ? queryOf(res.match) : res.lyricHits[0] ? queryOf(res.lyricHits[0]) : res.transcript;
  const tracks = query ? await store.upsertTracks(await search(query, 10)) : [];
  await store.log(uid, 'recognize', query || '-', tracks[0]?.id ?? null);
  return {
    match: res.match || null,
    transcript: res.transcript || null,
    lyricHits: res.lyricHits.map(queryOf),
    configured: res.configured !== false,
    tracks: await outList(tracks, uid),
  };
}
