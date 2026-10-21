import { search } from '../lib/sources.js';
import * as store from '../lib/store.js';
import { caller, outList } from '../lib/webapp.js';

export default async function (input, ctx) {
  const uid = await caller(ctx);
  const q = String(input?.q || '').trim().slice(0, 200);
  if (!q) return [];
  const tracks = await store.upsertTracks(await search(q, 20));
  await store.log(uid, 'search', q);
  return outList(tracks, uid);
}
